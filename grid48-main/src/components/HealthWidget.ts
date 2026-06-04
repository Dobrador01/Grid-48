import { Panel } from './Panel';
import { getDataProvider } from '@/adapters';
import type { HealthStatus } from '@/adapters/types';
import { buildChunkReloadStorageKey } from '@/bootstrap/chunk-reload';
// type-only — o @meshtastic fica lazy (carregado no clique, fora do bundle inicial).
import type { RadioStatus } from '@/services/meshtastic-bridge';
import type { BeaconSnapshot, TelemetryNode } from '@/services/beacon-client';
import { getOrCreateConvexClient } from '@/services/beacon-client';
import { readSignal } from '@/utils/signal';
import { escapeHtml, escapeAttr } from '@/utils/sanitize';

// Janela de "online" pro status dos nós (espelha LORA_ONLINE_WINDOW_MS do Map).
const LORA_ONLINE_WINDOW_MS = 5 * 60 * 1000;

declare const __APP_VERSION__: string;

declare const __API_MODE__: string;

const POLL_INTERVAL_MS = 5_000;

/**
 * Comando & Controle — consolidação dos antigos widgets `tactical-status`
 * (header MODE: CLOUD + status) e `engine-health` (breakdown técnico do
 * engine local). Os dois consumiam `getHealthStatus()` em paralelo e
 * mostravam basicamente a mesma coisa em CLOUD-mode; agora um único
 * widget pinta o badge MODE no header + o breakdown rico quando há
 * engine local rodando.
 *
 * Pollagem a cada 5s. Em CLOUD mode, mostra pill verde "Modo Cloud" +
 * badge MODE. Em LOCAL mode, mostra o breakdown completo (8 métricas).
 */
export class HealthWidget extends Panel {
  private status: HealthStatus | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private radioStatus: RadioStatus | 'idle' = 'idle';
  // Telemetria dos nós LoRa (do snapshot Convex) — alimenta o status do rádio.
  private telemetria: TelemetryNode[] = [];
  // Edição inline de rótulo: enquanto setado, pausamos re-renders pra não
  // estourar o <input> aberto (o poll de 5s e o fanout reconstroem o innerHTML).
  private editingNodeId: string | null = null;
  private editingValue = '';

