import { Panel } from './Panel';
import type { BeaconSnapshot } from '@/services/beacon-client';

// ═══════════════════════════════════════════════════════════════════════════
// EnergiaBackupWidget — card da energia de backup (EcoFlow Delta 3)
// ═══════════════════════════════════════════════════════════════════════════
//
// Consome snapshot.energiaBackup.state (poll Convex a cada 1min, sem hardware).
// Import estático (registrado em panel-layout). Estilo injetado 1x no head;
// event-free (só render). Sem gráfico de tensão (a pedido) — só o número.
// ═══════════════════════════════════════════════════════════════════════════

const STALE_MS = 3 * 60 * 1000; // sem leitura fresca há > 3min = sem comunicação

interface EnergiaState {
  soc_pct: number;
  watts_in: number;
  watts_out: number;
  ac_in_vol?: number;
  rede_ativa: boolean;
  temp_bateria?: number;
  temp_mos?: number;
  estado?: string;
  atualizado_em: number;
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) };
}

// Arco semicircular (sempre sentido horário left→right sobre o topo).
function arc(cx: number, cy: number, r: number, a1: number, a2: number): string {
  const p1 = polar(cx, cy, r, a1);
  const p2 = polar(cx, cy, r, a2);
  const large = Math.abs(a1 - a2) > 180 ? 1 : 0;
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
}

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'agora';
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  return `há ${Math.round(m / 60)} h`;
}

let styleInjected = false;
function injectStyleOnce(): void {
  if (styleInjected || typeof document === 'undefined') return;
  styleInjected = true;
  const s = document.createElement('style');
  s.textContent = `
.eb-head{display:flex;justify-content:space-between;align-items:center;font-size:11px;margin-bottom:2px;}
.eb-dot{width:10px;height:10px;border-radius:50%;display:inline-block;}
.eb-on{background:#22c55e;box-shadow:0 0 6px #22c55e;}
.eb-off{background:#9ca3af;}
.eb-alert{background:#ef4444;box-shadow:0 0 7px #ef4444;}
.eb-status{opacity:.7;margin-left:6px;text-transform:uppercase;letter-spacing:.5px;font-size:10px;}
.eb-upd{opacity:.55;}
.eb-gauge{position:relative;text-align:center;}
.eb-gauge svg{width:100%;max-width:210px;height:auto;}
.eb-arc-bg{fill:none;stroke:rgba(148,163,184,.22);stroke-width:13;stroke-linecap:round;}
.eb-arc{fill:none;stroke-width:13;stroke-linecap:round;transition:stroke .3s;}
.eb-chg{stroke:#22c55e;}.eb-dsg{stroke:#f59e0b;}.eb-idle{stroke:#38bdf8;}
.eb-soc{position:absolute;left:0;right:0;bottom:4px;line-height:1;}
.eb-soc-num{font-size:32px;font-weight:700;}
.eb-soc-pct{font-size:13px;opacity:.55;margin-left:2px;}
.eb-row{display:flex;gap:8px;margin-top:8px;}
.eb-cell{flex:1;text-align:center;background:rgba(148,163,184,.09);border-radius:8px;padding:6px 4px;}
.eb-lab{font-size:10px;opacity:.6;}
.eb-val{font-size:15px;font-weight:600;margin-top:2px;}
.eb-in{color:#22c55e;}.eb-out{color:#f59e0b;}
.eb-empty{opacity:.5;text-align:center;padding:22px 0;font-size:12px;}`;
  document.head.appendChild(s);
}

export class EnergiaBackupWidget extends Panel {
  private state: EnergiaState | null = null;

  constructor() {
    super({ id: 'energia-backup', title: 'Energia — Delta 3' });
    injectStyleOnce();
    // Re-render periódico pra manter o "há XX min" fresco entre snapshots.
    setInterval(() => this.render(), 20_000);
    this.render();
  }

  public setSnapshot(snapshot: BeaconSnapshot): void {
    const eb = (snapshot as unknown as { energiaBackup?: { state?: EnergiaState | null } }).energiaBackup;
    this.state = eb?.state ?? null;
    this.render();
  }

  private render(): void {
    const st = this.state;
    if (!st) {
      this.content.innerHTML = `<div class="eb-empty">Aguardando dados do Delta 3…</div>`;
      return;
    }

    const stale = Date.now() - st.atualizado_em > STALE_MS;
    let dotCls = 'eb-on';
    let statusTxt = 'online';
    if (stale) {
      dotCls = 'eb-off';
      statusTxt = 'sem comunicação';
    } else if (!st.rede_ativa) {
      dotCls = 'eb-alert';
      statusTxt = 'queda de energia';
    }

    const estado = st.estado ?? 'idle';
    const gaugeCls = estado === 'carregando' ? 'eb-chg' : estado === 'descarregando' ? 'eb-dsg' : 'eb-idle';
    const f = Math.max(0, Math.min(100, st.soc_pct)) / 100;
    const cx = 105;
    const cy = 95;
    const r = 82;
    const bg = arc(cx, cy, r, 180, 0);
    const val = f > 0 ? arc(cx, cy, r, 180, 180 - f * 180) : '';

    const vol = st.ac_in_vol != null ? `${Math.round(st.ac_in_vol)} V` : '—';
    const tb = st.temp_bateria != null ? `${Math.round(st.temp_bateria)}°C` : '—';
    const ti = st.temp_mos != null ? `${Math.round(st.temp_mos)}°C` : '—';

    this.content.innerHTML = `
      <div class="eb-head">
        <span><span class="eb-dot ${dotCls}"></span><span class="eb-status">${statusTxt}</span></span>
        <span class="eb-upd">${relTime(st.atualizado_em)}</span>
      </div>
      <div class="eb-gauge">
        <svg viewBox="0 0 210 112" role="img" aria-label="SoC ${st.soc_pct.toFixed(1)}%">
          <path d="${bg}" class="eb-arc-bg"/>
          ${val ? `<path d="${val}" class="eb-arc ${gaugeCls}"/>` : ''}
        </svg>
        <div class="eb-soc"><span class="eb-soc-num">${st.soc_pct.toFixed(1)}</span><span class="eb-soc-pct">%</span></div>
      </div>
      <div class="eb-row">
        <div class="eb-cell"><div class="eb-lab">Entrada</div><div class="eb-val eb-in">${Math.round(st.watts_in)} W</div></div>
        <div class="eb-cell"><div class="eb-lab">Saída</div><div class="eb-val eb-out">${Math.round(st.watts_out)} W</div></div>
      </div>
      <div class="eb-row">
        <div class="eb-cell"><div class="eb-lab">Tensão rede</div><div class="eb-val">${vol}</div></div>
        <div class="eb-cell"><div class="eb-lab">Temp. bateria</div><div class="eb-val">${tb}</div></div>
        <div class="eb-cell"><div class="eb-lab">Temp. inversor</div><div class="eb-val">${ti}</div></div>
      </div>`;
  }
}
