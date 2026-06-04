import { escapeHtml } from '@/utils/sanitize';

// ═══════════════════════════════════════════════════════════════════════════
// RadioSettings — aba "Rádio" do UnifiedSettings (Fase D)
// ═══════════════════════════════════════════════════════════════════════════
//
// Padrão: factory `renderRadioSettings()` → `{ html, attach }`, igual ao
// `renderDefconSettings()` (inclusive estilos inline — CSP permite style=).
// Escreve config REAL no device LoRa via dock USB (Web Serial), usando os
// writers da ponte (services/meshtastic-bridge).
//
// Escopo (decidido com o dono): Identidade (owner long/short), Rede LoRa
// (região + modem preset + canal/PSK), Posição fixa + intervalos. SEM zona de
// perigo (reboot/factory reset) por enquanto.
//
// A ponte é lazy-loaded (só carrega no clique "Conectar rádio"). Esta aba
// importa a ponte DINAMICAMENTE no attach — quando o rádio está conectado, o
// módulo já está em memória e o import resolve na hora. Dropdowns de região/
// preset e o pré-preenchimento vêm do runtime (getRadioConfigSnapshot etc.).
// ═══════════════════════════════════════════════════════════════════════════

interface RenderResult {
  html: string;
  attach: (root: HTMLElement) => () => void;
}

const FIELDSET = 'border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; padding: 12px; margin: 0 0 14px 0;';
const LEGEND = 'font-size: 0.78rem; font-weight: 700; padding: 0 6px;';
const LABEL = 'display: block; font-size: 0.72rem; margin-bottom: 10px;';
const INPUT = 'width: 100%; padding: 4px 6px; margin-top: 2px; box-sizing: border-box;';
const SUB = 'font-size: 0.68rem; color: #6b7280; margin: 0 0 10px 0;';
const BTN = 'font-size: 0.72rem; padding: 5px 12px; cursor: pointer; border-radius: 6px; border: 1px solid rgba(0,0,0,0.15); background: var(--accent, #2563eb); color: #fff;';
const BTN_GHOST = 'font-size: 0.72rem; padding: 5px 12px; cursor: pointer; border-radius: 6px; border: 1px solid rgba(0,0,0,0.2); background: transparent; color: inherit;';
const ACTIONS = 'display: flex; align-items: center; gap: 10px; margin-top: 6px; flex-wrap: wrap;';
const STATUS = 'font-size: 0.7rem; color: #6b7280;';