  constructor() {
    super({
      id: 'engine-health',
      title: 'Comando & Controle',
    });
    // Event delegation no container (sobrevive aos re-renders de innerHTML).
    // CSP proíbe onclick inline — daí o data-action + listener único.
    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-action="connect-radio"]')) {
        void this.onConnectRadioClick();
        return;
      }
      const editBtn = target?.closest('[data-action="edit-label"]') as HTMLElement | null;
      if (editBtn?.dataset.node) { this.startEdit(editBtn.dataset.node); return; }
      const saveBtn = target?.closest('[data-action="save-label"]') as HTMLElement | null;
      if (saveBtn) { void this.commitEdit(); return; }
      const cancelBtn = target?.closest('[data-action="cancel-label"]') as HTMLElement | null;
      if (cancelBtn) { this.cancelEdit(); return; }
    });
    // Input de edição de rótulo: rastreia valor + Enter/Esc.
    this.content.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement | null;
      if (el?.dataset.role === 'label-input') this.editingValue = el.value;
    });
    this.content.addEventListener('keydown', (e) => {
      const el = e.target as HTMLInputElement | null;
      if (el?.dataset.role !== 'label-input') return;
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter') { e.preventDefault(); void this.commitEdit(); }
      else if (ke.key === 'Escape') { e.preventDefault(); this.cancelEdit(); }
    });
    this.render();
    void this.refresh();
    this.intervalId = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
  }

  /** Fanout do snapshot Convex — só usamos a telemetria dos nós LoRa aqui. */
  public setSnapshot(snapshot: BeaconSnapshot): void {
    this.telemetria = snapshot.telemetria ?? [];
    // Não re-renderiza no meio de uma edição de rótulo (estouraria o input).
    if (!this.editingNodeId) this.render();
  }

  /**
   * Conecta na base RAK via Web Serial. Import DINÂMICO (lazy) pra manter o
   * @meshtastic fora do bundle inicial. Desarmamos o chunk-reload guard durante
   * o import: se o chunk falhar ao carregar (deploy/SW propagando), queremos um
   * erro no botão, NÃO um reload da dashboard — que entrava em loop porque o
   * guard limpa o flag a cada init bem-sucedido (bootstrap/chunk-reload + main.ts).
   */
  private async onConnectRadioClick(): Promise<void> {
    if (this.radioStatus === 'connecting' || this.radioStatus === 'connected') return;
    this.setRadioStatus('connecting');

    const guardKey = buildChunkReloadStorageKey(__APP_VERSION__);
    let prevGuard: string | null = null;
    try {
      prevGuard = sessionStorage.getItem(guardKey);
      sessionStorage.setItem(guardKey, '1');
    } catch { /* private mode — guard provavelmente também inerte */ }

    try {
      const { connectRadio } = await import('@/services/meshtastic-bridge');
      await connectRadio((s) => this.setRadioStatus(s));
    } catch (e) {
      console.warn('[HealthWidget] conexão de rádio falhou', e);
      this.setRadioStatus('error');
    } finally {
      try {
        if (prevGuard === null) sessionStorage.removeItem(guardKey);
        else sessionStorage.setItem(guardKey, prevGuard);
      } catch { /* ignore */ }
    }
  }

  private setRadioStatus(s: RadioStatus): void {
    this.radioStatus = s;
    this.render();
  }

  public destroy() {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
  }

  private async refresh() {
    try {
      this.status = await getDataProvider().getHealthStatus();
    } catch (e) {
      console.warn('[HealthWidget] refresh failed', e);
      this.status = { status: 'offline' };
    }
    // Pausa o re-render enquanto o usuário edita um rótulo (preserva o input).
    if (!this.editingNodeId) this.render();
  }

  public render() {
    this.content.innerHTML = this.renderContent();
  }

  protected renderContent(): string {
    const mode = typeof __API_MODE__ !== 'undefined' ? __API_MODE__ : 'cloud';
    return `
      <div class="hw-container">
        ${this.renderModeBadge(mode)}
        ${this.renderBody()}
        ${this.renderRadioSection()}
      </div>
    `;
  }

  private renderBody(): string {
    if (!this.status) {
      return `<div class="hw-placeholder">Carregando saúde do engine…</div>`;
    }

    const s = this.status;

    // CLOUD provider: nothing to introspect, single pill.
    if (s.status === 'cloud-ok') {
      return this.pill('🟢', 'Modo Cloud', 'Engine local não aplicável neste build.');
    }

    // LOCAL provider offline.
    if (s.status === 'offline') {
      return this.pill('🔴', 'Engine offline', 'Sem resposta em http://localhost:3001/api/health.');
    }

    // LOCAL provider online/degraded: full breakdown.
    const overall = s.status === 'degraded' ? '🟡' : '🟢';
    const overallLabel = s.status === 'degraded' ? 'Operação degradada' : 'Operação normal';

    return `
      ${this.pill(overall, overallLabel, this.uptimeLabel(s.uptime))}
      <div class="hw-grid">
        ${this.metric('Pendrive', this.pendriveBadge(s.pendrive_mounted))}
        ${this.metric('Fila pendente', `${s.pending_sync ?? 0} pacotes`)}
        ${this.metric('Último rádio', this.relativeTime(s.last_radio_at, 'epoch_s'))}
        ${this.metric('Último PUSH', this.relativeTime(s.last_sync_at, 'epoch_s'))}
        ${this.metric('Snapshot Celesc', this.relativeTime(s.last_celesc_at, 'epoch_ms'))}
        ${this.metric('Snapshot Beacon', this.relativeTime(s.last_beacon_at, 'epoch_ms'))}
        ${this.metric('SQLite', this.bytesLabel(s.sqlite_size_bytes))}
        ${this.metric('Disco livre', this.bytesLabel(s.disk_free_bytes))}
      </div>
    `;
  }

  /**
   * Seção "Rádio LoRa" — botão de conexão + status dos nós (sinal amigável,
   * bateria, visto-há, hops) com edição inline do rótulo local.
   */
  private renderRadioSection(): string {
    const disabled = this.radioStatus === 'connecting' ? 'disabled' : '';
    return `
      <div style="margin-top:10px;border-top:1px solid var(--overlay-medium, rgba(0,0,0,0.08));padding-top:10px;">
        <button type="button" class="hw-radio-btn" data-action="connect-radio" ${disabled}
          style="width:100%;cursor:pointer;font-family:var(--font-mono, ui-monospace, monospace);font-size:12px;font-weight:600;padding:6px 10px;border-radius:6px;border:1px solid var(--overlay-medium, rgba(0,0,0,0.12));background:var(--overlay-medium, rgba(0,0,0,0.04));color:var(--text-primary, inherit);">
          ${this.radioLabel()}
        </button>
        ${this.renderNodeList()}
      </div>
    `;
  }

  /** Lista de nós LoRa conhecidos (do snapshot). Vazia → placeholder discreto. */
  private renderNodeList(): string {
    if (this.telemetria.length === 0) {
      return `<div style="margin-top:8px;font-size:11px;color:var(--text-dim,#6b7280);">Nenhum nó reportado ainda.</div>`;
    }
    // Online primeiro, depois mais recentes.
    const agora = Date.now();
    const nodes = [...this.telemetria].sort((a, b) => b.timestamp - a.timestamp);
    return `<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">
      ${nodes.map((n) => this.renderNodeRow(n, agora)).join('')}
    </div>`;
  }

  private renderNodeRow(n: TelemetryNode, agora: number): string {
    const online = agora - n.timestamp < LORA_ONLINE_WINDOW_MS;
    const sig = readSignal(n.snr, n.rssi);
    const labelled = !!n.label?.trim();
    const name = labelled ? n.label!.trim() : n.node_id;
    const dot = online ? '#22c55e' : '#9ca3af';
    const bat = typeof n.battery_level === 'number' ? `${n.battery_level}%` : '—';
    const batLow = typeof n.battery_level === 'number' && n.battery_level <= 20;
    const batColor = batLow ? '#ef4444' : 'var(--text-secondary,#4b5563)';
    const seen = this.lastSeenLabel(n.timestamp, agora);

    // Linha em edição → input + salvar/cancelar.
    if (this.editingNodeId === n.node_id) {
      return `
        <div style="display:flex;align-items:center;gap:6px;padding:6px;border-radius:6px;background:var(--overlay-medium,rgba(0,0,0,0.04));">
          <input type="text" data-role="label-input" value="${escapeAttr(this.editingValue)}" maxlength="32" placeholder="${escapeAttr(n.node_id)}"
            style="flex:1;min-width:0;font-size:12px;padding:4px 6px;border-radius:4px;border:1px solid var(--overlay-medium,rgba(0,0,0,0.2));background:var(--bg-primary,#fff);color:var(--text-primary,inherit);" />
          <button type="button" data-action="save-label" title="Salvar" style="cursor:pointer;border:none;background:none;font-size:14px;padding:2px 4px;">✓</button>
          <button type="button" data-action="cancel-label" title="Cancelar" style="cursor:pointer;border:none;background:none;font-size:14px;padding:2px 4px;">✕</button>
        </div>`;
    }

    // Badges: hops (direto/N saltos) + SNR numérico quando disponível.
    const badges: string[] = [];
    if (typeof n.hops_away === 'number') {
      const direct = n.hops_away === 0;
      badges.push(this.badgeHtml(
        direct ? '📡 direto' : `🔗 ${n.hops_away} salto${n.hops_away > 1 ? 's' : ''}`,
        direct ? '#16a34a' : '#6b7280',
      ));
    }
    if (typeof n.snr === 'number') {
      badges.push(this.badgeHtml(`SNR ${n.snr.toFixed(1)} dB`, sig.color));
    }
    const badgesRow = badges.length
      ? `<div style="display:flex;gap:4px;margin-top:3px;flex-wrap:wrap;">${badges.join('')}</div>`
      : '';

    // Sub-linha: id cru (quando há rótulo) + visto-há.
    const idPart = labelled
      ? `<span style="font-family:var(--font-mono,ui-monospace,monospace);">${escapeHtml(n.node_id)}</span> · `
      : '';

    return `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:7px;border-radius:6px;background:var(--overlay-medium,rgba(0,0,0,0.03));">
        <span style="width:8px;height:8px;border-radius:50%;background:${dot};flex-shrink:0;margin-top:3px;" title="${online ? 'online' : 'stale'}"></span>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:12px;font-weight:600;color:var(--text-primary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeAttr(n.node_id)}">${escapeHtml(name)}</span>
            <button type="button" data-action="edit-label" data-node="${escapeAttr(n.node_id)}" title="Renomear (rótulo local)"
              style="cursor:pointer;border:none;background:none;font-size:11px;padding:0;opacity:0.6;">✏️</button>
          </div>
          <div style="font-size:10px;color:var(--text-dim,#6b7280);margin-top:2px;">${idPart}${seen}</div>
          ${badgesRow}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">
          <div style="display:flex;align-items:center;gap:2px;" title="${escapeAttr(sig.detail)}">
            ${this.signalBarsHtml(sig.bars, sig.color)}
          </div>
          <span style="font-size:11px;font-weight:600;color:${batColor};white-space:nowrap;" title="bateria">${batLow ? '⚠️' : '🔋'}${bat}</span>
        </div>
      </div>`;
  }

  /** Pílula pequena pra badges (hops/SNR) no card do nó. */
  private badgeHtml(text: string, color: string): string {
    return `<span style="font-size:9.5px;font-weight:600;color:${color};background:var(--overlay-medium,rgba(0,0,0,0.05));border-radius:4px;padding:1px 5px;white-space:nowrap;">${escapeHtml(text)}</span>`;
  }

  /** 4 barrinhas verticais crescentes — preenchidas conforme a qualidade. */
  private signalBarsHtml(bars: number, color: string): string {
    const heights = [5, 8, 11, 14];
    return heights.map((h, i) => {
      const on = i < bars;
      return `<span style="display:inline-block;width:3px;height:${h}px;border-radius:1px;background:${on ? color : 'var(--overlay-medium,rgba(0,0,0,0.15))'};"></span>`;
    }).join('');
  }

  private lastSeenLabel(ts: number, agora: number): string {
    const diff = agora - ts;
    if (diff < 0) return 'agora';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `visto há ${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `visto há ${min} min`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `visto há ${hr}h`;
    return `visto há ${Math.floor(hr / 24)}d`;
  }

  private startEdit(nodeId: string): void {
    const node = this.telemetria.find((n) => n.node_id === nodeId);
    this.editingNodeId = nodeId;
    this.editingValue = node?.label ?? '';
    this.render();
    // Foca o input recém-renderizado.
    const input = this.content.querySelector('[data-role="label-input"]') as HTMLInputElement | null;
    if (input) { input.focus(); input.select(); }
  }

  private cancelEdit(): void {
    this.editingNodeId = null;
    this.editingValue = '';
    this.render();
  }

  private async commitEdit(): Promise<void> {
    const nodeId = this.editingNodeId;
    if (!nodeId) return;
    const value = this.editingValue.trim();
    this.editingNodeId = null;
    this.editingValue = '';
    this.render();
    try {
      const client = getOrCreateConvexClient();
      if (!client) { console.warn('[HealthWidget] ConvexClient indisponível — rótulo não salvo.'); return; }
      await (client as unknown as {
        mutation: (name: string, args: unknown) => Promise<unknown>;
      }).mutation('mutations:setNodeLabel', { node_id: nodeId, label: value });
      // O rótulo volta via subscription reativa (getLatestTelemetry faz join).
    } catch (e) {
      console.warn('[HealthWidget] falha ao salvar rótulo:', e);
    }
  }

  private radioLabel(): string {
    switch (this.radioStatus) {
      case 'connecting': return 'Conectando rádio…';
      case 'connected': return '🟢 Rádio conectado';
      case 'error': return '🔴 Falha — tentar de novo';
      case 'disconnected': return '📡 Reconectar rádio';
      default: return '📡 Conectar rádio';
    }
  }

  /**
   * Header com identificador "[ NODE ENGINE ]" + badge "MODE: CLOUD/LOCAL".
   * Transplantado do antigo TacticalStatusPanel pra preservar a info de modo
   * que aparecia no header de "Comando & Controle".
   */
  private renderModeBadge(mode: string): string {
    return `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
        <span style="font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; color: var(--text-dim, #6b7280); letter-spacing: 0.1em; font-weight: 600;">[ NODE ENGINE ]</span>
        <span style="background: var(--overlay-medium, rgba(0,0,0,0.06)); padding: 2px 6px; border-radius: 4px; font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; color: var(--text-secondary, #4b5563); font-weight: 600;">MODE: ${mode.toUpperCase()}</span>
      </div>
    `;
  }

  private pill(icon: string, title: string, subtitle: string): string {
    return `
      <div class="hw-pill">
        <span class="hw-pill-icon">${icon}</span>
        <div class="hw-pill-text">
          <div class="hw-pill-title">${title}</div>
          <div class="hw-pill-subtitle">${subtitle}</div>
        </div>
      </div>
    `;
  }

  private metric(label: string, value: string): string {
    return `
      <div class="hw-metric">
        <div class="hw-metric-label">${label}</div>
        <div class="hw-metric-value">${value}</div>
      </div>
    `;
  }

  private pendriveBadge(mounted: boolean | null | undefined): string {
    if (mounted === true) return '🟢 montado';
    if (mounted === false) return '🔴 ausente';
    return '— n/d';
  }

  private uptimeLabel(uptime: number | undefined): string {
    if (typeof uptime !== 'number') return 'Tempo de atividade indisponível';
    const minutes = Math.floor(uptime / 60);
    if (minutes < 60) return `Ativo há ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return `Ativo há ${hours}h ${rem}min`;
  }

  private relativeTime(ts: number | null | undefined, scale: 'epoch_s' | 'epoch_ms'): string {
    if (ts == null || ts === 0) return '—';
    const ms = scale === 'epoch_s' ? ts * 1000 : ts;
    const diff = Date.now() - ms;
    if (diff < 0) return 'agora';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `há ${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `há ${min} min`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `há ${hr}h ${min % 60}min`;
    const days = Math.floor(hr / 24);
    return `há ${days}d`;
  }

  private bytesLabel(bytes: number | null | undefined): string {
    if (bytes == null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}
