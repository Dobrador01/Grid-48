import * as vm from 'node:vm';
import { db } from '../db';
import { configTable } from '../db/schema';
import { eq } from 'drizzle-orm';
import { CELESC_TO_IBGE } from './celesc-to-ibge';
import { engineEvents } from '../events';

const MAPA_URL = 'https://celgeoweb.celesc.com.br/json/mapa.js';
const TABELAS_URL = 'https://celgeoweb.celesc.com.br/json/tabelas.js';

const SNAPSHOT_KEY = 'celesc_snapshot';
const HYSTERESIS_KEY = 'celesc_hysteresis';

export interface CelescBairro {
  nome: string;
  ucsAfetadas: number;
}

export interface CelescMunicipioPayload {
  nome: string;
  codIbge?: string | null;
  totalUcsReal: number;
  ucsAfetadas: number;
  pct: number;
  tendencia: 'ESTÁVEL' | 'PIORANDO' | 'MELHORANDO';
  bairros: CelescBairro[];
  timestampLeitura: string;
}

interface CelescSnapshotEnvelope {
  timestamp: number;
  outages: CelescMunicipioPayload[];
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
}

function computeTendencia(buffer: number[]): CelescMunicipioPayload['tendencia'] {
  if (buffer.length < 3) return 'ESTÁVEL';
  const mid = Math.floor(buffer.length / 2);
  const olderAvg = buffer.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const newerAvg = buffer.slice(-mid).reduce((a, b) => a + b, 0) / mid;
  const delta = newerAvg - olderAvg;
  if (delta > 2) return 'PIORANDO';
  if (delta < -2) return 'MELHORANDO';
  return 'ESTÁVEL';
}

/**
 * Browser-side this is JSONP via <script> tag. In Node, we fetch the JS as text and
 * evaluate it in an isolated vm context, then read the named global.
 *
 * Why eval at all (vs. regex-extract): the upstream files are real JS — `var X = ...;`
 * with comments and possible IIFE wrappers. Eval is robust to format drift; regex isn't.
 */
async function loadJSONP(url: string, globalVarName: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const code = await res.text();
    const sandbox: Record<string, any> = {};
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { timeout: 5_000 });
    if (sandbox[globalVarName] === undefined) {
      throw new Error(`global ${globalVarName} not set after evaluating ${url}`);
    }
    return sandbox[globalVarName];
  } finally {
    clearTimeout(timer);
  }
}

async function loadHysteresis(): Promise<Record<string, number[]>> {
  const row = await db.select().from(configTable).where(eq(configTable.key, HYSTERESIS_KEY));
  if (row.length === 0) return {};
  try {
    return JSON.parse(row[0]!.value) as Record<string, number[]>;
  } catch {
    return {};
  }
}

async function saveHysteresis(history: Record<string, number[]>): Promise<void> {
  const json = JSON.stringify(history);
  const existing = await db.select().from(configTable).where(eq(configTable.key, HYSTERESIS_KEY));
  if (existing.length > 0) {
    await db.update(configTable).set({ value: json }).where(eq(configTable.key, HYSTERESIS_KEY));
  } else {
    await db.insert(configTable).values({ key: HYSTERESIS_KEY, value: json });
  }
}

async function saveSnapshot(envelope: CelescSnapshotEnvelope): Promise<void> {
  const json = JSON.stringify(envelope);
  const existing = await db.select().from(configTable).where(eq(configTable.key, SNAPSHOT_KEY));
  if (existing.length > 0) {
    await db.update(configTable).set({ value: json }).where(eq(configTable.key, SNAPSHOT_KEY));
  } else {
    await db.insert(configTable).values({ key: SNAPSHOT_KEY, value: json });
  }
}

