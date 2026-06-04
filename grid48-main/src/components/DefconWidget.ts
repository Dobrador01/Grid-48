import { Panel } from './Panel';
import type { BeaconSnapshot, DefconStatus } from '@/services/beacon-client';
import { getOrCreateConvexClient } from '@/services/beacon-client';

// ═══════════════════════════════════════════════════════════════════════════
// DefconWidget — heads-up display do estado operacional agregado
// ═══════════════════════════════════════════════════════════════════════════
//
// Subscribe ao snapshot.defcon (vindo de convex/defcon/queries:getDefconStatus
// via beacon-client.ts). Renderiza:
//   - número grande do nível global (1..5) com cor por severidade
//   - 3 pills laterais com nível por categoria (energia / clima / mobilidade)
//   - bloco de explicação Gemini cacheada
//   - footer com "recomputado há X" + última mudança de nível
//
// Convenção militar: 1 = mais crítico (vermelho), 5 = tranquilo (verde).
// ═══════════════════════════════════════════════════════════════════════════

const PULSE_WINDOW_MS = 30_000; // pulse animation por 30s após mudança de nível

const NIVEL_COR: Record<number, string> = {
  1: '#dc2626', // vermelho — crítico
  2: '#ea580c', // laranja escuro — alto
  3: '#eab308', // amarelo — elevado
  4: '#84cc16', // verde-lima — atenção
  5: '#22c55e', // verde — tranquilo
};

const NIVEL_LABEL: Record<number, string> = {
  1: 'CRÍTICO',
  2: 'ALTO',
  3: 'ELEVADO',
  4: 'ATENÇÃO',
  5: 'NORMAL',
};

export class DefconWidget extends Panel {
  private snapshot: BeaconSnapshot = {
    alertas: [],
    health: null,
    defcon: null,
    clima: [],
    trafego: [],
    telemetria: [],
    telemetriaTrack: [],
    connection: { kind: 'connecting' },
  };

  // Estado do botão de refresh manual. `refreshPendingSince` é o timestamp
  // de quando clicamos — usado pra detectar quando o snapshot reativo trouxe
  // uma explicação nova (gerada_em > refreshPendingSince) e desligar o spinner.
  private refreshPendingSince: number | null = null;

