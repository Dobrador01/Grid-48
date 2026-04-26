import { getDataProvider } from '@/adapters';

// Ensure TS recognizes __API_MODE__
declare const __API_MODE__: string;

export class HealthWidget {
  private container: HTMLElement;
  private interval: any;

  constructor(parentId: string) {
    const parent = document.getElementById(parentId);
    if (!parent) return;

    this.container = document.createElement('div');
    this.container.className = 'grid48-health-widget';
    this.container.style.cssText = `
      position: absolute;
      bottom: 20px;
      right: 20px;
      background: rgba(10, 15, 10, 0.7);
      border: 1px solid rgba(0, 255, 0, 0.3);
      color: #0f0;
      padding: 10px;
      border-radius: 8px;
      font-family: monospace;
      z-index: 1000;
      backdrop-filter: blur(4px);
      pointer-events: none;
      font-size: 11px;
    `;
    parent.appendChild(this.container);
  }

  public async mount() {
    if (!this.container) return;
    this.update();
    this.interval = setInterval(() => this.update(), 5000);
  }

  public unmount() {
    if (this.interval) clearInterval(this.interval);
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
  }

  private async update() {
    const provider = getDataProvider();
    const mode = typeof __API_MODE__ !== 'undefined' ? __API_MODE__ : 'cloud';
    
    try {
      const health = await provider.getHealthStatus();
      this.container.innerHTML = `
        <div style="font-weight:bold; margin-bottom: 4px;">[ GRID 48 ]</div>
        <div>MODE: ${mode.toUpperCase()}</div>
        <div>STATUS: ${health.status}</div>
        ${health.uptime ? `<div>UPTIME: ${Math.floor(health.uptime)}s</div>` : ''}
      `;
    } catch (e) {
      this.container.innerHTML = `
        <div style="font-weight:bold; margin-bottom: 4px;">[ GRID 48 ]</div>
        <div>MODE: ${mode.toUpperCase()}</div>
        <div style="color:red">STATUS: OFFLINE</div>
      `;
    }
  }
}
