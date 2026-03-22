import { Panel } from './Panel';
import type { CelescMunicipioPayload } from '@/types/celesc';
import { parseCelescTimestamp } from '@/services/celesc';

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
    console.log("[Widget] Atualizando UI com dados:", outages.length, outages);
    this.outages = outages;
    this.lastUpdate = lastUpdate;
    this.render();
  }

  protected renderContent(): string {
    if (this.outages.length === 0) {
      return `
        <div class="p-4 flex flex-col items-center justify-center text-gray-500 h-full">
          <p class="text-sm">Buscando dados Celesc...</p>
        </div>
      `;
    }

    let isStale = false;
    let timeStr = '';
    if (this.lastUpdate) {
      const timestamp = parseCelescTimestamp(this.lastUpdate);
      const parsedDate = new Date(timestamp);
      const diff = Date.now() - timestamp;
      
      if (diff > 1800000) {
        isStale = true;
      }
      
      timeStr = parsedDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }

    const WATCHLIST = ["FLORIANOPOLIS", "SAO JOSE", "PALHOCA", "BIGUACU"];
    
    // Watchlist elements (sorted by pre-defined order, always shown)
    const listaWatchlist = this.outages.filter(o => WATCHLIST.includes(o.nome));
    listaWatchlist.sort((a, b) => WATCHLIST.indexOf(a.nome) - WATCHLIST.indexOf(b.nome));
    
    // General list (omitting 0 and WATCHLIST elements, sorted by UCs)
    const listaGeral = this.outages.filter(o => !WATCHLIST.includes(o.nome) && o.ucsAfetadas > 0);
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
          <div class="flex flex-col gap-0">
            <div class="text-[10px] uppercase tracking-wider text-gray-500 px-1 pt-1 pb-1 font-medium">Grande Florianópolis</div>
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
    const bgClass = isWatchlist ? 'bg-blue-500/10' : '';
    
    const bairrosHtml = m.bairros && m.bairros.length > 0 
      ? m.bairros.map(b => `
          <div class="flex justify-between py-0.5">
            <span>${b.nome}</span>
            <span class="${b.ucsAfetadas > 0 ? 'text-orange-400' : ''}">${b.ucsAfetadas}</span>
          </div>
        `).join('')
      : '<span>Sem dados de bairros</span>';

    return `
      <div class="${bgClass}">
        <div class="flex justify-between items-center py-2 px-1 border-b border-gray-800 hover:bg-white/5 cursor-pointer font-mono text-xs" 
             onclick="this.nextElementSibling.classList.toggle('hidden'); window.dispatchEvent(new CustomEvent('map-focus-municipio', { detail: '${m.nome}' }));">
          <span class="text-gray-400 uppercase w-1/3 truncate">${m.nome}</span>
          <span class="text-gray-500 w-1/3 text-center">${m.pct.toFixed(2)}% ${m.tendencia}</span>
          <span class="${m.ucsAfetadas > 0 ? 'text-red-500' : 'text-gray-600'} w-1/3 text-right">${m.ucsAfetadas} UCs</span>
        </div>
        <div class="hidden bg-black/20 p-2 text-[10px] text-gray-500">
          ${bairrosHtml}
        </div>
      </div>
    `;
  }
}
