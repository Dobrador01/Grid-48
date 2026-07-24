import { getOrCreateConvexClient } from '@/services/beacon-client';
import { escapeHtml } from '@/utils/sanitize';

// ═══════════════════════════════════════════════════════════════════════════
// NotificacoesSettings — UI das notificações Telegram dentro do UnifiedSettings
// ═══════════════════════════════════════════════════════════════════════════
//
// Padrão factory `renderNotificacoesSettings()` → `{ html, attach }`, igual ao
// DefconSettings. Estado vive no Convex (notificacao_config singleton):
//   - subscreve `notificacoes/config:getConfig` (config normalizada)
//   - dispara `notificacoes/config:atualizarConfig` no Save (merge parcial)
//   - botão de teste → `notificacoes/config` action pública `enviarTeste`
//
// Campos fixos (sem mini-DSL). Horários do commute são informativos: o cron é
// fixo em crons.ts (UTC) e mudar exige redeploy — por isso ficam read-only.
// ═══════════════════════════════════════════════════════════════════════════

interface ConfigResolvida {
  chat_id?: string;
  ativo: boolean;
  commute: {
    ativo: boolean;
    gatilho_ratio: number;
    piso_minutos: number;
    hora_manha_local: string;
    hora_tarde_local: string;
    dias_semana: number[];
    periodico_ativo: boolean;
  };
  defcon: { ativo: boolean; limiar_nivel: number };
  heartbeat: { ativo: boolean; stale_minutos: number; cooldown_horas: number };
  energia: { ativo: boolean; limiar_soc: number };
}

const NIVEL_OPTIONS = [
  { value: 1, label: '1 (Colapso)' },
  { value: 2, label: '2 (Crise)' },
  { value: 3, label: '3 (Ameaça)' },
  { value: 4, label: '4 (Alerta)' },
  { value: 5, label: '5 (Normal)' },
];

// 0=Dom … 6=Sáb (bate com Date.getUTCDay usado no backend).
const DIAS_LABEL = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

interface RenderResult {
  html: string;
  attach: (root: HTMLElement) => () => void;
}

const FS = 'border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; padding: 12px;';
const LEG = 'font-size: 0.78rem; font-weight: 700; padding: 0 6px;';
const HINT = 'font-size: 0.7rem; color: #6b7280; margin: 0 0 10px 0;';
const NUM = 'width: 100%; padding: 4px 6px; margin-top: 2px;';

