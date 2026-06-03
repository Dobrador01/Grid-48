import { Panel } from './Panel';
import type { BeaconSnapshot, TrafegoRota } from '@/services/beacon-client';
import { getOrCreateConvexClient } from '@/services/beacon-client';
import { haversineDistance } from '@/utils/geo';

// ═══════════════════════════════════════════════════════════════════════════
// TrafegoWidget — On-demand: pede atualizações enquanto montado
// ═══════════════════════════════════════════════════════════════════════════
//
// Estratégia "zero gasto quando ninguém olha":
//   - mount: dispara polling principal (5min) e paralelo (15min)
//   - destroy: clearInterval em ambos → zero requests ao backend
//   - cada poll chama mutation trafego/requestUpdate (com throttle de 5min
//     no backend tb por defesa em profundidade)
//
// Localização (Geolocation API):
//   - Pede permissão UMA VEZ no mount
//   - getCurrentPosition (não watchPosition) pra economizar bateria
//   - Refresh da localização junto com o polling principal
//   - Detecta "estou em" via haversine vs lat/lon de localidades-foco
//     cadastradas em defcon_config (tipo casa/trabalho)
//
// Lógica do display:
//   - local=casa     → mostra "Casa → Trabalho" (rota_id casa_trabalho)
//   - local=trabalho → mostra "Trabalho → Casa" (rota adhoc usando coord atual)
//   - local=fora     → mostra ambas: Localização atual→Casa + Casa→Trabalho
//   - sem geo        → mostra Casa→Trabalho como fallback
//   - Sempre lista pontos paralelos (pontes/BR-101) embaixo
//
// CSP: sem inline handlers, sem onclick HTML. Tudo via addEventListener.
// ═══════════════════════════════════════════════════════════════════════════

const RAIO_DETECCAO_M = 500;
// Se a rota adhoc Localização→Casa voltar distância menor que isso, o user
// está efetivamente em casa mesmo que o haversine tenha falhado por imprecisão
// do Geolocation (enableHighAccuracy=false pode errar 300-500m fácil).
const ADHOC_DIST_EM_CASA_M = 200;
const POLL_PRINCIPAL_MS = 5 * 60 * 1000;
const POLL_PARALELO_MS = 15 * 60 * 1000;
const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,   // não precisa GPS preciso, ahorra bateria
  maximumAge: 60_000,           // aceita posição cacheada até 1min
  timeout: 10_000,
};

type LocalDetectado = "casa" | "trabalho" | "fora" | "indisponivel";

interface GeoPos {
  lat: number;
  lon: number;
  ts: number;
}

export class TrafegoWidget extends Panel {
  private snapshot: BeaconSnapshot = {
    alertas: [],
    health: null,
    defcon: null,
    clima: [],
    trafego: [],
    telemetria: [],
    connection: { kind: 'connecting' },
  };

  private geoPos: GeoPos | null = null;
  private geoStatus: 'pending' | 'granted' | 'denied' | 'unavailable' = 'pending';
  private pollPrincipalId: number | null = null;
  private pollParaleloId: number | null = null;

  constructor() {
    super({
      id: 'trafego',
      title: 'Tráfego — Rotas',
    });
    this.requestGeolocation();
    this.startPolling();
    this.render();
    // Re-render passivo a cada 30s pra atualizar "há X min".
    window.setInterval(() => this.render(), 30_000);
  }

  public destroy() {
    if (this.pollPrincipalId) { window.clearInterval(this.pollPrincipalId); this.pollPrincipalId = null; }
    if (this.pollParaleloId) { window.clearInterval(this.pollParaleloId); this.pollParaleloId = null; }
    super.destroy();
  }

  public setSnapshot(snapshot: BeaconSnapshot) {
    this.snapshot = snapshot;
    this.render();
  }

  public render() {
    this.content.innerHTML = this.renderContent();
  }

  // ── Geolocalização ─────────────────────────────────────────────────────

