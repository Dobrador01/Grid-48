import type { CelescMunicipioPayload } from '@/types/celesc';
import { CELESC_TO_IBGE } from '../utils/celesc-to-ibge';

const STORAGE_KEY = 'grid48_celesc_histerese';

// ─── Utility functions ─────────────────────────────────────────────

/** Remove diacritics and uppercase a string for normalized comparison */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

/** Parses Celesc DD/MM/YYYY HH:mm date format to valid numeric milliseconds timestamp */
export function parseCelescTimestamp(dateStr: string): number {
  if (!dateStr) return Date.now();
  const parts = dateStr.split(/[\/\s:]/);
  if (parts.length >= 5) {
    const [day, month, year, hour, minute] = parts;
    const parsedDate = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
    return parsedDate.getTime();
  }
  // Fallback
  return new Date(dateStr).getTime() || Date.now();
}


/** Compute anti-hysteresis trend from readings buffer */
function computeTendencia(buffer: number[]): "ESTÁVEL" | "PIORANDO" | "MELHORANDO" {
  if (buffer.length < 3) return "ESTÁVEL";
  const mid = Math.floor(buffer.length / 2);
  const olderSlice = buffer.slice(0, mid);
  const newerSlice = buffer.slice(-mid);

  const olderAvg = olderSlice.reduce((a, b) => a + b, 0) / olderSlice.length;
  const newerAvg = newerSlice.reduce((a, b) => a + b, 0) / newerSlice.length;

  const delta = newerAvg - olderAvg;
  if (delta > 2) return "PIORANDO";
  if (delta < -2) return "MELHORANDO";
  return "ESTÁVEL";
}

/** 
 * JSONP Script injector to load global scripts completely bypassing CORS policies.
 * Waits for `onload` execution, retrieves the payload from the `window` global frame.
 */
function loadJSONP(url: string, globalVarName: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        
        script.onload = () => {
            const data = (window as any)[globalVarName];
            // Clean up to prevent DOM memory leaks
            script.remove();
            if (data !== undefined) {
                resolve(data);
            } else {
                reject(new Error(`Failed to extract global window.${globalVarName}`));
            }
        };

        script.onerror = () => {
            script.remove();
            reject(new Error(`JSONP script loading failed for ${url}`));
        };

        document.body.appendChild(script);
    });
}

// ─── Main Service Worker ───────────────────────────────────────────