export async function scrapeCelesc(): Promise<void> {
  console.log('[CELESC] Starting scrape cycle...');
  let mapaData: any;
  let tabelasData: any;

  try {
    [mapaData, tabelasData] = await Promise.all([
      loadJSONP(MAPA_URL, 'mapaIndicador'),
      loadJSONP(TABELAS_URL, 'visaoGeralPublico'),
    ]);
  } catch (err) {
    console.warn('[CELESC] Fetch failed — keeping last valid snapshot.', (err as Error).message);
    return;
  }

  // Parse mapa.js: per-municipality totals embedded in HTML inside ds_informacao.
  const mapaMunicipios = new Map<string, {
    nomeLimpo: string;
    codIbge: string | null;
    totalUcsReal: number;
    ucsAfetadas: number;
  }>();

  if (mapaData && Array.isArray(mapaData.municipios)) {
    for (const m of mapaData.municipios) {
      if (!m || !m.ds_informacao) continue;

      const nameMatch = m.ds_informacao.match(/<th[^>]*>([^<]+)<\/th>/i);
      const nomeOriginal = nameMatch ? nameMatch[1]!.trim() : 'DESCONHECIDO';

      const totalMatch = m.ds_informacao.match(
        /Total de unidades consumidoras\s*<\/td>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>/i
      );
      const totalUcsReal = totalMatch && totalMatch[1]
        ? parseInt(totalMatch[1].replace(/\./g, ''), 10)
        : 0;

      const boldMatches = [...m.ds_informacao.matchAll(/<b[^>]*>\s*([\d.,]+)\s*<\/b>/gi)] as RegExpMatchArray[];
      const ucsSemEnergia = boldMatches.length >= 2
        ? parseInt(boldMatches[1]![1]!.replace(/[.,]/g, ''), 10) || 0
        : 0;

      const nrCelesc = m.nr_municipio ? String(m.nr_municipio) : '';
      const mapping = nrCelesc ? CELESC_TO_IBGE[nrCelesc] : null;

      mapaMunicipios.set(normalize(nomeOriginal), {
        nomeLimpo: mapping ? mapping.nome : nomeOriginal,
        codIbge: mapping ? mapping.ibge : null,
        totalUcsReal,
        ucsAfetadas: ucsSemEnergia,
      });
    }
  }

  // Parse tabelas.js: bairro-level breakdown + global timestamp.
  let timestampLeitura = '';
  const bairrosByMunicipio = new Map<string, CelescBairro[]>();

  if (tabelasData) {
    if (tabelasData.DATA) timestampLeitura = String(tabelasData.DATA);

    const regionais = tabelasData.REGIONAIS;
    if (Array.isArray(regionais)) {
      for (const regional of regionais) {
        const cidades = regional.CIDADES;
        if (!Array.isArray(cidades)) continue;

        for (const cidade of cidades) {
          const cidadeNome = normalize(cidade.NOME || cidade.CIDADE || '');
          if (!cidadeNome || !Array.isArray(cidade.BAIRROS)) continue;

          const mapped = cidade.BAIRROS
            .map((b: any) => ({
              nome: b.BAIRRO,
              ucsAfetadas: parseInt(b.QUANTIDADE_TOTAL, 10) || 0,
            }))
            .filter((b: CelescBairro) => b.ucsAfetadas > 0)
            .sort((a: CelescBairro, b: CelescBairro) => b.ucsAfetadas - a.ucsAfetadas);

          if (mapped.length > 0) bairrosByMunicipio.set(cidadeNome, mapped);
        }
      }
    }
  }

  // Hysteresis: rolling buffer of last 5 readings per municipality, persisted in configTable.
  const history = await loadHysteresis();
  const outages: CelescMunicipioPayload[] = [];

  for (const [nomeNorm, info] of mapaMunicipios.entries()) {
    const { nomeLimpo, codIbge, totalUcsReal, ucsAfetadas } = info;
    const bairros = bairrosByMunicipio.get(nomeNorm) || [];
    const pct = totalUcsReal > 0 ? (ucsAfetadas / totalUcsReal) * 100 : 0;

    const buffer = history[nomeNorm] || [];
    buffer.push(ucsAfetadas);
    if (buffer.length > 5) buffer.shift();
    history[nomeNorm] = buffer;

    outages.push({
      nome: nomeLimpo,
      codIbge,
      totalUcsReal,
      ucsAfetadas,
      pct,
      tendencia: computeTendencia(buffer),
      bairros,
      timestampLeitura,
    });
  }

  await saveHysteresis(history);
  const envelope: CelescSnapshotEnvelope = { timestamp: Date.now(), outages };
  await saveSnapshot(envelope);
  engineEvents.emit('celesc-update', envelope);
  console.log(`[CELESC] Snapshot updated: ${outages.length} municipalities, leitura=${timestampLeitura}`);
}
