import { Panel } from './Panel';
import type { CelescMunicipioPayload } from '@/types/celesc';

export class CelescStatusWidget extends Panel {
  private outages: CelescMunicipioPayload[] = [];
  private lastUpdate: string = '';

  constructor() {
    super({
      id: 'celesc-status',
      title: 'Celesc — Instabilidades',
    });
    this.render();
  }

  public render() {
    this.content.innerHTML = this.renderContent();
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

    let isStale = false;
    let timeStr = '';
    if (this.lastUpdate) {
      // Parse DD/MM/YYYY HH:mm
      const parts = this.lastUpdate.split(/[\/\s:]/);
      if (parts.length >= 5) {
        const [day, month, year, hour, minute] = parts;
        const parsedDate = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
        const diff = Date.now() - parsedDate.getTime();
        if (diff > 1800000) {
          isStale = true;
        }
        timeStr = parsedDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      } else {
        // Fallback for unexpected formats
        timeStr = new Date(this.lastUpdate).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const diff = Date.now() - new Date(this.lastUpdate).getTime();
        if (diff > 1800000) isStale = true;
      }
    }

    const WATCHLIST = ["FLORIANOPOLIS", "SAO JOSE", "PALHOCA", "BIGUACU"];
    
    // Watchlist elements (sorted by pre-defined order, always shown)
    const listaWatchlist = this.outages.filter(o => WATCHLIST.includes(o.municipio));
    listaWatchlist.sort((a, b) => WATCHLIST.indexOf(a.municipio) - WATCHLIST.indexOf(b.municipio));
    
    // General list (omitting 0 and WATCHLIST elements, sorted by UCs)
    const listaGeral = this.outages.filter(o => !WATCHLIST.includes(o.municipio) && o.ucsAfetadas > 0);
    // Sort by most affected
    listaGeral.sort((a, b) => b.ucsAfetadas - a.ucsAfetadas);

    const totalAfetadas = this.outages.reduce((sum, item) => sum + item.ucsAfetadas, 0);

    return `
      <div class="flex flex-col h-full bg-panel">
        ${isStale ? `
        <div class="bg-orange-500/20 border-b border-orange-500/30 px-3 py-1.5 flex items-center justify-center gap-2">
          <svg class="w-3.5 h-3.5 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
          <span class="text-[10px] text-orange-400 font-medium uppercase tracking-wider">Dados Desatualizados</span>
        </div>` : ''}
        <div class="p-3 border-b border-white/5 flex justify-between items-center bg-red-500/10">
          <div>
            <div class="text-xs uppercase tracking-wider text-red-400 font-bold mb-0.5">Alertas Ativos</div>
            <div class="text-xl font-medium text-white">${totalAfetadas.toLocaleString('pt-BR')} <span class="text-xs text-gray-400 font-normal">UCs Offline</span></div>
          </div>
          ${timeStr ? `<div class="text-[10px] ${isStale ? 'text-orange-400 bg-orange-500/10' : 'text-gray-500 bg-black/40'} px-2 py-1 rounded">Atualizado ${timeStr}</div>` : ''}
        </div>
        <div class="flex-1 overflow-y-auto min-h-0 p-2 custom-scrollbar">
          <div class="flex flex-col gap-1.5">
            <div class="text-[10px] uppercase tracking-wider text-gray-500 px-1 pt-1 pb-0.5 font-medium flex items-center gap-1.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"></path></svg>Grande Florianópolis</div>
            ${listaWatchlist.map(m => this.renderMunicipioRow(m, true)).join('')}
            ${listaGeral.length > 0 ? `
              <div class="text-[10px] uppercase tracking-wider text-gray-500 px-1 pt-3 pb-0.5 font-medium mt-1 border-t border-white/5">Demais Regiões</div>
              ${listaGeral.slice(0, 10).map(m => this.renderMunicipioRow(m, false)).join('')}
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }

  private renderMunicipioRow(m: CelescMunicipioPayload, isWatchlist: boolean): string {
    const isWorsening = m.tendenciaDelta === 'PIORANDO';
    const isImproving = m.tendenciaDelta === 'MELHORANDO';

    let trendIcon = '<span class="text-gray-500 font-bold">−</span>';
    if (isWorsening) trendIcon = '<span class="text-red-400 font-bold">↑</span>';
    if (isImproving) trendIcon = '<span class="text-green-400 font-bold">↓</span>';

    const pct = m.porcentagemAfetada.toFixed(1);

    const wrapperClass = isWatchlist 
      ? 'flex items-center justify-between p-2 bg-gradient-to-r from-blue-500/10 to-transparent border-l-2 border-blue-500 hover:bg-white/10 transition-colors cursor-pointer group'
      : 'flex items-center justify-between p-2 rounded bg-white/5 hover:bg-white/10 transition-colors cursor-pointer group';

    return `
      <div class="${wrapperClass}" onclick="window.dispatchEvent(new CustomEvent('map-focus-municipio', { detail: '${m.municipio}' }))">
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