export function renderNotificacoesSettings(): RenderResult {
  const html = `
    <div class="notif-settings" id="notifSettingsRoot">
      <div>
        <h3 style="margin: 0 0 4px 0; font-size: 1rem;">Notificações (Telegram)</h3>
        <p style="margin: 0 0 16px 0; font-size: 0.78rem; color: #6b7280;">
          Avisos por bot do Telegram. Só pioras — o sistema te cutuca quando algo
          agrava, nunca em "voltou ao normal".
        </p>
      </div>
      <div id="notifStatus" style="font-size: 0.75rem; color: #6b7280; margin-bottom: 12px;">
        Carregando configuração…
      </div>
      <form id="notifForm" style="display: none; gap: 18px; flex-direction: column;">

        <!-- Geral -->
        <fieldset style="${FS}">
          <legend style="${LEG}">Geral</legend>
          <label style="font-size: 0.78rem; display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
            <input type="checkbox" id="nfAtivo"> Ativar notificações (master switch)
          </label>
          <label style="font-size: 0.72rem;">
            chat_id do Telegram (destino)
            <input type="text" id="nfChatId" placeholder="ex: 306438355" style="${NUM} font-family: monospace;">
          </label>
          <p style="${HINT} margin-top: 8px;">
            Sem chat_id nada é enviado. Ele é capturado pelo smoke test do bot;
            edite aqui só se precisar trocar o destino.
          </p>
        </fieldset>

        <!-- Commute -->
        <fieldset style="${FS}">
          <legend style="${LEG}">🚗 Commute (casa ↔ trabalho)</legend>
          <label style="font-size: 0.78rem; display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
            <input type="checkbox" id="nfCommuteAtivo"> Avisar quando o trânsito estiver ruim
          </label>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <label style="font-size: 0.72rem;">
              Horário manhã (casa → trabalho)
              <input type="time" id="nfHoraManha" style="${NUM}">
            </label>
            <label style="font-size: 0.72rem;">
              Horário tarde (trabalho → casa)
              <input type="time" id="nfHoraTarde" style="${NUM}">
            </label>
          </div>
          <div style="font-size: 0.72rem; margin-top: 10px;">
            Dias da semana
            <div id="nfDias" style="display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap;"></div>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
            <label style="font-size: 0.72rem;">
              Gatilho de lentidão (ratio ≥)
              <input type="number" id="nfRatio" min="1" step="0.1" style="${NUM}">
            </label>
            <label style="font-size: 0.72rem;">
              Piso em minutos (só avisa acima disso)
              <input type="number" id="nfPiso" min="0" step="1" style="${NUM}">
            </label>
          </div>
          <label style="font-size: 0.78rem; display: flex; align-items: center; gap: 8px; margin-top: 10px;">
            <input type="checkbox" id="nfPeriodico"> Modo periódico (varre a cada ~30min na janela)
          </label>
          <p style="${HINT} margin-top: 8px;">
            Horários no fuso local (Floripa, UTC−3). Salvar já reprograma o
            próximo disparo — sem redeploy.
          </p>
        </fieldset>

        <!-- DEFCON -->
        <fieldset style="${FS}">
          <legend style="${LEG}">🚨 DEFCON global</legend>
          <label style="font-size: 0.78rem; display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
            <input type="checkbox" id="nfDefconAtivo"> Avisar quando o nível piorar
          </label>
          <label style="font-size: 0.72rem;">
            Notificar quando o nível chegar a (ou pior que)
            <select id="nfLimiar" style="${NUM}"></select>
          </label>
          <p style="${HINT} margin-top: 8px;">
            Dispara só em piora que cruze o limiar (1 = pior). A mensagem usa a
            explicação do Gemini quando disponível.
          </p>
        </fieldset>

        <!-- Energia de backup -->
        <fieldset style="${FS}">
          <legend style="${LEG}">🔋 Energia de backup (Delta 3)</legend>
          <label style="font-size: 0.78rem; display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
            <input type="checkbox" id="nfEnergiaAtivo"> Avisar em queda de energia e bateria baixa
          </label>
          <label style="font-size: 0.72rem;">
            Avisar quando a bateria cair abaixo de (%)
            <input type="number" id="nfLimiarSoc" min="5" max="100" step="5" style="${NUM}">
          </label>
          <p style="${HINT} margin-top: 8px;">
            Queda de rede avisa na hora e repete de hora em hora até voltar (e um
            aviso quando volta). Bateria baixa dispara no limiar e de novo a cada
            −5% (ex: 20% → 15% → 10% → 5%).
          </p>
        </fieldset>

        <!-- Heartbeat -->
        <fieldset style="${FS}">
          <legend style="${LEG}">🕳️ Heartbeat ("fiquei cego")</legend>
          <label style="font-size: 0.78rem; display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
            <input type="checkbox" id="nfHbAtivo"> Avisar se o ingestor parar de coletar
          </label>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <label style="font-size: 0.72rem;">
              Considerar "cego" após (min sem coleta)
              <input type="number" id="nfStale" min="15" step="5" style="${NUM}">
            </label>
            <label style="font-size: 0.72rem;">
              Cooldown entre avisos (horas)
              <input type="number" id="nfCooldown" min="1" step="1" style="${NUM}">
            </label>
          </div>
        </fieldset>

        <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
          <button type="submit" id="nfSaveBtn" style="padding: 6px 16px; font-weight: 600; cursor: pointer;">Salvar</button>
          <button type="button" id="nfTestBtn" style="padding: 6px 16px; cursor: pointer;">Enviar teste</button>
          <span id="nfSaveStatus" style="font-size: 0.72rem; color: #6b7280;"></span>
        </div>
      </form>
    </div>
  `;

  const attach = (root: HTMLElement): (() => void) => {
    const client = getOrCreateConvexClient();
    const statusEl = root.querySelector<HTMLElement>('#notifStatus')!;
    const formEl = root.querySelector<HTMLFormElement>('#notifForm')!;
    const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(id)!;

    const nfAtivo = $<HTMLInputElement>('#nfAtivo');
    const nfChatId = $<HTMLInputElement>('#nfChatId');
    const nfCommuteAtivo = $<HTMLInputElement>('#nfCommuteAtivo');
    const nfRatio = $<HTMLInputElement>('#nfRatio');
    const nfPiso = $<HTMLInputElement>('#nfPiso');
    const nfPeriodico = $<HTMLInputElement>('#nfPeriodico');
    const nfHoraManha = $<HTMLInputElement>('#nfHoraManha');
    const nfHoraTarde = $<HTMLInputElement>('#nfHoraTarde');
    const nfDias = $<HTMLElement>('#nfDias');
    const nfDefconAtivo = $<HTMLInputElement>('#nfDefconAtivo');
    const nfLimiar = $<HTMLSelectElement>('#nfLimiar');
    const nfHbAtivo = $<HTMLInputElement>('#nfHbAtivo');
    const nfStale = $<HTMLInputElement>('#nfStale');
    const nfCooldown = $<HTMLInputElement>('#nfCooldown');
    const nfEnergiaAtivo = $<HTMLInputElement>('#nfEnergiaAtivo');
    const nfLimiarSoc = $<HTMLInputElement>('#nfLimiarSoc');
    const saveBtn = $<HTMLButtonElement>('#nfSaveBtn');
    const testBtn = $<HTMLButtonElement>('#nfTestBtn');
    const saveStatus = $<HTMLElement>('#nfSaveStatus');

    nfLimiar.innerHTML = NIVEL_OPTIONS
      .map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`)
      .join('');

    if (!client) {
      statusEl.textContent =
        'Convex não configurado (VITE_CONVEX_URL ausente). Notificações indisponíveis.';
      return () => {};
    }
    const c = client as any;

    // Estado dos dias da semana (toggles). Renderiza os 7 botões e alterna via
    // event delegation (sem onclick inline — CSP-safe).
    const diasDraft = new Set<number>();
    function renderDias() {
      nfDias.innerHTML = DIAS_LABEL.map((lbl, dow) => {
        const on = diasDraft.has(dow);
        return `<button type="button" data-dow="${dow}" style="font-size: 0.7rem; padding: 4px 8px; cursor: pointer; border-radius: 4px; border: 1px solid rgba(0,0,0,0.15); ${on ? 'background:#2563eb;color:#fff;' : 'background:transparent;'}">${lbl}</button>`;
      }).join('');
    }
    nfDias.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-dow]');
      if (!btn) return;
      const dow = Number(btn.dataset.dow);
      if (diasDraft.has(dow)) diasDraft.delete(dow);
      else diasDraft.add(dow);
      renderDias();
    });

    const unsub = c.onUpdate(
      'notificacoes/config:getConfig',
      {},
      (data: ConfigResolvida | null) => {
        if (!data) return;
        nfAtivo.checked = data.ativo;
        nfChatId.value = data.chat_id ?? '';
        nfCommuteAtivo.checked = data.commute.ativo;
        nfRatio.value = String(data.commute.gatilho_ratio);
        nfPiso.value = String(data.commute.piso_minutos);
        nfPeriodico.checked = data.commute.periodico_ativo;
        nfHoraManha.value = data.commute.hora_manha_local;
        nfHoraTarde.value = data.commute.hora_tarde_local;
        diasDraft.clear();
        for (const d of data.commute.dias_semana) diasDraft.add(d);
        renderDias();
        nfDefconAtivo.checked = data.defcon.ativo;
        nfLimiar.value = String(data.defcon.limiar_nivel);
        nfHbAtivo.checked = data.heartbeat.ativo;
        nfStale.value = String(data.heartbeat.stale_minutos);
        nfCooldown.value = String(data.heartbeat.cooldown_horas);
        nfEnergiaAtivo.checked = data.energia.ativo;
        nfLimiarSoc.value = String(data.energia.limiar_soc);
        statusEl.textContent = data.chat_id
          ? 'Configuração carregada.'
          : 'Sem chat_id — rode o smoke test do bot ou preencha abaixo.';
        formEl.style.display = 'flex';
      },
    );

    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      saveStatus.textContent = 'Salvando…';
      saveStatus.style.color = '#6b7280';
      saveBtn.disabled = true;
      try {
        const payload: Record<string, unknown> = {
          ativo: nfAtivo.checked,
          commute: {
            ativo: nfCommuteAtivo.checked,
            gatilho_ratio: Math.max(1, parseFloat(nfRatio.value) || 1.4),
            piso_minutos: Math.max(0, parseInt(nfPiso.value, 10) || 0),
            hora_manha_local: nfHoraManha.value || '07:15',
            hora_tarde_local: nfHoraTarde.value || '17:15',
            dias_semana: Array.from(diasDraft).sort((a, b) => a - b),
            periodico_ativo: nfPeriodico.checked,
          },
          defcon: {
            ativo: nfDefconAtivo.checked,
            limiar_nivel: parseInt(nfLimiar.value, 10),
          },
          heartbeat: {
            ativo: nfHbAtivo.checked,
            stale_minutos: Math.max(15, parseInt(nfStale.value, 10) || 45),
            cooldown_horas: Math.max(1, parseInt(nfCooldown.value, 10) || 3),
          },
          energia: {
            ativo: nfEnergiaAtivo.checked,
            limiar_soc: Math.min(100, Math.max(5, parseInt(nfLimiarSoc.value, 10) || 20)),
          },
        };
        // chat_id: só envia se preenchido (não sobrescreve com vazio).
        const chatId = nfChatId.value.trim();
        if (chatId) payload.chat_id = chatId;

        await c.mutation('notificacoes/config:atualizarConfig', payload);
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

    testBtn.addEventListener('click', async () => {
      saveStatus.textContent = 'Enviando teste…';
      saveStatus.style.color = '#6b7280';
      testBtn.disabled = true;
      try {
        const res: { ok: boolean; erro?: string } = await c.action(
          'notificacoes/enviar:enviarTeste',
          {},
        );
        if (res.ok) {
          saveStatus.textContent = 'Teste enviado — confira o Telegram.';
          saveStatus.style.color = '#22c55e';
        } else {
          saveStatus.textContent = `Falha: ${res.erro ?? 'erro desconhecido'}`;
          saveStatus.style.color = '#ef4444';
        }
      } catch (err: any) {
        saveStatus.textContent = `Erro: ${err?.message ?? err}`;
        saveStatus.style.color = '#ef4444';
      } finally {
        testBtn.disabled = false;
        setTimeout(() => { saveStatus.textContent = ''; }, 4000);
      }
    });

    return () => {
      try { unsub?.(); } catch { /* noop */ }
    };
  };

  return { html, attach };
}