  private requestGeolocation(): void {
    if (!('geolocation' in navigator)) {
      this.geoStatus = 'unavailable';
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.geoPos = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          ts: Date.now(),
        };
        this.geoStatus = 'granted';
        this.render();
        // Re-pede rotas com a geo fresca (pode ter mudado o "local detectado").
        this.requestPrincipalUpdate();
      },
      (err) => {
        console.warn('[TrafegoWidget] Geolocation denied/failed:', err.message);
        this.geoStatus = err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable';
        this.render();
      },
      GEO_OPTIONS,
    );
  }

  /**
   * Detecta em qual localidade-foco o user está agora baseado em haversine
   * vs lat/lon cadastrados em defcon_config (vindos via snapshot.trafego —
   * cada rota carrega destino lat/lon, que pra rota Casa→Trabalho são as
   * coords da casa e trabalho).
   *
   * Volta "indisponivel" se ainda não tem geo OU se faltam coords casa/trab
   * cadastradas (deveriam vir do defcon_config DEFAULT, mas defensivamente).
   */
  private detectarLocal(): LocalDetectado {
    if (this.geoStatus !== 'granted' || !this.geoPos) return 'indisponivel';
    // Lê coords de casa/trabalho do snapshot.trafego (rota principal
    // casa_trabalho carrega ambas: origem=casa, destino=trabalho).
    const rotaPrincipal = this.snapshot.trafego.find((r) => r.rota_id === 'casa_trabalho');
    if (!rotaPrincipal) {
      // Sem rota principal cadastrada, não dá pra detectar localidades.
      // Defaulta pra "fora" pra mostrar pelo menos algo útil.
      return 'fora';
    }
    const distCasa = haversineDistance(
      this.geoPos.lat, this.geoPos.lon,
      rotaPrincipal.origem_lat, rotaPrincipal.origem_lon,
    );
    if (distCasa < RAIO_DETECCAO_M) return 'casa';
    const distTrabalho = haversineDistance(
      this.geoPos.lat, this.geoPos.lon,
      rotaPrincipal.destino_lat, rotaPrincipal.destino_lon,
    );
    if (distTrabalho < RAIO_DETECCAO_M) return 'trabalho';
    return 'fora';
  }

  // ── Polling ────────────────────────────────────────────────────────────

  private startPolling(): void {
    // Primeira request imediata (não espera 5min pra populhar).
    this.requestPrincipalUpdate();
    this.requestParalelosUpdate();
    this.pollPrincipalId = window.setInterval(() => this.requestPrincipalUpdate(), POLL_PRINCIPAL_MS);
    this.pollParaleloId = window.setInterval(() => this.requestParalelosUpdate(), POLL_PARALELO_MS);
  }

  private async requestPrincipalUpdate(): Promise<void> {
    const client = getOrCreateConvexClient();
    if (!client) return;

    const local = this.detectarLocal();
    const rotas: string[] = [];
    const payload: any = { rotas_solicitadas: rotas };

    if (local === 'casa') {
      rotas.push('casa_trabalho');
    } else if (local === 'trabalho') {
      // De Trabalho pra Casa: usa adhoc com origem=lat/lon atual, destino=casa.
      if (this.geoPos) {
        rotas.push('adhoc_localizacao_atual');
        payload.origem_adhoc = { lat: this.geoPos.lat, lon: this.geoPos.lon };
      }
    } else if (local === 'fora') {
      // Ambas: adhoc até casa + casa→trabalho (ida normal).
      if (this.geoPos) {
        rotas.push('adhoc_localizacao_atual');
        payload.origem_adhoc = { lat: this.geoPos.lat, lon: this.geoPos.lon };
      }
      rotas.push('casa_trabalho');
    } else {
      // Sem geo: fallback default à rota principal.
      rotas.push('casa_trabalho');
    }

    if (rotas.length === 0) return;
    try {
      await (client as any).mutation('trafego/mutations:requestUpdate', payload);
    } catch (e) {
      console.error('[TrafegoWidget] requestPrincipalUpdate falhou:', e);
    }
  }

  private async requestParalelosUpdate(): Promise<void> {
    const client = getOrCreateConvexClient();
    if (!client) return;
    // Passa local_atual pra backend inverter rotas marcadas (BR-101) conforme
    // o contexto do user (em casa: A→B, em trabalho: B→A, senão default).
    const local = this.detectarLocal();
    try {
      await (client as any).mutation('trafego/mutations:requestUpdate', {
        rotas_solicitadas: ['ponte_pedro_ivo', 'ponte_colombo_salles', 'br101_sj_palhoca'],
        local_atual: local === 'indisponivel' ? undefined : local,
      });
    } catch (e) {
      console.error('[TrafegoWidget] requestParalelosUpdate falhou:', e);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  protected renderContent(): string {
    const { connection } = this.snapshot;
    if (connection.kind === 'no-config') {
      return this.renderState('⚙', 'Tráfego offline', 'VITE_CONVEX_URL ausente no build.');
    }

    const detectado = this.detectarLocal();
    const rotasMap = new Map(this.snapshot.trafego.map((r) => [r.rota_id, r]));

    // Belt-and-suspenders: se a detecção por haversine falhou (geo impreciso)
    // mas a rota adhoc→Casa voltou ~0km, o user está em casa de fato.
    let local: LocalDetectado = detectado;
    if (detectado === 'fora') {
      const adhoc = rotasMap.get('adhoc_localizacao_atual');
      if (adhoc && !adhoc.erro && adhoc.distancia_m < ADHOC_DIST_EM_CASA_M) {
        local = 'casa';
      }
    }

    // Decidir quais rotas "principais" mostrar baseado no local detectado.
    const rotasPrincipais: TrafegoRota[] = [];
    if (local === 'casa') {
      const r = rotasMap.get('casa_trabalho');
      if (r) rotasPrincipais.push(r);
    } else if (local === 'trabalho') {
      const r = rotasMap.get('adhoc_localizacao_atual');
      if (r) rotasPrincipais.push(r);
    } else if (local === 'fora') {
      const adhoc = rotasMap.get('adhoc_localizacao_atual');
      const c2t = rotasMap.get('casa_trabalho');
      if (adhoc) rotasPrincipais.push(adhoc);
      if (c2t) rotasPrincipais.push(c2t);
    } else {
      // indisponivel → fallback à casa→trabalho.
      const r = rotasMap.get('casa_trabalho');
      if (r) rotasPrincipais.push(r);
    }

    const paralelas = this.snapshot.trafego.filter((r) => r.rota_tipo === 'paralela');

    return `
      <div style="height: 100%; overflow-y: auto; background: rgba(245, 247, 250, 0.5); backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px); font-family: ui-sans-serif, system-ui, sans-serif; padding: 0.85rem 1rem;">
        ${this.renderHeaderLocal(local)}
        ${rotasPrincipais.length > 0
          ? rotasPrincipais.map((r) => this.renderRotaPrincipal(r)).join('')
          : this.renderSemDados(local)}
        ${paralelas.length > 0 ? `
          <div style="border-top: 1px solid rgba(0,0,0,0.06); margin-top: 10px; padding-top: 8px;">
            <div style="font-size: 0.6rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 4px;">Pontos estratégicos</div>
            ${paralelas.map((r) => this.renderRotaParalela(r)).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  private renderHeaderLocal(local: LocalDetectado): string {
    const labels: Record<LocalDetectado, { icon: string; texto: string; cor: string }> = {
      casa: { icon: '🏠', texto: 'Você está em Casa', cor: '#16a34a' },
      trabalho: { icon: '💼', texto: 'Você está no Trabalho', cor: '#2563eb' },
      fora: { icon: '📍', texto: 'Você está fora das localidades-foco', cor: '#6b7280' },
      indisponivel: {
        icon: this.geoStatus === 'denied' ? '🔒' : '📡',
        texto: this.geoStatus === 'denied'
          ? 'Localização desativada — mostrando rota padrão'
          : 'Aguardando localização…',
        cor: '#9ca3af',
      },
    };
    const l = labels[local];
    return `
      <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 0.72rem; color: ${l.cor}; font-weight: 600;">
        <span style="font-size: 0.9rem;">${l.icon}</span> ${this.escapeHtml(l.texto)}
      </div>
    `;
  }

  private renderRotaPrincipal(r: TrafegoRota): string {
    if (r.erro) {
      return `
        <div style="background: rgba(255,255,255,0.65); border: 1px solid rgba(239,68,68,0.3); border-left: 3px solid #ef4444; border-radius: 10px; padding: 8px 10px; margin-bottom: 6px; font-size: 0.72rem;">
          <div style="font-weight: 700; color: #1f2937;">${this.escapeHtml(r.origem_label)} → ${this.escapeHtml(r.destino_label)}</div>
          <div style="color: #b91c1c; font-size: 0.65rem; margin-top: 2px;">Erro: ${this.escapeHtml(r.erro.substring(0, 100))}</div>
        </div>
      `;
    }
    const cor = this.corStatus(r.status_text);
    const tempoMin = Math.round(r.travel_time_sec / 60);
    const baseMin = Math.round(r.no_traffic_time_sec / 60);
    const distKm = (r.distancia_m / 1000).toFixed(1);
    const pctDiff = r.no_traffic_time_sec > 0
      ? Math.round((r.travel_time_sec / r.no_traffic_time_sec - 1) * 100)
      : 0;
    const pctText = pctDiff > 0 ? `+${pctDiff}%` : `${pctDiff}%`;
    const atualizadoHa = this.formatRelative(r.ts);

    return `
      <div style="background: rgba(255,255,255,0.7); border: 1px solid rgba(0,0,0,0.06); border-left: 3px solid ${cor}; border-radius: 10px; padding: 8px 10px; margin-bottom: 6px;">
        <div style="font-size: 0.72rem; font-weight: 700; color: #1f2937;">${this.escapeHtml(r.origem_label)} → ${this.escapeHtml(r.destino_label)}</div>
        <div style="display: flex; align-items: baseline; gap: 8px; margin-top: 2px;">
          <span style="font-size: 1.05rem; font-weight: 800; color: ${cor};">${tempoMin} min</span>
          <span style="font-size: 0.65rem; color: #6b7280;">base ${baseMin} · ${pctText} · ${distKm} km</span>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px;">
          <span style="font-size: 0.65rem; color: ${cor}; text-transform: uppercase; font-weight: 600; letter-spacing: 0.04em;">${this.escapeHtml(r.status_text)}</span>
          <span style="font-size: 0.6rem; color: #9ca3af;">atualizado ${atualizadoHa}</span>
        </div>
      </div>
    `;
  }

  private renderRotaParalela(r: TrafegoRota): string {
    const cor = this.corStatus(r.status_text);
    const tempoMin = Math.round(r.travel_time_sec / 60);
    const bola = `<span style="display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: ${cor}; box-shadow: 0 0 4px ${cor}80;"></span>`;
    const erroLabel = r.erro ? ' (erro)' : '';
    const label = this.labelParalela(r);
    return `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 0; font-size: 0.7rem; color: #4b5563; border-bottom: 1px dashed rgba(0,0,0,0.05);">
        <span style="display: flex; align-items: center; gap: 6px;">${bola}${this.escapeHtml(label)}${erroLabel}</span>
        <span style="font-size: 0.65rem; color: ${cor}; text-transform: uppercase; font-weight: 600;">${this.escapeHtml(r.erro ? '—' : r.status_text)}${r.erro ? '' : ` · ${tempoMin} min`}</span>
      </div>
    `;
  }

  /**
   * Display name pra rota paralela. Para BR-101 (reversível) deriva o sentido
   * cardinal a partir das lats (origem mais ao norte = "norte → sul"). Pra
   * pontes mantém a label limpa removendo qualificadores entre parênteses.
   */
  private labelParalela(r: TrafegoRota): string {
    if (r.rota_id === 'br101_sj_palhoca') {
      // No SH lat menos negativa = mais ao norte. origem_lat > destino_lat
      // (mais próxima do equador) significa origem ao norte.
      const sentido = r.origem_lat > r.destino_lat ? 'norte → sul' : 'sul → norte';
      return `BR-101 (${sentido})`;
    }
    return r.origem_label.replace(/\s*\((continente|ilha|São José|Palhoça)\)/, '');
  }

  private renderSemDados(local: LocalDetectado): string {
    const msg = local === 'indisponivel' && this.geoStatus === 'denied'
      ? 'Localização desativada e nenhuma rota cacheada. Habilite a permissão de localização ou aguarde o primeiro polling.'
      : 'Aguardando primeiro polling — pode levar alguns segundos…';
    return `
      <div style="background: rgba(255,255,255,0.6); border-radius: 8px; padding: 12px; font-size: 0.75rem; color: #6b7280; text-align: center;">
        ${msg}
      </div>
    `;
  }

  private renderState(icon: string, title: string, body: string): string {
    return `
      <div style="padding: 1.25rem; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 0.5rem; color: #4b5563; background: rgba(245, 247, 250, 0.5); backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px); font-family: ui-sans-serif, system-ui, sans-serif;">
        <div style="font-size: 1.75rem; line-height: 1;">${icon}</div>
        <div style="font-size: 0.95rem; font-weight: 700; color: #1f2937;">${title}</div>
        <div style="font-size: 0.8rem; max-width: 22rem;">${body}</div>
      </div>
    `;
  }

  /**
   * Mapeia status_text textual pra cor de acento (verde/amarelo/laranja/vermelho).
   * Mesmo critério usado pelo backend em trafego/actions.ts:statusText.
   */
  private corStatus(status: string): string {
    switch (status) {
      case 'fluindo':       return '#16a34a';
      case 'lento':          return '#eab308';
      case 'congestionado': return '#f97316';
      case 'parado':         return '#dc2626';
      case 'erro':           return '#9ca3af';
      default:               return '#6b7280';
    }
  }

  private formatRelative(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 0) return 'agora';
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `há ${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `há ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `há ${h}h`;
    return `há ${Math.floor(h / 24)}d`;
  }

  private escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  }
}
