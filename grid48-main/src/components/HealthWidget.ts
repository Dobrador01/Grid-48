import { Panel } from './Panel';
import { getDataProvider } from '@/adapters';
import type { HealthStatus } from '@/adapters/types';
import { buildChunkReloadStorageKey } from '@/bootstrap/chunk-reload';
// type-only — o @meshtastic fica lazy (carregado no clique, fora do bundle inicial).
import type { RadioStatus } from '@/services/meshtastic-bridge';

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
      }
    });
    this.render();
    void this.refresh();
    this.intervalId = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
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
      this.render();
    } catch (e) {
      console.warn('[HealthWidget] refresh failed', e);
      this.status = { status: 'offline' };
      this.render();
    }
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
   * Seção "Rádio LoRa" — botão que conecta na base RAK via Chrome Web Serial
   * (ponte Meshtastic → Convex). Presente em todos os modos.
   */
  private renderRadioSection(): string {
    const disabled = this.radioStatus === 'connecting' ? 'disabled' : '';
    return `
      <div style="margin-top:10px;border-top:1px solid var(--overlay-medium, rgba(0,0,0,0.08));padding-top:10px;">
        <button type="button" class="hw-radio-btn" data-action="connect-radio" ${disabled}
          style="width:100%;cursor:pointer;font-family:var(--font-mono, ui-monospace, monospace);font-size:12px;font-weight:600;padding:6px 10px;border-radius:6px;border:1px solid var(--overlay-medium, rgba(0,0,0,0.12));background:var(--overlay-medium, rgba(0,0,0,0.04));color:var(--text-primary, inherit);">
          ${this.radioLabel()}
        </button>
      </div>
    `;
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
