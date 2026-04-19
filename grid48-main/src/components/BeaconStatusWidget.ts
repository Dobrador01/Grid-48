import { Panel } from './Panel';
import type { BeaconAlert } from '@/services/beacon-client';

export class BeaconStatusWidget extends Panel {
  private alertas: BeaconAlert[] = [];

  constructor() {
    super({
      id: 'beacon-status',
      title: 'OSINT — Meteorologia',
    });
    this.render();
  }

  public setAlertas(alertas: BeaconAlert[]) {
    this.alertas = alertas;
    this.render();
  }

  public render() {
    this.content.innerHTML = this.renderContent();
  }

  protected renderContent(): string {
    if (this.alertas.length === 0) {
      return `
        <div style="padding: 1rem; display: flex; align-items: center; justify-content: center; height: 100%; color: #6b7280; font-family: sans-serif;">
          <p style="font-size: 0.875rem;">Monitorando ares de SC...</p>
        </div>
      `;
    }

    const cards = this.alertas.map(al => {
      const color = al.nivel_risco === 'Alto' ? '#ef4444' : (al.nivel_risco === 'Medio' ? '#f97316' : '#eab308');
      const bg = 'rgba(255, 255, 255, 0.65)';
      const ibgeFoco = al.cidades_afetadas_ibge[0] || 0;
      
      // Interpolative FlyTo via dispatch global enganado como se fosse Celesc (mas a abstração MapBox reage perfeitamente).
      const onclickDispatch = `window.dispatchEvent(new CustomEvent('CELESC_CITY_SELECTED', { detail: { codIbge: ${ibgeFoco} }, bubbles: true }))`;

      return `
        <div style="background: ${bg}; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border: 1px solid rgba(255,255,255,0.4); border-left: 4px solid ${color}; border-radius: 12px; margin-bottom: 0.85rem; padding: 1rem; box-shadow: 0 4px 15px rgba(0,0,0,0.05), inset 0 2px 4px rgba(255,255,255,0.4); cursor: pointer; transition: transform 0.2s;" onclick="${onclickDispatch}" onmouseenter="this.style.transform='translateY(-2px)'" onmouseleave="this.style.transform='translateY(0)'">
          <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem; font-weight: 700; color: #111827; font-family: ui-sans-serif, system-ui, sans-serif;">${al.titulo}</h4>
          <div style="display: flex; gap: 0.5rem; align-items: center; font-size: 0.75rem; font-family: ui-sans-serif, system-ui, sans-serif;">
            <span style="background: ${color}; color: white; padding: 3px 8px; border-radius: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; box-shadow: 0 2px 4px ${color}40;">${al.nivel_risco}</span>
            <span style="color: #4b5563; font-weight: 500;">${al.cidades_afetadas_ibge.length} Zonas Restritas</span>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div style="padding: 1.25rem; height: 100%; overflow-y: auto; background: rgba(245, 247, 250, 0.5); backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px);">
        <h3 style="color: #1f2937; margin: 0 0 1rem 0; font-size: 1.15rem; border-bottom: 2px solid rgba(255,255,255,0.6); padding-bottom: 0.75rem; font-weight: 800; font-family: ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.02em;">Radar OSINT: Defesa Civil</h3>
        <div style="margin-top: 0.5rem;">
          ${cards}
        </div>
      </div>
    `;
  }
}