export function renderRadioSettings(): RenderResult {
  const html = `
    <div class="radio-settings" style="padding: 4px 2px;">
      <div id="radioDisconnectedNotice" hidden
        style="font-size: 0.78rem; line-height: 1.5; padding: 14px; border: 1px dashed rgba(0,0,0,0.2); border-radius: 8px; color: #6b7280;">
        <strong>Rádio não conectado.</strong>
        Conecte a base/tag pelo painel <em>Comando &amp; Controle</em> (botão
        “Conectar rádio”) e reabra esta aba para ler e gravar a configuração.
      </div>

      <div id="radioForms" hidden>
        <div id="radioDeviceLine" style="font-size: 0.72rem; font-weight: 600; margin-bottom: 8px; font-family: var(--font-mono, ui-monospace, monospace);"></div>
        <p style="${SUB} margin-bottom: 14px;">
          Campos pré-preenchidos com o estado atual do device. Edite e grave
          seção por seção. Mudar a <strong>região</strong> reinicia o rádio.
        </p>

        <fieldset style="${FIELDSET}">
          <legend style="${LEGEND}">Identidade</legend>
          <label style="${LABEL}">Nome longo
            <input type="text" id="radioLongName" maxlength="39" placeholder="ex: Tag Pluviômetro Casa" style="${INPUT}">
          </label>
          <label style="${LABEL}">Nome curto
            <input type="text" id="radioShortName" maxlength="4" placeholder="ex: PLUV" style="${INPUT}">
          </label>
          <div style="${ACTIONS}">
            <button type="button" id="radioSaveOwner" style="${BTN}">Gravar identidade</button>
            <span id="radioOwnerStatus" style="${STATUS}"></span>
          </div>
        </fieldset>

        <fieldset style="${FIELDSET}">
          <legend style="${LEGEND}">Rede LoRa</legend>
          <label style="${LABEL}">Região
            <select id="radioRegion" style="${INPUT}"></select>
          </label>
          <p style="${SUB}">
            <span id="radioRegionBand" style="font-weight: 600; color: var(--text-secondary,#4b5563);"></span>
            Brasil não tem entrada própria nesta versão — use <strong>US</strong>
            (dentro da faixa ISM brasileira 902–928&nbsp;MHz).
          </p>
          <label style="${LABEL}">Modem preset
            <select id="radioPreset" style="${INPUT}"></select>
          </label>
          <div style="${ACTIONS}">
            <button type="button" id="radioSaveLora" style="${BTN}">Gravar rede (reinicia o rádio)</button>
            <span id="radioLoraStatus" style="${STATUS}"></span>
          </div>

          <hr style="border: none; border-top: 1px solid rgba(0,0,0,0.08); margin: 14px 0;">

          <label style="${LABEL}">Nome do canal
            <input type="text" id="radioChannelName" maxlength="11" placeholder="ex: Grid48" style="${INPUT}">
          </label>
          <label style="${LABEL}">PSK (base64)
            <input type="text" id="radioChannelPsk" placeholder="vazio = sem criptografia" style="${INPUT}">
          </label>
          <div id="radioPskInfo" style="${SUB} margin-top: -6px;"></div>
          <p style="${SUB}">
            Todas as tags precisam do <strong>mesmo nome + PSK</strong> pra formar
            a mesh. 16 bytes = AES-128, 32 bytes = AES-256.
          </p>
          <div style="${ACTIONS}">
            <button type="button" id="radioGenPsk" style="${BTN_GHOST}">Gerar PSK (32 bytes)</button>
            <button type="button" id="radioSaveChannel" style="${BTN}">Gravar canal</button>
            <span id="radioChannelStatus" style="${STATUS}"></span>
          </div>
        </fieldset>

        <fieldset style="${FIELDSET}">
          <legend style="${LEGEND}">Posição</legend>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 0.72rem; margin-bottom: 10px;">
            <input type="checkbox" id="radioFixedPos">
            <span>Posição fixa (sensores parados — sem depender de GPS)</span>
          </label>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <label style="${LABEL}">Latitude
              <input type="number" id="radioLat" step="0.0000001" placeholder="-27.5954" style="${INPUT}">
            </label>
            <label style="${LABEL}">Longitude
              <input type="number" id="radioLon" step="0.0000001" placeholder="-48.5480" style="${INPUT}">
            </label>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <label style="${LABEL}">Broadcast de posição (s)
              <input type="number" id="radioPosBroadcast" min="0" step="1" placeholder="ex: 900" style="${INPUT}">
            </label>
            <label style="${LABEL}">Update do GPS (s)
              <input type="number" id="radioGpsInterval" min="0" step="1" placeholder="ex: 120" style="${INPUT}">
            </label>
          </div>
          <div style="${ACTIONS}">
            <button type="button" id="radioSavePosition" style="${BTN}">Gravar posição</button>
            <span id="radioPositionStatus" style="${STATUS}"></span>
          </div>
        </fieldset>

        <fieldset style="${FIELDSET}">
          <legend style="${LEGEND}">Tag / Sensores</legend>
          <label style="${LABEL}">Intervalo de telemetria (s) — bateria/TX/uptime
            <input type="number" id="radioTelemetryInterval" min="0" step="1" placeholder="ex: 900" style="${INPUT}">
          </label>
          <div style="${ACTIONS}">
            <button type="button" id="radioSaveTelemetry" style="${BTN}">Gravar telemetria</button>
            <span id="radioTelemetryStatus" style="${STATUS}"></span>
          </div>
          <hr style="border: none; border-top: 1px solid rgba(0,0,0,0.08); margin: 14px 0;">
          <label style="display: flex; align-items: center; gap: 8px; font-size: 0.72rem; margin-bottom: 4px;">
            <input type="checkbox" id="radioBuzzer">
            <span>Notificações sonoras (buzzer/LED — módulo de notificação externa)</span>
          </label>
          <p style="${SUB}">Apita/pisca em mensagens recebidas. Exige buzzer ligado no GPIO do device.</p>
          <div style="${ACTIONS}">
            <button type="button" id="radioSaveBuzzer" style="${BTN}">Gravar buzzer</button>
            <span id="radioBuzzerStatus" style="${STATUS}"></span>
          </div>
        </fieldset>
      </div>
    </div>
  `;

  function attach(root: HTMLElement): () => void {
    let disposed = false;

    const notice = root.querySelector<HTMLElement>('#radioDisconnectedNotice')!;
    const forms = root.querySelector<HTMLElement>('#radioForms')!;

    // Status por seção (cor por tipo) — sem inline handlers (CSP), só .style em JS.
    const setStatus = (id: string, msg: string, kind: 'ok' | 'err' | 'busy' | '') => {
      const el = root.querySelector<HTMLElement>(`#${id}`);
      if (!el) return;
      el.textContent = msg;
      el.style.color = kind === 'ok' ? '#16a34a' : kind === 'err' ? '#dc2626' : '#6b7280';
    };

    void (async () => {
      const bridge = await import('@/services/meshtastic-bridge');
      if (disposed) return;

      if (!bridge.isRadioConnected()) {
        notice.hidden = false;
        forms.hidden = true;
        return;
      }
      notice.hidden = true;
      forms.hidden = false;

      const snap = bridge.getRadioConfigSnapshot();

      // Linha do device conectado: nome (se houver) + node id em hex.
      const deviceLine = root.querySelector<HTMLElement>('#radioDeviceLine');
      if (deviceLine) {
        const idHex = typeof snap.myNodeNum === 'number'
          ? '!' + (snap.myNodeNum >>> 0).toString(16).padStart(8, '0')
          : '—';
        const owner = snap.ownerLongName ? `${snap.ownerLongName} · ` : '';
        deviceLine.textContent = `📟 ${owner}${idHex}`;
      }

      // ── Dropdowns (lidos do runtime) ──────────────────────────────────────
      const regionSel = root.querySelector<HTMLSelectElement>('#radioRegion')!;
      const presetSel = root.querySelector<HTMLSelectElement>('#radioPreset')!;
      const fillSelect = (sel: HTMLSelectElement, opts: { value: number; label: string }[], current?: number) => {
        sel.innerHTML = opts
          .map((o) => `<option value="${o.value}"${o.value === current ? ' selected' : ''}>${escapeHtml(o.label)}</option>`)
          .join('');
      };
      fillSelect(regionSel, bridge.getRegionOptions(), snap.region);
      fillSelect(presetSel, bridge.getModemPresetOptions(), snap.modemPreset);

      // Dica de faixa de frequência da região selecionada (só as comuns; resto
      // mostra genérico). Atualiza ao trocar o dropdown.
      const REGION_BANDS: Record<string, string> = {
        US: '902–928 MHz', ANZ: '915–928 MHz', ANZ_433: '433 MHz',
        EU_433: '433 MHz', EU_868: '863–870 MHz', CN: '470–510 MHz',
        JP: '920–923 MHz', KR: '920–923 MHz', RU: '868–870 MHz',
        IN: '865–867 MHz', TH: '920–925 MHz', LORA_24: '2.4 GHz',
      };
      const bandEl = root.querySelector<HTMLElement>('#radioRegionBand');
      const updateBand = () => {
        if (!bandEl) return;
        const label = regionSel.options[regionSel.selectedIndex]?.text ?? '';
        const band = REGION_BANDS[label];
        bandEl.textContent = band ? `📶 ${label} · ${band}. ` : '';
      };
      updateBand();
      regionSel.addEventListener('change', updateBand);

      // ── Pré-preenchimento ─────────────────────────────────────────────────
      const setVal = (id: string, v: string) => {
        const el = root.querySelector<HTMLInputElement>(`#${id}`);
        if (el) el.value = v;
      };
      setVal('radioLongName', snap.ownerLongName ?? '');
      setVal('radioShortName', snap.ownerShortName ?? '');
      setVal('radioChannelName', snap.channelName ?? '');
      setVal('radioChannelPsk', snap.channelPskB64 ?? '');
      const fixedCheck = root.querySelector<HTMLInputElement>('#radioFixedPos')!;
      fixedCheck.checked = snap.fixedPosition ?? false;
      if (typeof snap.positionBroadcastSecs === 'number') setVal('radioPosBroadcast', String(snap.positionBroadcastSecs));
      if (typeof snap.gpsUpdateInterval === 'number') setVal('radioGpsInterval', String(snap.gpsUpdateInterval));
      if (typeof snap.telemetryIntervalSecs === 'number') setVal('radioTelemetryInterval', String(snap.telemetryIntervalSecs));
      const buzzerCheck = root.querySelector<HTMLInputElement>('#radioBuzzer')!;
      buzzerCheck.checked = snap.buzzerEnabled ?? false;

      // Guard genérico de gravação: trava o botão, roda, reporta. Sucesso some
      // sozinho depois de 5s pra não poluir.
      const guarded = async (btn: HTMLButtonElement, statusId: string, fn: () => Promise<void>, okMsg: string) => {
        btn.disabled = true;
        setStatus(statusId, 'Gravando…', 'busy');
        try {
          await fn();
          if (!disposed) {
            setStatus(statusId, okMsg, 'ok');
            window.setTimeout(() => { if (!disposed) setStatus(statusId, '', ''); }, 5000);
          }
        } catch (e) {
          if (!disposed) setStatus(statusId, e instanceof Error ? e.message : 'Falha ao gravar.', 'err');
        } finally {
          if (!disposed) btn.disabled = false;
        }
      };

      // Validação de PSK ao vivo: mostra bytes + se é um tamanho aceito.
      const pskInput = root.querySelector<HTMLInputElement>('#radioChannelPsk')!;
      const pskInfo = root.querySelector<HTMLElement>('#radioPskInfo');
      const updatePskInfo = () => {
        if (!pskInfo) return;
        const raw = pskInput.value.trim();
        if (!raw) { pskInfo.textContent = 'Sem PSK → canal aberto (sem criptografia).'; pskInfo.style.color = '#6b7280'; return; }
        let len: number;
        try { len = bridge.pskFromB64(raw).length; }
        catch { pskInfo.textContent = '⚠️ base64 inválido.'; pskInfo.style.color = '#dc2626'; return; }
        const ok = len === 0 || len === 1 || len === 16 || len === 32;
        const tipo = len === 32 ? ' (AES-256)' : len === 16 ? ' (AES-128)' : '';
        pskInfo.textContent = `${ok ? '✓' : '⚠️'} ${len} bytes${tipo}${ok ? '' : ' — use 16 ou 32'}`;
        pskInfo.style.color = ok ? '#16a34a' : '#dc2626';
      };
      pskInput.addEventListener('input', updatePskInfo);
      updatePskInfo();

      // ── Identidade ────────────────────────────────────────────────────────
      const saveOwnerBtn = root.querySelector<HTMLButtonElement>('#radioSaveOwner')!;
      saveOwnerBtn.addEventListener('click', () => {
        const longName = (root.querySelector<HTMLInputElement>('#radioLongName')!).value.trim();
        const shortName = (root.querySelector<HTMLInputElement>('#radioShortName')!).value.trim();
        if (!longName || !shortName) {
          setStatus('radioOwnerStatus', 'Preencha nome longo e curto.', 'err');
          return;
        }
        void guarded(saveOwnerBtn, 'radioOwnerStatus', () => bridge.applyOwner(longName, shortName), 'Identidade gravada ✓');
      });

      // ── Rede LoRa ─────────────────────────────────────────────────────────
      const saveLoraBtn = root.querySelector<HTMLButtonElement>('#radioSaveLora')!;
      saveLoraBtn.addEventListener('click', () => {
        const region = Number(regionSel.value);
        const preset = Number(presetSel.value);
        const regionLabel = regionSel.options[regionSel.selectedIndex]?.text ?? '';
        // Gravar rede reinicia o firmware — confirma pra evitar clique acidental.
        if (!window.confirm(`Gravar região ${regionLabel} + preset? Isso REINICIA o rádio e derruba a conexão por alguns segundos.`)) return;
        void guarded(saveLoraBtn, 'radioLoraStatus', () => bridge.applyLoraConfig(region, preset),
          'Rede gravada ✓ — o rádio vai reiniciar.');
      });

      // PSK aleatório (32 bytes → AES-256).
      const genPskBtn = root.querySelector<HTMLButtonElement>('#radioGenPsk')!;
      genPskBtn.addEventListener('click', () => {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        (root.querySelector<HTMLInputElement>('#radioChannelPsk')!).value = bridge.pskToB64(bytes);
        setStatus('radioChannelStatus', 'PSK gerado — grave para aplicar.', '');
      });

      const saveChannelBtn = root.querySelector<HTMLButtonElement>('#radioSaveChannel')!;
      saveChannelBtn.addEventListener('click', () => {
        const name = (root.querySelector<HTMLInputElement>('#radioChannelName')!).value.trim();
        const pskStr = (root.querySelector<HTMLInputElement>('#radioChannelPsk')!).value.trim();
        let psk: Uint8Array;
        try {
          psk = pskStr ? bridge.pskFromB64(pskStr) : new Uint8Array(0);
        } catch {
          setStatus('radioChannelStatus', 'PSK inválido (base64 malformado).', 'err');
          return;
        }
        if (psk.length !== 0 && psk.length !== 1 && psk.length !== 16 && psk.length !== 32) {
          setStatus('radioChannelStatus', `PSK deve ter 0, 16 ou 32 bytes (tem ${psk.length}).`, 'err');
          return;
        }
        void guarded(saveChannelBtn, 'radioChannelStatus', () => bridge.applyChannel(name, psk), 'Canal gravado ✓');
      });

      // ── Posição ───────────────────────────────────────────────────────────
      const savePosBtn = root.querySelector<HTMLButtonElement>('#radioSavePosition')!;
      savePosBtn.addEventListener('click', () => {
        const fixed = fixedCheck.checked;
        const latStr = (root.querySelector<HTMLInputElement>('#radioLat')!).value.trim();
        const lonStr = (root.querySelector<HTMLInputElement>('#radioLon')!).value.trim();
        const bcastStr = (root.querySelector<HTMLInputElement>('#radioPosBroadcast')!).value.trim();
        const lat = latStr ? Number(latStr) : undefined;
        const lon = lonStr ? Number(lonStr) : undefined;
        if (fixed && (!Number.isFinite(lat) || !Number.isFinite(lon))) {
          setStatus('radioPositionStatus', 'Posição fixa exige latitude e longitude válidas.', 'err');
          return;
        }
        const positionBroadcastSecs = bcastStr ? Number(bcastStr) : undefined;
        const gpsStr = (root.querySelector<HTMLInputElement>('#radioGpsInterval')!).value.trim();
        const gpsUpdateInterval = gpsStr ? Number(gpsStr) : undefined;
        void guarded(savePosBtn, 'radioPositionStatus',
          () => bridge.applyPositionConfig({ fixed, lat, lon, positionBroadcastSecs, gpsUpdateInterval }), 'Posição gravada ✓');
      });

      // ── Tag / Sensores ────────────────────────────────────────────────────
      const saveTelBtn = root.querySelector<HTMLButtonElement>('#radioSaveTelemetry')!;
      saveTelBtn.addEventListener('click', () => {
        const secs = Number((root.querySelector<HTMLInputElement>('#radioTelemetryInterval')!).value.trim());
        if (!Number.isFinite(secs) || secs <= 0) {
          setStatus('radioTelemetryStatus', 'Informe um intervalo em segundos (> 0).', 'err');
          return;
        }
        void guarded(saveTelBtn, 'radioTelemetryStatus', () => bridge.applyTelemetryConfig(secs), 'Telemetria gravada ✓');
      });

      const saveBuzzerBtn = root.querySelector<HTMLButtonElement>('#radioSaveBuzzer')!;
      saveBuzzerBtn.addEventListener('click', () => {
        void guarded(saveBuzzerBtn, 'radioBuzzerStatus',
          () => bridge.applyBuzzer(buzzerCheck.checked), `Buzzer ${buzzerCheck.checked ? 'ligado' : 'desligado'} ✓`);
      });
    })();

    return () => { disposed = true; };
  }

  return { html, attach };
}
