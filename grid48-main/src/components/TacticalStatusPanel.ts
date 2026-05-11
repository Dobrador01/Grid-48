import { Panel } from './Panel';
import { getDataProvider } from '@/adapters';

declare const __API_MODE__: string;

/**
 * Pure status header for the engine. The SITREP request UX lives in its own
 * panel (SitrepButton) — keeping concerns separate avoids the placeholder
 * "RISCO NÍVEL 8" mock that used to live here from drifting back into prod.
 */
export class TacticalStatusPanel extends Panel {
  private status = 'loading...';
  private uptime: number | undefined = undefined;
  private interval: any;

  constructor() {
    super({
      id: 'tactical-status',
      title: 'Comando & Controle',
    });
    this.render();
  }

  public async mount() {
    this.updateHealth();
    this.interval = setInterval(() => this.updateHealth(), 5000);
  }

  public unmount() {
    if (this.interval) clearInterval(this.interval);
  }

  private async updateHealth() {
    const provider = getDataProvider();
    try {
      const health = await provider.getHealthStatus();
      this.status = health.status;
      this.uptime = health.uptime;
    } catch {
      this.status = 'OFFLINE';
      this.uptime = undefined;
    }
    this.render();
  }

  public render() {
    this.content.innerHTML = this.renderContent();
  }

  protected renderContent(): string {
    const mode = typeof __API_MODE__ !== 'undefined' ? __API_MODE__ : 'cloud';
    const isOffline = this.status === 'OFFLINE';
    const statusColor = isOffline ? 'var(--danger, #ef4444)' : 'var(--success, #10b981)';

    return `
      <div style="padding: 1.25rem; height: 100%; display: flex; flex-direction: column; background: transparent;">
        <div style="background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); letter-spacing: 0.1em; font-weight: 600;">[ NODE ENGINE ]</span>
            <span style="background: var(--overlay-medium); padding: 2px 6px; border-radius: 4px; font-family: var(--font-mono); font-size: 10px; color: var(--text-secondary); font-weight: 600;">MODE: ${mode.toUpperCase()}</span>
          </div>

          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
            <div style="width: 8px; height: 8px; border-radius: 50%; background: ${statusColor}; box-shadow: 0 0 8px ${statusColor};"></div>
            <span style="font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: ${statusColor};">${this.status.toUpperCase()}</span>
          </div>

          ${this.uptime ? `
            <div style="font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); margin-top: 6px; font-weight: 500;">
              UPTIME: ${Math.floor(this.uptime)}s
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }
}
