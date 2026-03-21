import { Panel } from './Panel';
import { getCurrentTheme } from '@/utils';
import { t } from '@/services/i18n';
import type { CelescMunicipioPayload } from '@/types/celesc';

export class CelescStatusWidget extends Panel {
  private outages: CelescMunicipioPayload[] = [];
  private lastUpdate: string = '';

  constructor() {
    super('celesc-status', 'Celesc — Instabilidade', {
      icon: '⚡',
      defaultSpan: 1,
      minSpan: 1,
      maxSpan: 2,
    });
    this.render();
  }

  public setOutages(outages: CelescMunicipioPayload[], lastUpdate: string) {
    this.outages = outages;
    this.lastUpdate = lastUpdate;
    this.render();
  }

  protected renderContent(): string {
    if (this.outages.length === 0) {
      return `
        <div class="p-4 flex flex-col items-center justify-center text-gray-500 h-full">
          <svg class="w-8 h-8 mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
          <p class="text-sm">Sistema operando normalmente.</p>
          <p class="text-xs mt-1">Nenhuma interrupção detectada.</p>
        </div>
      `;
    }

    // Sort by most affected
    const sorted = [...this.outages].sort((a, b) => b.ucsAfetadas - a.ucsAfetadas).slice(0, 10);
    const totalAfetadas = sorted.reduce((sum, item) => sum + item.ucsAfetadas, 0);

    const timeStr = this.lastUpdate ? new Date(this.lastUpdate).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';

    return `
      <div class="flex flex-col h-full bg-panel">
        <div class="p-3 border-b border-white/5 flex justify-between items-center bg-red-500/10">
          <div>
            <div class="text-xs uppercase tracking-wider text-red-400 font-bold mb-0.5">Alertas Ativos</div>
            <div class="text-xl font-medium text-white">${totalAfetadas.toLocaleString('pt-BR')} <span class="text-xs text-gray-400 font-normal">UCs Offline</span></div>
          </div>
          ${timeStr ? `<div class="text-[10px] text-gray-500 bg-black/40 px-2 py-1 rounded">Atualizado ${timeStr}</div>` : ''}
        </div>
        <div class="flex-1 overflow-y-auto min-h-0 p-2 custom-scrollbar">
          <div class="flex flex-col gap-1.5">
            ${sorted.map(m => this.renderMunicipioRow(m)).join('')}
          </div>
        </div>
      </div>
    `;
  }

  private renderMunicipioRow(m: CelescMunicipioPayload): string {
    const isWorsening = m.tendenciaDelta === 'PIORANDO';
    const isImproving = m.tendenciaDelta === 'MELHORANDO';

    let trendIcon = '<span class="text-gray-500 font-bold">−</span>';
    if (isWorsening) trendIcon = '<span class="text-red-400 font-bold">↑</span>';
    if (isImproving) trendIcon = '<span class="text-green-400 font-bold">↓</span>';

    const pct = m.porcentagemAfetada.toFixed(1);

    return `
      <div class="flex items-center justify-between p-2 rounded bg-white/5 hover:bg-white/10 transition-colors cursor-pointer group" onclick="window.dispatchEvent(new CustomEvent('map-focus-municipio', { detail: '${m.municipio}' }))">
        <div class="flex flex-col min-w-0">
          <div class="text-sm font-medium text-gray-200 truncate group-hover:text-white transition-colors">
            ${m.municipio}
          </div>
          <div class="text-[10px] text-gray-500 flex items-center gap-1.5 mt-0.5">
            <span>${pct}% da rede</span>
            <span class="w-1 h-1 rounded-full bg-white/20"></span>
            ${trendIcon} ${m.tendenciaDelta}
          </div>
        </div>
        <div class="text-right pl-3 shrink-0">
          <div class="text-sm font-bold text-red-400">
            ${m.ucsAfetadas.toLocaleString('pt-BR')}
          </div>
          <div class="text-[9px] text-gray-500 uppercase tracking-wide">
            UCs
          </div>
        </div>
      </div>
    `;
  }
}