  constructor() {
    super({
      id: 'defcon',
      title: 'DEFCON — Estado Operacional',
    });
    this.injectPulseStyles();
    // Click delegation pro botão de refresh (CSP-safe — sem onclick inline).
    this.content.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-defcon-refresh]');
      if (!target) return;
      e.stopPropagation();
      this.handleRefreshClick();
    });
    this.render();
    // Re-render passivo a cada minuto pra manter "há X min" e pulse window vivos.
    window.setInterval(() => this.render(), 60_000);
  }

  private async handleRefreshClick(): Promise<void> {
    if (this.refreshPendingSince !== null) return; // já em andamento
    const client = getOrCreateConvexClient();
    if (!client) {
      console.warn('[DefconWidget] Convex client indisponível, refresh ignorado');
      return;
    }
    this.refreshPendingSince = Date.now();
    this.render();
    try {
      await (client as any).mutation('defcon/mutations:requestExplanationRefresh', {});
    } catch (e) {
      console.error('[DefconWidget] requestExplanationRefresh falhou:', e);
      this.refreshPendingSince = null;
      this.render();
    }
    // Safety net: timeout de 30s caso explainDefcon não complete (chave Gemini
    // ausente, erro silencioso, etc.). Sem isso, spinner ficaria pra sempre.
    window.setTimeout(() => {
      if (this.refreshPendingSince !== null) {
        this.refreshPendingSince = null;
        this.render();
      }
    }, 30_000);
  }

  public setSnapshot(snapshot: BeaconSnapshot) {
    this.snapshot = snapshot;
    // Se estávamos esperando refresh e chegou explicação nova (gerada_em
    // depois do clique), desliga o spinner.
    if (this.refreshPendingSince !== null && snapshot.defcon?.explicacao) {
      if (snapshot.defcon.explicacao.gerada_em > this.refreshPendingSince) {
        this.refreshPendingSince = null;
      }
    }
    this.render();
  }

  public render() {
    this.content.innerHTML = this.renderContent();
  }

  private injectPulseStyles() {
    // Idempotente — só injeta uma vez por documento.
    if (document.getElementById('defcon-pulse-style')) return;
    const style = document.createElement('style');
    style.id = 'defcon-pulse-style';
    style.textContent = `
      @keyframes defcon-pulse {
        0%, 100% { box-shadow: 0 0 0 0 var(--defcon-pulse-color, rgba(220, 38, 38, 0.6)); }
        50% { box-shadow: 0 0 0 12px rgba(0, 0, 0, 0); }
      }
      .defcon-pulse {
        animation: defcon-pulse 1.6s ease-in-out infinite;
      }
      @keyframes defcon-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .defcon-refresh-btn {
        background: transparent;
        border: 1px solid rgba(0,0,0,0.08);
        border-radius: 999px;
        padding: 3px 10px 3px 7px;
        font-size: 0.65rem;
        color: #6b7280;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-family: inherit;
        transition: background 0.15s, border-color 0.15s, color 0.15s;
      }
      .defcon-refresh-btn:hover {
        background: rgba(0,0,0,0.04);
        border-color: rgba(0,0,0,0.18);
        color: #1f2937;
      }
      .defcon-refresh-btn:disabled {
        cursor: wait;
        opacity: 0.7;
      }
      .defcon-refresh-icon {
        display: inline-block;
        font-size: 0.85rem;
        line-height: 1;
      }
      .defcon-refresh-spinning {
        animation: defcon-spin 1s linear infinite;
      }
    `;
    document.head.appendChild(style);
  }

  protected renderContent(): string {
    const { defcon, connection } = this.snapshot;

    if (connection.kind === 'no-config') {
      return this.renderState({
        icon: '⚙',
        color: '#9ca3af',
        title: 'DEFCON offline',
        body: 'VITE_CONVEX_URL ausente no build. Estado operacional indisponível.',
      });
    }

    if (connection.kind === 'disconnected') {
      // Mantém último DEFCON conhecido visível, mas marca como stale.
      if (defcon) return this.renderActive(defcon, /* stale */ true);
      return this.renderState({
        icon: '⏻',
        color: '#ef4444',
        title: 'Sem conexão com o Grid',
        body: `Tentando reconectar ao Convex (${connection.retries} tentativa${connection.retries === 1 ? '' : 's'}).`,
      });
    }

    if (connection.kind === 'connecting' && !defcon) {
      return this.renderState({
        icon: '◌',
        color: '#6b7280',
        title: 'Conectando...',
        body: 'Estabelecendo socket reativo DEFCON.',
      });
    }

    if (!defcon) {
      return this.renderState({
        icon: '⏳',
        color: '#6b7280',
        title: 'Aguardando primeiro recompute',
        body: 'Nenhum sinal foi processado ainda. Injete via dashboard Convex (internal.defcon.dev:injectTestSignal) ou aguarde o próximo ciclo.',
      });
    }

    return this.renderActive(defcon, /* stale */ false);
  }

  private renderState(opts: { icon: string; color: string; title: string; body: string }): string {
    return `
      <div style="padding: 1.25rem; height: 100%; display: flex; flex-direction: column; background: rgba(245, 247, 250, 0.5); backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px); font-family: ui-sans-serif, system-ui, sans-serif;">
        <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 0.5rem; color: #4b5563;">
          <div style="font-size: 1.75rem; color: ${opts.color}; line-height: 1;">${opts.icon}</div>
          <div style="font-size: 0.95rem; font-weight: 700; color: #1f2937;">${opts.title}</div>
          <div style="font-size: 0.8rem; max-width: 22rem;">${opts.body}</div>
        </div>
      </div>
    `;
  }

  private renderActive(defcon: DefconStatus, stale: boolean): string {
    const corPrincipal = NIVEL_COR[defcon.nivel_global] ?? '#6b7280';
    const labelPrincipal = NIVEL_LABEL[defcon.nivel_global] ?? '?';
    const recomputadoStr = this.formatRelative(defcon.recomputado_em);

    // Pulse só se o nível mudou recentemente (evita ficar pulsando pra sempre).
    const desdeUltimaMudanca = Date.now() - defcon.ultima_mudanca_em;
    const pulseAtivo = desdeUltimaMudanca < PULSE_WINDOW_MS;
    const pulseClass = pulseAtivo ? 'defcon-pulse' : '';

    const gaugeSvg = this.renderGaugeSvg(defcon.nivel_global);

    const pills = (['energia', 'clima', 'mobilidade'] as const).map((cat) => {
      const nivel = defcon.niveis_categoria[cat];
      const cor = NIVEL_COR[nivel] ?? '#6b7280';
      return `
        <div style="flex: 1; background: rgba(255,255,255,0.7); border: 1px solid rgba(0,0,0,0.06); border-top: 3px solid ${cor}; border-radius: 8px; padding: 0.55rem 0.4rem; text-align: center; font-family: ui-sans-serif, system-ui, sans-serif;">
          <div style="font-size: 0.6rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;">${this.escapeHtml(cat)}</div>
          <div style="font-size: 1.4rem; font-weight: 800; color: ${cor}; line-height: 1.1; margin-top: 2px;">${nivel}</div>
        </div>
      `;
    }).join('');

    const explicacaoTexto = defcon.explicacao?.texto ?? 'Gerando explicação contextual...';
    const explicacaoStaleHash = defcon.explicacao && defcon.explicacao.inputs_hash !== defcon.inputs_hash;
    const explicacaoIdadeStr = defcon.explicacao
      ? this.formatRelative(defcon.explicacao.gerada_em)
      : null;
    const refreshSpinning = this.refreshPendingSince !== null;
    const refreshBtn = `
      <button
        type="button"
        data-defcon-refresh
        class="defcon-refresh-btn"
        title="Forçar regeneração do texto explicativo (bypass do throttle 30min)"
        ${refreshSpinning ? 'disabled' : ''}
      >
        <span class="defcon-refresh-icon ${refreshSpinning ? 'defcon-refresh-spinning' : ''}">⟳</span>
        <span>${refreshSpinning ? 'atualizando…' : (explicacaoIdadeStr ?? 'atualizar')}</span>
      </button>
    `;

    const transicao = typeof defcon.nivel_anterior === 'number' && defcon.nivel_anterior !== defcon.nivel_global
      ? `<span style="color: #6b7280;">• transição de DEFCON ${defcon.nivel_anterior} → ${defcon.nivel_global}</span>`
      : '';

    // Layout: container raiz com overflow-y: auto. Estratégia simples e
    // robusta — quando o conteúdo total excede a altura do painel, scrolla
    // o widget inteiro. Sticky header em "Sinais Disparadores" mantém o
    // rótulo visível enquanto se rola pela lista.
    return `
      <div style="height: 100%; overflow-y: auto; background: rgba(245, 247, 250, 0.5); backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px); font-family: ui-sans-serif, system-ui, sans-serif;">
        ${stale ? `
          <div style="background: rgba(249, 115, 22, 0.18); border-bottom: 1px solid rgba(249, 115, 22, 0.35); padding: 0.4rem 0.75rem; text-align: center;">
            <span style="font-size: 0.65rem; color: #c2410c; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">⚠ Sem socket — estado pode estar desatualizado</span>
          </div>
        ` : ''}

        <div style="padding: 0.75rem 1.25rem 0.5rem 1.25rem; display: flex; align-items: center; gap: 1rem;">
          <div class="${pulseClass}" style="width: 180px; flex-shrink: 0; ${pulseAtivo ? `--defcon-pulse-color: ${corPrincipal}66;` : ''}">
            ${gaugeSvg}
          </div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 0.7rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;">Estado Atual</div>
            <div style="font-size: 1.25rem; font-weight: 800; color: ${corPrincipal}; letter-spacing: -0.01em;">${labelPrincipal}</div>
            <div style="font-size: 0.7rem; color: #6b7280; margin-top: 4px;">recomputado ${recomputadoStr} ${transicao}</div>
          </div>
        </div>

        <div style="padding: 0 1.25rem 0.75rem 1.25rem; display: flex; gap: 0.5rem;">
          ${pills}
        </div>

        <div style="margin: 0 1.25rem 0.75rem 1.25rem; padding: 0.75rem 0.85rem; background: rgba(255,255,255,0.65); border: 1px solid rgba(0,0,0,0.06); border-radius: 10px; font-size: 0.78rem; color: #374151; line-height: 1.45; ${explicacaoStaleHash ? 'opacity: 0.6;' : ''}">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem;">
            <div style="flex: 1; min-width: 0;">${this.escapeHtml(explicacaoTexto)}</div>
            <div style="flex-shrink: 0;">${refreshBtn}</div>
          </div>
          ${explicacaoStaleHash ? `<div style="font-size: 0.6rem; color: #9ca3af; margin-top: 4px; font-style: italic;">(explicação anterior — nova sendo gerada)</div>` : ''}
        </div>

        ${defcon.sinais_disparadores.length > 0 ? `
          <div style="padding: 0 1.25rem 1rem 1.25rem;">
            <div style="font-size: 0.6rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; margin-bottom: 0.4rem; position: sticky; top: 0; background: rgba(245, 247, 250, 0.95); padding: 6px 0 4px 0; z-index: 1;">Sinais Disparadores</div>
            ${defcon.sinais_disparadores.map((s) => {
              const corCat = NIVEL_COR[defcon.niveis_categoria[s.categoria as 'energia' | 'clima' | 'mobilidade']] ?? '#6b7280';
              const label = s.regra_nome ?? s.evidencia;
              // Mostra evidencia técnica embaixo só se regra_nome existe
              // (senão já tá ali em cima como fallback) — operador vê o
              // detalhe DSL pra debug, mas em fonte menor e cinza.
              const tecnico = s.regra_nome ? `<div style="font-size: 0.62rem; color: #9ca3af; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 2px; word-break: break-all;">${this.escapeHtml(s.evidencia)}</div>` : '';
              return `
              <div style="font-size: 0.72rem; color: #4b5563; padding: 0.4rem 0; border-bottom: 1px dashed rgba(0,0,0,0.06);">
                <div>
                  <span style="font-weight: 600; color: ${corCat};">${this.escapeHtml(s.categoria.toUpperCase())}</span>
                  · ${this.escapeHtml(label)}
                </div>
                ${tecnico}
              </div>
            `;
            }).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Gauge semicircular SVG: 5 quadrantes coloridos (vermelho à direita = crítico,
   * verde à esquerda = tranquilo). O quadrante do nível atual fica em opacity
   * cheia; os outros ficam visíveis mas esmaecidos. Texto "DEFCON" + número
   * grande do nível atual centralizados no "buraco" do anel.
   *
   * Layout:
   *   viewBox 0 0 200 110 — centro em (100, 100), arco entre y=8 (topo) e y=100 (base)
   *   raio externo 92, raio interno 58 (anel de 34px de espessura)
   *   "buraco" do anel = área central de y=42 a y=100, com texto centralizado em y~75
   */
  private renderGaugeSvg(nivelAtual: number): string {
    const cx = 100;
    const cy = 100;
    const rOuter = 92;
    const rInner = 58;
    const gapDeg = 1.5; // separação visual entre quadrantes

    // Mapeamento posicional: nível 5 (verde) à esquerda, nível 1 (vermelho) à direita.
    // Em coords matemáticas (Y invertido p/ SVG): 180° = esquerda, 0° = direita.
    const quadrantes = [5, 4, 3, 2, 1].map((nivel, idx) => {
      const startDeg = 180 - idx * 36 - gapDeg / 2;
      const endDeg = 180 - (idx + 1) * 36 + gapDeg / 2;
      const cor = NIVEL_COR[nivel] ?? '#6b7280';
      const ativo = nivel === nivelAtual;
      // Inativos: opacity 0.32 (visíveis mas claramente "off"). Ativo: 1.
      const opacity = ativo ? 1 : 0.32;
      const path = this.arcPath(cx, cy, rOuter, rInner, startDeg, endDeg);
      return `<path d="${path}" fill="${cor}" opacity="${opacity}" />`;
    }).join('');

    const corCentral = NIVEL_COR[nivelAtual] ?? '#6b7280';

    return `
      <svg viewBox="0 0 200 110" xmlns="http://www.w3.org/2000/svg" style="display: block; width: 100%; height: auto;">
        ${quadrantes}
        <text x="${cx}" y="64" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif"
              font-size="10" font-weight="700" fill="#6b7280" letter-spacing="2">DEFCON</text>
        <text x="${cx}" y="98" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif"
              font-size="34" font-weight="900" fill="${corCentral}">${nivelAtual}</text>
      </svg>
    `;
  }

  /**
   * Constrói o `d` attribute de um path SVG pra um arco-anel (donut slice).
   * Ângulos em graus, convenção: 0 = direita, 90 = topo, 180 = esquerda.
   */
  private arcPath(cx: number, cy: number, rOuter: number, rInner: number, startDeg: number, endDeg: number): string {
    const polar = (r: number, deg: number) => {
      const rad = (deg * Math.PI) / 180;
      return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
    };
    const p1 = polar(rOuter, startDeg);
    const p2 = polar(rOuter, endDeg);
    const p3 = polar(rInner, endDeg);
    const p4 = polar(rInner, startDeg);
    // largeArcFlag: 0 (cada quadrante é < 180°). sweepFlag: 0 = anti-horário pro arco externo.
    const largeArc = Math.abs(startDeg - endDeg) > 180 ? 1 : 0;
    return [
      `M ${p1.x} ${p1.y}`,
      `A ${rOuter} ${rOuter} 0 ${largeArc} 0 ${p2.x} ${p2.y}`,
      `L ${p3.x} ${p3.y}`,
      `A ${rInner} ${rInner} 0 ${largeArc} 1 ${p4.x} ${p4.y}`,
      'Z',
    ].join(' ');
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
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  }
}
