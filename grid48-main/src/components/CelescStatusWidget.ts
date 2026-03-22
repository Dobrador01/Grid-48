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
      <div class="celesc-widget-container">
        ${isStale ? `
        <div class="bg-orange-500/20 border-b border-orange-500/30 px-3 py-1.5 flex items-center justify-center gap-2">
          <svg class="w-3.5 h-3.5 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
          <span class="text-[10px] text-orange-400 font-medium uppercase tracking-wider">Dados Desatualizados</span>
        </div>` : ''}
        <div class="celesc-header">
          <div>
            <div class="celesc-header-title">Alertas Ativos</div>
            <div class="celesc-header-count">${totalAfetadas.toLocaleString('pt-BR')} <span class="celesc-header-count-label">UCs Offline</span></div>
          </div>
          ${timeStr ? `<div class="celesc-header-time">Atualizado ${timeStr}</div>` : ''}
        </div>
        <div class="celesc-list-container custom-scrollbar">
          <div class="celesc-section-title" style="margin-top: 0;">Grande Florianópolis</div>
          ${listaWatchlist.map(m => this.renderMunicipioRow(m, true)).join('')}
          ${listaGeral.length > 0 ? `
            <div class="celesc-section-title" style="border-top: 1px solid var(--overlay-light); margin-top: 8px;">Demais Regiões</div>
            ${listaGeral.slice(0, 10).map(m => this.renderMunicipioRow(m, false)).join('')}
          ` : ''}
        </div>
      </div>
    `;
  }

  private renderMunicipioRow(m: CelescMunicipioPayload, isWatchlist: boolean): string {
    const bgClass = isWatchlist ? 'celesc-watchlist-row' : '';
    
    const bairrosHtml = m.bairros && m.bairros.length > 0 
      ? m.bairros.map(b => `
          <div class="celesc-bairro-row">
            <span>${b.nome}</span>
            <span class="${b.ucsAfetadas > 0 ? 'celesc-bairro-alert' : ''}">${b.ucsAfetadas}</span>
          </div>
        `).join('')
      : '<span>Sem dados de bairros</span>';

    return `
      <div>
        <div class="celesc-row ${bgClass}" 
             onclick="this.nextElementSibling.classList.toggle('hidden'); window.dispatchEvent(new CustomEvent('map-focus-municipio', { detail: '${m.nome}' }));">
          <span class="celesc-col-left" title="${m.nome}">${m.nome}</span>
          <span class="celesc-col-center">
            <span class="celesc-col-center-val">${m.pct.toFixed(2)}%</span> ${m.tendencia}
          </span>
          <span class="celesc-col-right ${m.ucsAfetadas > 0 ? 'celesc-alert' : 'celesc-stable'}">${m.ucsAfetadas.toLocaleString('pt-BR')} UCs</span>
        </div>
        <div class="hidden celesc-bairros">
          ${bairrosHtml}
        </div>
      </div>
    `;
  }
}
