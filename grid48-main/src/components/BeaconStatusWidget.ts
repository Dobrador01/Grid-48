import { Panel } from './Panel';
import type { BeaconAlert, BeaconSnapshot } from '@/services/beacon-client';

const STALE_THRESHOLD_MS = 20 * 60 * 1000;

// CSS injetado uma única vez por documento — substitui os antigos
// onmouseenter/onmouseleave inline, que eram bloqueados pelo CSP da Vercel
// (Cloudflare/Vercel sem 'unsafe-inline' nem 'unsafe-hashes' pra script-src).
const STYLE_ID = 'beacon-alert-card-style';
function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .beacon-alert-card {
      cursor: pointer;
      transition: transform 0.2s;
    }
    .beacon-alert-card:hover {
      transform: translateY(-2px);
    }
  `;
  document.head.appendChild(style);
}

export class BeaconStatusWidget extends Panel {
  private snapshot: BeaconSnapshot = {
    alertas: [],
    health: null,
    defcon: null,
    clima: [],
    trafego: [],
    telemetria: [],
    connection: { kind: 'connecting' },
  };

  constructor() {
    super({
      id: 'beacon-status',
      title: 'OSINT — Meteorologia',
    });
    injectStyles();
    // Event delegation: cards têm classe .beacon-alert-card + data-cod-ibge.
    // Substitui o antigo onclick="..." inline (bloqueado pelo CSP).
    this.content.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.beacon-alert-card');
      if (!card) return;
      const ibge = Number(card.dataset.codIbge ?? '0');
      if (!Number.isFinite(ibge) || ibge === 0) return;
      window.dispatchEvent(new CustomEvent('CELESC_CITY_SELECTED', {
        detail: { codIbge: ibge },
        bubbles: true,
      }));
    });
    this.render();
    // Re-render passivo a cada minuto para manter "há X min" e flag de stale vivos
    window.setInterval(() => this.render(), 60_000);
  }

  public setSnapshot(snapshot: BeaconSnapshot) {
    this.snapshot = snapshot;
    this.render();
  }

  public render() {
    this.content.innerHTML = this.renderContent();
  }

  protected renderContent(): string {
    const { alertas, health, connection } = this.snapshot;

    if (connection.kind === 'no-config') {
      return this.renderState({
        icon: '⚙',
        color: '#9ca3af',
        title: 'Beacon não configurado',
        body: 'VITE_CONVEX_URL ausente no build. Pub-Sub OSINT desligado.',
      });
    }

    if (connection.kind === 'disconnected') {
      return this.renderState({
        icon: '⏻',
        color: '#ef4444',
        title: 'Sem conexão com o Grid',
        body: `Tentando reconectar ao Convex (${connection.retries} tentativa${connection.retries === 1 ? '' : 's'}).`,
      });
    }

    if (connection.kind === 'connecting' && !health) {
      return this.renderState({
        icon: '◌',
        color: '#6b7280',
        title: 'Conectando...',
        body: 'Estabelecendo socket reativo.',
      });
    }

    if (alertas.length === 0) {
      if (!health) {
        return this.renderState({
          icon: '⏳',
          color: '#6b7280',
          title: 'Aguardando primeira sincronização',
          body: 'O ingestor da Defesa Civil ainda não rodou neste deploy.',
          footer: this.renderHealthFooter(),
        });
      }
      return this.renderState({
        icon: '✓',
        color: '#22c55e',
        title: 'Sem ameaças ativas',
        body: 'Defesa Civil de SC não publicou alertas dentro da janela de 6h.',
        footer: this.renderHealthFooter(),
      });
    }

    return this.renderActive(alertas);
  }

  private renderState(opts: { icon: string; color: string; title: string; body: string; footer?: string }): string {
    return `
      <div style="padding: 1.25rem; height: 100%; display: flex; flex-direction: column; background: rgba(245, 247, 250, 0.5); backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px); font-family: ui-sans-serif, system-ui, sans-serif;">
        <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 0.5rem; color: #4b5563;">
          <div style="font-size: 1.75rem; color: ${opts.color}; line-height: 1;">${opts.icon}</div>
          <div style="font-size: 0.95rem; font-weight: 700; color: #1f2937;">${opts.title}</div>
          <div style="font-size: 0.8rem; max-width: 22rem;">${opts.body}</div>
        </div>
        ${opts.footer ?? ''}
      </div>
    `;
  }

  private renderHealthFooter(): string {
    const { health } = this.snapshot;
    if (!health) return '';

    const lastRunStr = this.formatRelative(health.lastRunAt);
    const isStale = Date.now() - health.lastRunAt > STALE_THRESHOLD_MS;
    const errorBadge = health.lastError
      ? `<span style="background: #fee2e2; color: #b91c1c; padding: 2px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: 600;">ERRO</span>`
      : '';
    const staleBadge = isStale
      ? `<span style="background: #ffedd5; color: #c2410c; padding: 2px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: 600;">DESATUALIZADO</span>`
      : '';

    return `
      <div style="border-top: 1px solid rgba(0,0,0,0.06); margin-top: 1rem; padding-top: 0.75rem; display: flex; justify-content: space-between; align-items: center; font-size: 0.7rem; color: #6b7280;">
        <span>Última verificação ${lastRunStr}</span>
        <span style="display: flex; gap: 0.35rem;">${errorBadge}${staleBadge}</span>
      </div>
    `;
  }

  private renderActive(alertas: BeaconAlert[]): string {
    const { health } = this.snapshot;
    const isStale = health ? Date.now() - health.lastRunAt > STALE_THRESHOLD_MS : false;
    const lastRunStr = health ? this.formatRelative(health.lastRunAt) : '';
    const totalCidades = new Set(alertas.flatMap(a => a.cidades_afetadas_ibge)).size;

    const cards = alertas.map(al => {
      const color = al.nivel_risco === 'Alto' ? '#ef4444' : (al.nivel_risco === 'Medio' ? '#f97316' : '#eab308');
      const bg = 'rgba(255, 255, 255, 0.65)';
      const ibgeFoco = al.cidades_afetadas_ibge[0] || 0;
      const ativoHa = al.firstSeenAt ? this.formatRelative(al.firstSeenAt) : '';

      return `
        <div class="beacon-alert-card" data-cod-ibge="${ibgeFoco}" style="background: ${bg}; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border: 1px solid rgba(255,255,255,0.4); border-left: 4px solid ${color}; border-radius: 12px; margin-bottom: 0.85rem; padding: 1rem; box-shadow: 0 4px 15px rgba(0,0,0,0.05), inset 0 2px 4px rgba(255,255,255,0.4);">
          <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem; font-weight: 700; color: #111827; font-family: ui-sans-serif, system-ui, sans-serif;">${this.escapeHtml(al.titulo)}</h4>
          <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; font-size: 0.75rem; font-family: ui-sans-serif, system-ui, sans-serif;">
            <span style="background: ${color}; color: white; padding: 3px 8px; border-radius: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; box-shadow: 0 2px 4px ${color}40;">${al.nivel_risco}</span>
            <span style="color: #4b5563; font-weight: 500;">${al.cidades_afetadas_ibge.length} cidade${al.cidades_afetadas_ibge.length === 1 ? '' : 's'}</span>
            ${ativoHa ? `<span style="color: #6b7280;">• ativo ${ativoHa}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');

    return `
      <div style="height: 100%; display: flex; flex-direction: column; background: rgba(245, 247, 250, 0.5); backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px);">
        ${isStale ? `
          <div style="background: rgba(249, 115, 22, 0.18); border-bottom: 1px solid rgba(249, 115, 22, 0.35); padding: 0.4rem 0.75rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
            <span style="font-size: 0.65rem; color: #c2410c; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">⚠ Dados Desatualizados — última verificação ${lastRunStr}</span>
          </div>
        ` : ''}
        <div style="padding: 1.25rem 1.25rem 0.5rem 1.25rem;">
          <div style="display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid rgba(255,255,255,0.6); padding-bottom: 0.75rem; margin-bottom: 0.75rem;">
            <h3 style="color: #1f2937; margin: 0; font-size: 1.05rem; font-weight: 800; font-family: ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.02em;">
              Radar OSINT: Defesa Civil
            </h3>
            ${lastRunStr ? `<span style="font-size: 0.7rem; color: #6b7280;">${lastRunStr}</span>` : ''}
          </div>
          <div style="font-size: 0.75rem; color: #4b5563; margin-bottom: 0.5rem;">
            ${alertas.length} alerta${alertas.length === 1 ? '' : 's'} · ${totalCidades} cidade${totalCidades === 1 ? '' : 's'} afetada${totalCidades === 1 ? '' : 's'}
          </div>
        </div>
        <div style="flex: 1; overflow-y: auto; padding: 0 1.25rem 1.25rem 1.25rem;">
          ${cards}
        </div>
      </div>
    `;
  }

  private formatRelative(ts: number): string {
    const diffMs = Date.now() - ts;
    if (diffMs < 0) return 'agora';
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return `há ${min} min`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `há ${hours}h`;
    const days = Math.floor(hours / 24);
    return `há ${days}d`;
  }

  private escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  }
}
