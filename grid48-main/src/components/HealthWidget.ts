import { Panel } from './Panel';
import { getDataProvider } from '@/adapters';
import type { HealthStatus } from '@/adapters/types';

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

  constructor() {
    super({
      id: 'engine-health',
      title: 'Comando & Controle',
    });
    this.render();
    void this.refresh();
    this.intervalId = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
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
    const modeBadge = this.renderModeBadge(mode);

    if (!this.status) {
      return `
        <div class="hw-container">
          ${modeBadge}
          <div class="hw-placeholder">Carregando saúde do engine…</div>
        </div>
      `;
    }

    const s = this.status;

    // CLOUD provider: nothing to introspect, single pill + badge MODE.
    if (s.status === 'cloud-ok') {
      return `
        <div class="hw-container">
          ${modeBadge}
          ${this.pill('🟢', 'Modo Cloud', 'Engine local não aplicável neste build.')}
        </div>
      `;
    }

    // LOCAL provider offline.
    if (s.status === 'offline') {
      return `
        <div class="hw-container">
          ${modeBadge}
          ${this.pill('🔴', 'Engine offline', 'Sem resposta em http://localhost:3001/api/health.')}
        </div>
      `;
    }

    // LOCAL provider online/degraded: full breakdown.
    const overall = s.status === 'degraded' ? '🟡' : '🟢';
    const overallLabel = s.status === 'degraded' ? 'Operação degradada' : 'Operação normal';

    return `
      <div class="hw-container">
        ${modeBadge}
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
      </div>
    `;
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
