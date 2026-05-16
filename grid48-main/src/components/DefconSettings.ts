import { getOrCreateConvexClient } from '@/services/beacon-client';
import { escapeHtml } from '@/utils/sanitize';

// ═══════════════════════════════════════════════════════════════════════════
// DefconSettings — UI da configuração DEFCON dentro do UnifiedSettings
// ═══════════════════════════════════════════════════════════════════════════
//
// Padrão: factory function `renderDefconSettings()` retorna `{ html, attach }`
// — mesmo contrato do `renderPreferences()` em services/preferences-content.ts.
//
// Estado vive no Convex (defcon_config singleton). Esta UI:
//   - subscreve `defcon/config:getDefconConfig` (lê config atual)
//   - subscreve `celesc/queries:listBairrosConhecidos` (popula dropdown)
//   - dispara `defcon/config:updateDefconConfig` no Save
//
// Localidade-foco usa dropdown populado pela lista de bairros REALMENTE vistos
// no estado Celesc — evita typo silencioso.
// ═══════════════════════════════════════════════════════════════════════════

interface BairroConhecido {
  ibge_municipio: number;
  municipio_nome: string;
  bairro: string;
  ucs_afetadas_no_momento: number;
}

interface LocalidadeFoco {
  label: string;
  ibge_municipio: number;
  bairro_celesc: string;
}

interface DefconConfigDoc {
  localidades_foco: LocalidadeFoco[];
  municipios_secundarios: number[];
  grande_florianopolis: number[];
  threshold_bairro_ucs: number;
  nivel_bairro_critico: number;
  threshold_municipio_pct: number;
  nivel_municipio_alerta: number;
  nivel_alerta_alto_grande_floripa: number;
  _exists: boolean;
}

const NIVEL_OPTIONS = [
  { value: 1, label: '1 (Colapso)' },
  { value: 2, label: '2 (Crise)' },
  { value: 3, label: '3 (Ameaça)' },
  { value: 4, label: '4 (Alerta)' },
  { value: 5, label: '5 (Normal)' },
];

interface RenderResult {
  html: string;
  attach: (root: HTMLElement) => () => void;
}