export async function pollCelescData(): Promise<CelescMunicipioPayload[]> {
  console.log("[Celesc] Starting JSONP poll cycle...");

  let mapaData: any = null;
  let tabelasData: any = null;

  // Parallel JSONP injection
  try {
      [mapaData, tabelasData] = await Promise.all([
          loadJSONP("https://celgeoweb.celesc.com.br/json/mapa.js", "mapaIndicador"),
          loadJSONP("https://celgeoweb.celesc.com.br/json/tabelas.js", "visaoGeralPublico")
      ]);
  } catch (err) {
      console.error("[Celesc] Fatal JSONP Ingestion Error", err);
      return [];
  }

  // Parse Fetch A: mapa.js geometries overview
  const mapaMunicipios = new Map<string, { nomeLimpo: string; codIbge: string | null; totalUcsReal: number; ucsAfetadas: number }>();
  if (mapaData && Array.isArray(mapaData.municipios)) {
    for (const municipio of mapaData.municipios) {
      if (!municipio || !municipio.ds_informacao) continue; 
      
      const nameMatch = municipio.ds_informacao.match(/<th[^>]*>([^<]+)<\/th>/i);
      const nomeOriginal = nameMatch ? nameMatch[1].trim() : "DESCONHECIDO";

      const matchTotal = municipio.ds_informacao.match(/Total de unidades consumidoras\s*<\/td>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>/i);
      const totalUcsReal = matchTotal && matchTotal[1] ? parseInt(matchTotal[1].replace(/\./g, ''), 10) : 0;
      
      const boldMatches = [...municipio.ds_informacao.matchAll(/<b[^>]*>\s*([\d.,]+)\s*<\/b>/gi)];
      const ucsSemEnergia = boldMatches.length >= 2 ? parseInt(boldMatches[1]![1]!.replace(/[.,]/g, ""), 10) || 0 : 0;

      const nrCelesc = municipio.nr_municipio ? municipio.nr_municipio.toString() : '';
      const mapping = nrCelesc ? CELESC_TO_IBGE[nrCelesc] : null;

      mapaMunicipios.set(normalize(nomeOriginal), {
        nomeLimpo: mapping ? mapping.nome : nomeOriginal,
        codIbge: mapping ? mapping.ibge : null,
        totalUcsReal,
        ucsAfetadas: ucsSemEnergia,
      });
    }
  }

  // Parse Fetch B: tabelas.js cascade tables
  let timestampLeitura = "";
  const bairrosByMunicipio = new Map<string, Array<{ nome: string; ucsAfetadas: number }>>();

  if (tabelasData) {
    if (tabelasData.DATA) {
      timestampLeitura = String(tabelasData.DATA); // Ex: "21/03/2026 18:34"
    }

    const regionais = tabelasData.REGIONAIS;
    if (Array.isArray(regionais)) {
      for (const regional of regionais) {
        const cidades = regional.CIDADES;
        if (!Array.isArray(cidades)) continue;

        for (const cidade of cidades) {
          const cidadeNome = normalize(cidade.NOME || cidade.CIDADE || "");
          if (!cidadeNome) continue;

          const bairros = cidade.BAIRROS;
          if (!Array.isArray(bairros)) continue;

          const mappedBairros = (cidade.BAIRROS || []).map((b: any) => ({
            nome: b.BAIRRO,
            ucsAfetadas: parseInt(b.QUANTIDADE_TOTAL, 10) || 0
          }))
          .filter((b: any) => b.ucsAfetadas > 0)
          .sort((a: any, b: any) => b.ucsAfetadas - a.ucsAfetadas);

          if (mappedBairros.length > 0) {
            bairrosByMunicipio.set(cidadeNome, mappedBairros);
          }
        }
      }
    }
  }

  // LocalStorage Hysteresis Cache Load
  let history: Record<string, number[]> = {};
  try {
    const rawStorage = localStorage.getItem(STORAGE_KEY);
    if (rawStorage) history = JSON.parse(rawStorage);
  } catch (e) {
    console.warn("Cleared corrupted celesc hysteresis buffer from LocalStorage");
  }

  const payloads: CelescMunicipioPayload[] = [];

  for (const [nomeNorm, mapaInfo] of mapaMunicipios.entries()) {
    const { nomeLimpo, codIbge, totalUcsReal, ucsAfetadas } = mapaInfo;
    const bairros = bairrosByMunicipio.get(nomeNorm) || [];
    const pct = totalUcsReal > 0 ? (ucsAfetadas / totalUcsReal) * 100 : 0;

    let buffer = history[nomeNorm] || [];
    buffer.push(ucsAfetadas);
    if (buffer.length > 5) buffer.shift();
    history[nomeNorm] = buffer;

    const tendencia = computeTendencia(buffer);

    payloads.push({
      nome: nomeLimpo,
      codIbge: codIbge as string,
      totalUcsReal,
      ucsAfetadas,
      pct,
      tendencia,
      bairros,
      timestampLeitura,
    } as any);
  }

  // LocalStorage Hysteresis Cache Save
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch(e) { /* Ignore IO limits */ }

  return payloads;
}

export function initCelescPoller(onDataCallback: (payloads: CelescMunicipioPayload[]) => void): () => void {
  const executeCycle = async () => {
      const payloads = await pollCelescData();
      if (payloads.length > 0) {
          onDataCallback(payloads);
          window.dispatchEvent(new CustomEvent('CELESC_DATA_READY', { 
            detail: payloads 
          }));
      }
  };
  
  // Kickstart immediate ingestion
  executeCycle();
  
  // Setup 5 min infinite poller
  const intervalId = window.setInterval(executeCycle, 5 * 60 * 1000);
  
  // Expose destroy hook
  return () => clearInterval(intervalId);
}
