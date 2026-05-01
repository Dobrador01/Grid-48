import { Panel } from './Panel';
import { getDataProvider } from '@/adapters';

declare const __API_MODE__: string;

export class TacticalStatusPanel extends Panel {
  private status = 'loading...';
  private uptime: number | undefined = undefined;
  private interval: any;
  private btnState = 'idle'; // idle | processing | result

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
    } catch (e) {
      this.status = 'OFFLINE';
      this.uptime = undefined;
    }
    this.render();
  }

  private handleSitrepClick = () => {
    if (this.btnState !== 'idle') return;

    this.btnState = 'processing';
    this.render();

    // Simulate Convex/Gemini processing time
    setTimeout(() => {
      this.btnState = 'result';
      this.render();
      
      // Reset back to idle after showing the result
      setTimeout(() => {
        this.btnState = 'idle';
        this.render();
      }, 8000);
    }, 3000);
  };

  public render() {
    this.content.innerHTML = this.renderContent();
    const btn = this.content.querySelector('#btn-sitrep');
    if (btn) {
      btn.addEventListener('click', this.handleSitrepClick);
    }
  }

  protected renderContent(): string {
    const mode = typeof __API_MODE__ !== 'undefined' ? __API_MODE__ : 'cloud';
    const isOffline = this.status === 'OFFLINE';
    
    const statusColor = isOffline ? '#ef4444' : '#10b981'; // Red or Emerald
    
    // Sitrep Button Styling (Neutral)
    let btnText = 'SITREP TÁTICO';
    let btnBg = 'rgba(255, 255, 255, 0.05)'; 
    let btnBorder = 'rgba(255, 255, 255, 0.1)';
    let btnShadow = 'none';
    let btnColor = '#e5e7eb';

    if (this.btnState === 'processing') {
      btnText = 'PROCESSANDO IA...';
      btnBg = 'rgba(234, 179, 8, 0.15)'; // Subtle Yellow
      btnBorder = 'rgba(234, 179, 8, 0.4)';
      btnShadow = '0 0 10px rgba(234, 179, 8, 0.2)';
      btnColor = '#fde047';
    } else if (this.btnState === 'result') {
      btnText = 'RISCO NÍVEL 8 - ENERGIA';
      btnBg = 'rgba(239, 68, 68, 0.15)'; // Subtle Red
      btnBorder = 'rgba(239, 68, 68, 0.4)';
      btnShadow = '0 0 10px rgba(239, 68, 68, 0.2)';
      btnColor = '#fca5a5';
    }

    return `
      <div style="padding: 1.25rem; height: 100%; display: flex; flex-direction: column; justify-content: space-between; background: rgba(20, 25, 20, 0.4); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);">
        
        <!-- Status Header Section -->
        <div style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.05); border-radius: 8px; padding: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-family: monospace; font-size: 11px; color: #9ca3af; letter-spacing: 0.1em;">[ NODE ENGINE ]</span>
            <span style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 10px; color: #fff;">MODE: ${mode.toUpperCase()}</span>
          </div>
          
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
            <div style="width: 8px; height: 8px; border-radius: 50%; background: ${statusColor}; box-shadow: 0 0 8px ${statusColor};"></div>
            <span style="font-family: monospace; font-size: 13px; font-weight: bold; color: ${statusColor};">${this.status.toUpperCase()}</span>
          </div>
          
          ${this.uptime ? `
            <div style="font-family: monospace; font-size: 10px; color: #6b7280; margin-top: 6px;">
              UPTIME: ${Math.floor(this.uptime)}s
            </div>
          ` : ''}
        </div>

        <!-- Tactical Button Section -->
        <div style="margin-top: auto; padding-top: 16px;">
          <button id="btn-sitrep" style="
            width: 100%;
            background: ${btnBg};
            color: ${btnColor};
            border: 1px solid ${btnBorder};
            padding: 14px 20px;
            border-radius: 6px;
            font-weight: 700;
            font-family: ui-sans-serif, system-ui, sans-serif;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            cursor: ${this.btnState === 'idle' ? 'pointer' : 'default'};
            box-shadow: ${btnShadow};
            transition: all 0.3s ease;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 8px;
          ">
            ${this.btnState === 'idle' ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>` : ''}
            ${btnText}
          </button>
        </div>
      </div>
    `;
  }
}