export function renderDefconSettings(): RenderResult {
  const html = `
    <div class="defcon-settings" id="defconSettingsRoot">
      <div class="defcon-settings-header">
        <h3 style="margin: 0 0 4px 0; font-size: 1rem;">Configuração DEFCON</h3>
        <p style="margin: 0 0 16px 0; font-size: 0.78rem; color: #6b7280;">
          Ajuste os gatilhos sem precisar redeploy. Mudanças disparam recompute imediato.
        </p>
      </div>
      <div class="defcon-settings-status" id="defconSettingsStatus" style="font-size: 0.75rem; color: #6b7280; margin-bottom: 12px;">
        Carregando configuração…
      </div>
      <form id="defconSettingsForm" class="defcon-settings-form" style="display: none; gap: 18px; flex-direction: column;">

        <!-- Localidades-foco (regra 6.2) -->
        <fieldset style="border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; padding: 12px;">
          <legend style="font-size: 0.78rem; font-weight: 700; padding: 0 6px;">Localidades-foco (bairros casa/trabalho)</legend>
          <p style="font-size: 0.7rem; color: #6b7280; margin: 0 0 10px 0;">
            Bairros monitorados pela regra 6.2. Threshold absoluto de UCs sem luz aplicado a cada um.
          </p>
          <div id="localidadesList"></div>
          <button type="button" id="addLocalidadeBtn" style="margin-top: 6px; font-size: 0.72rem; padding: 4px 10px; cursor: pointer;">+ Adicionar localidade</button>
        </fieldset>

        <!-- Thresholds -->
        <fieldset style="border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; padding: 12px;">
          <legend style="font-size: 0.78rem; font-weight: 700; padding: 0 6px;">Thresholds e níveis-alvo</legend>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <label style="font-size: 0.72rem;">
              Threshold UCs no bairro foco (regra 6.2)
              <input type="number" id="thresholdBairroUcs" min="0" step="1" style="width: 100%; padding: 4px 6px; margin-top: 2px;">
            </label>
            <label style="font-size: 0.72rem;">
              DEFCON quando bate (regra 6.2)
              <select id="nivelBairroCritico" style="width: 100%; padding: 4px 6px; margin-top: 2px;"></select>
            </label>

            <label style="font-size: 0.72rem;">
              % UCs no município secundário (regra 6.3)
              <input type="number" id="thresholdMunicipioPct" min="0" max="100" step="1" style="width: 100%; padding: 4px 6px; margin-top: 2px;">
            </label>
            <label style="font-size: 0.72rem;">
              DEFCON quando bate (regra 6.3)
              <select id="nivelMunicipioAlerta" style="width: 100%; padding: 4px 6px; margin-top: 2px;"></select>
            </label>

            <label style="font-size: 0.72rem; grid-column: 1 / -1;">
              DEFCON quando alerta Alto cobre Grande Floripa (regra 6.1)
              <select id="nivelAlertaAltoGrandeFloripa" style="width: 100%; padding: 4px 6px; margin-top: 2px;"></select>
            </label>
          </div>
        </fieldset>

        <!-- Municípios secundários (regra 6.3) -->
        <fieldset style="border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; padding: 12px;">
          <legend style="font-size: 0.78rem; font-weight: 700; padding: 0 6px;">Municípios secundários (regra 6.3)</legend>
          <p style="font-size: 0.7rem; color: #6b7280; margin: 0 0 6px 0;">
            Códigos IBGE separados por vírgula. Default: São José, Florianópolis, Palhoça.
          </p>
          <input type="text" id="municipiosSecundarios" style="width: 100%; padding: 4px 6px; font-family: monospace; font-size: 0.72rem;">
        </fieldset>

        <!-- Grande Florianópolis (regra 6.1) -->
        <fieldset style="border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; padding: 12px;">
          <legend style="font-size: 0.78rem; font-weight: 700; padding: 0 6px;">Grande Florianópolis (regra 6.1)</legend>
          <p style="font-size: 0.7rem; color: #6b7280; margin: 0 0 6px 0;">
            IBGE dos municípios da região. Alerta Alto cobrindo qualquer um destes dispara a regra 6.1.
          </p>
          <input type="text" id="grandeFlorianopolis" style="width: 100%; padding: 4px 6px; font-family: monospace; font-size: 0.72rem;">
        </fieldset>

        <div style="display: flex; gap: 10px; align-items: center;">
          <button type="submit" id="defconSaveBtn" style="padding: 6px 16px; font-weight: 600; cursor: pointer;">Salvar</button>
          <span id="defconSaveStatus" style="font-size: 0.72rem; color: #6b7280;"></span>
        </div>
      </form>
    </div>
  `;

  const attach = (root: HTMLElement): (() => void) => {
    const client = getOrCreateConvexClient();
    const statusEl = root.querySelector<HTMLElement>('#defconSettingsStatus')!;
    const formEl = root.querySelector<HTMLFormElement>('#defconSettingsForm')!;
    const localidadesListEl = root.querySelector<HTMLElement>('#localidadesList')!;
    const addLocalidadeBtn = root.querySelector<HTMLButtonElement>('#addLocalidadeBtn')!;
    const thresholdBairroUcs = root.querySelector<HTMLInputElement>('#thresholdBairroUcs')!;
    const nivelBairroCritico = root.querySelector<HTMLSelectElement>('#nivelBairroCritico')!;
    const thresholdMunicipioPct = root.querySelector<HTMLInputElement>('#thresholdMunicipioPct')!;
    const nivelMunicipioAlerta = root.querySelector<HTMLSelectElement>('#nivelMunicipioAlerta')!;
    const nivelAlertaAltoGrandeFloripa = root.querySelector<HTMLSelectElement>('#nivelAlertaAltoGrandeFloripa')!;
    const municipiosSecundarios = root.querySelector<HTMLInputElement>('#municipiosSecundarios')!;
    const grandeFlorianopolis = root.querySelector<HTMLInputElement>('#grandeFlorianopolis')!;
    const saveBtn = root.querySelector<HTMLButtonElement>('#defconSaveBtn')!;
    const saveStatus = root.querySelector<HTMLElement>('#defconSaveStatus')!;

    // Popular dropdowns de nível
    for (const sel of [nivelBairroCritico, nivelMunicipioAlerta, nivelAlertaAltoGrandeFloripa]) {
      sel.innerHTML = NIVEL_OPTIONS.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('');
    }

    if (!client) {
      statusEl.textContent = 'Convex não configurado (VITE_CONVEX_URL ausente). Configuração indisponível.';
      return () => {};
    }

    // Estado local
    let bairrosConhecidos: BairroConhecido[] = [];
    let localidadesDraft: LocalidadeFoco[] = [];
    const c = client as any;

    // Subscribe na config
    const unsubConfig = c.onUpdate(
      "defcon/config:getDefconConfig",
      {},
      (data: DefconConfigDoc | null) => {
        if (!data) return;
        localidadesDraft = data.localidades_foco.map(l => ({ ...l }));
        thresholdBairroUcs.value = String(data.threshold_bairro_ucs);
        nivelBairroCritico.value = String(data.nivel_bairro_critico);
        thresholdMunicipioPct.value = String(data.threshold_municipio_pct);
        nivelMunicipioAlerta.value = String(data.nivel_municipio_alerta);
        nivelAlertaAltoGrandeFloripa.value = String(data.nivel_alerta_alto_grande_floripa);
        municipiosSecundarios.value = data.municipios_secundarios.join(', ');
        grandeFlorianopolis.value = data.grande_florianopolis.join(', ');
        statusEl.textContent = data._exists
          ? `Configuração carregada do Convex.`
          : `Usando defaults (singleton ainda não foi salvo). Salve para criar.`;
        formEl.style.display = 'flex';
        renderLocalidades();
      },
    );

    // Subscribe na lista de bairros
    const unsubBairros = c.onUpdate(
      "celesc/queries:listBairrosConhecidos",
      {},
      (data: BairroConhecido[] | null) => {
        bairrosConhecidos = data || [];
        renderLocalidades();
      },
    );

    function renderLocalidades() {
      if (localidadesDraft.length === 0) {
        localidadesListEl.innerHTML = `<div style="font-size: 0.72rem; color: #9ca3af; padding: 6px 0;">Nenhuma localidade cadastrada — regra 6.2 não vai disparar até você adicionar uma.</div>`;
        return;
      }
      localidadesListEl.innerHTML = localidadesDraft.map((loc, idx) => {
        // Dropdown de bairros conhecidos + opção "manual"
        const opcoes = bairrosConhecidos.map(b => {
          const selected = b.bairro === loc.bairro_celesc && b.ibge_municipio === loc.ibge_municipio ? 'selected' : '';
          return `<option value="${b.ibge_municipio}|${escapeHtml(b.bairro)}" ${selected}>${escapeHtml(b.municipio_nome)} → ${escapeHtml(b.bairro)} (${b.ucs_afetadas_no_momento} UCs agora)</option>`;
        }).join('');
        // Se a config tem um bairro que NÃO está na lista atual (ex: nenhum afetado agora), incluir como opção stale
        const incluiStale = loc.bairro_celesc && !bairrosConhecidos.some(b => b.bairro === loc.bairro_celesc && b.ibge_municipio === loc.ibge_municipio);
        const staleOption = incluiStale
          ? `<option value="${loc.ibge_municipio}|${escapeHtml(loc.bairro_celesc)}" selected>(IBGE ${loc.ibge_municipio}) → ${escapeHtml(loc.bairro_celesc)} — sem ocorrência agora</option>`
          : '';
        return `
          <div class="localidade-row" style="display: grid; grid-template-columns: 1fr 2fr auto; gap: 6px; margin-bottom: 6px;" data-idx="${idx}">
            <input type="text" class="loc-label" placeholder="Rótulo (ex: Casa)" value="${escapeHtml(loc.label)}" style="font-size: 0.72rem; padding: 4px 6px;">
            <select class="loc-bairro" style="font-size: 0.72rem; padding: 4px 6px;">
              <option value="">— escolha o bairro —</option>
              ${staleOption}
              ${opcoes}
            </select>
            <button type="button" class="loc-remove" title="Remover" style="font-size: 0.72rem; padding: 4px 8px; cursor: pointer;">✕</button>
          </div>
        `;
      }).join('');
    }

    // Event delegation pras localidades
    localidadesListEl.addEventListener('input', (e) => {
      const target = e.target as HTMLElement;
      const row = target.closest<HTMLElement>('.localidade-row');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      const loc = localidadesDraft[idx];
      if (!loc) return;
      if (target.classList.contains('loc-label')) {
        loc.label = (target as HTMLInputElement).value;
      }
    });
    localidadesListEl.addEventListener('change', (e) => {
      const target = e.target as HTMLElement;
      const row = target.closest<HTMLElement>('.localidade-row');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      const loc = localidadesDraft[idx];
      if (!loc) return;
      if (target.classList.contains('loc-bairro')) {
        const value = (target as HTMLSelectElement).value;
        const [ibgeStr, bairro] = value.split('|');
        const ibge = parseInt(ibgeStr || '0', 10);
        if (Number.isFinite(ibge) && bairro) {
          loc.ibge_municipio = ibge;
          loc.bairro_celesc = bairro;
        }
      }
    });
    localidadesListEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('loc-remove')) return;
      const row = target.closest<HTMLElement>('.localidade-row');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      localidadesDraft.splice(idx, 1);
      renderLocalidades();
    });

    addLocalidadeBtn.addEventListener('click', () => {
      localidadesDraft.push({ label: '', ibge_municipio: 0, bairro_celesc: '' });
      renderLocalidades();
    });

    // Submit
    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      saveStatus.textContent = 'Salvando…';
      saveStatus.style.color = '#6b7280';
      saveBtn.disabled = true;
      try {
        const payload = {
          localidades_foco: localidadesDraft.filter(l => l.label && l.bairro_celesc && l.ibge_municipio > 0),
          municipios_secundarios: parseIbgeList(municipiosSecundarios.value),
          grande_florianopolis: parseIbgeList(grandeFlorianopolis.value),
          threshold_bairro_ucs: Math.max(0, parseInt(thresholdBairroUcs.value, 10) || 0),
          nivel_bairro_critico: parseInt(nivelBairroCritico.value, 10),
          threshold_municipio_pct: Math.max(0, Math.min(100, parseInt(thresholdMunicipioPct.value, 10) || 0)),
          nivel_municipio_alerta: parseInt(nivelMunicipioAlerta.value, 10),
          nivel_alerta_alto_grande_floripa: parseInt(nivelAlertaAltoGrandeFloripa.value, 10),
        };
        await c.mutation("defcon/config:updateDefconConfig", payload);
        saveStatus.textContent = 'Salvo.';
        saveStatus.style.color = '#22c55e';
        setTimeout(() => { saveStatus.textContent = ''; }, 2000);
      } catch (err: any) {
        saveStatus.textContent = `Erro: ${err?.message ?? err}`;
        saveStatus.style.color = '#ef4444';
      } finally {
        saveBtn.disabled = false;
      }
    });

    return () => {
      try { unsubConfig?.(); } catch {}
      try { unsubBairros?.(); } catch {}
    };
  };

  return { html, attach };
}

function parseIbgeList(raw: string): number[] {
  return raw
    .split(/[,;\s]+/)
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0);
}
