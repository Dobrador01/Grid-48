import { Panel } from './Panel';
import type { BeaconSnapshot } from '@/services/beacon-client';

// ═══════════════════════════════════════════════════════════════════════════
// EnergiaBackupWidget — card da energia de backup (EcoFlow Delta 3)
// ═══════════════════════════════════════════════════════════════════════════
//
// Consome snapshot.energiaBackup.state (poll Convex a cada 1min, sem hardware).
// Import estático (registrado em panel-layout). Render-only (sem eventos).
//
// Visual alinhado à identidade dos demais cards (ver ClimaWidget): glass claro
// (rgba(245,247,250,.5) + blur), tipografia ui-sans-serif, paleta cinza
// (#1f2937/#4b5563/#6b7280/#9ca3af) + acentos (verde/âmbar/azul), seções com
// divisória sutil e cabeçalho 0.6rem uppercase.
//
//   ┌─────────────────────────────────┐
//   │ ● online            ⟳ há 1 min   │
//   │        [gauge SoC]               │
//   │          86.2 %                  │
//   │        ● ocioso                  │
//   │  ┌ Entrada ┐  ┌ Saída ┐          │
//   │  │  0 W    │  │  12 W │          │
//   │  AUTONOMIA                       │
//   │  [▓▓▓▓▓▓░░]  ~57h 20m            │
//   │  Tensão · Temp bat · Temp inv    │
//   └─────────────────────────────────┘
// ═══════════════════════════════════════════════════════════════════════════

const STALE_MS = 3 * 60 * 1000; // sem leitura fresca há > 3min = sem comunicação

interface EnergiaState {
  soc_pct: number;
  watts_in: number;
  watts_out: number;
  ac_in_vol?: number;
  ac_in_freq?: number;
  rede_ativa: boolean;
  autonomia_min?: number;
  temp_bateria?: number;
  temp_mos?: number;
  soh_pct?: number;
  estado?: string;
  reserva_backup_pct?: number;
  atualizado_em: number;
}

// Cor de acento por estado operacional.
const COR_ESTADO: Record<string, string> = {
  carregando: '#22c55e',
  descarregando: '#f59e0b',
  idle: '#38bdf8',
};
const LABEL_ESTADO: Record<string, string> = {
  carregando: 'carregando',
  descarregando: 'descarregando',
  idle: 'ocioso',
};

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

// Minutos → "Xh Ym" / "Ym". null se ausente/zero.
function fmtDur(min: number | undefined): string | null {
  if (min == null || !Number.isFinite(min) || min <= 0) return null;
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r > 0 ? `${h}h ${r}m` : `${h}h`;
}

export class EnergiaBackupWidget extends Panel {
  private state: EnergiaState | null = null;

  constructor() {
    super({ id: 'energia-backup', title: 'Energia — Delta 3' });
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
    const wrap = (inner: string) =>
      `<div style="padding:0.85rem 1rem;height:100%;background:rgba(245,247,250,0.5);backdrop-filter:blur(25px);-webkit-backdrop-filter:blur(25px);font-family:ui-sans-serif,system-ui,sans-serif;overflow-y:auto;">${inner}</div>`;

    if (!st) {
      this.content.innerHTML = wrap(
        `<div style="text-align:center;color:#9ca3af;padding:26px 0;font-size:0.8rem;">Aguardando dados do Delta 3…</div>`,
      );
      return;
    }

    // ── Status (dot + rótulo) ────────────────────────────────────────────────
    const stale = Date.now() - st.atualizado_em > STALE_MS;
    let dotColor = '#22c55e';
    let statusTxt = 'online';
    let glow = '0 0 6px #22c55e';
    if (stale) {
      dotColor = '#9ca3af';
      statusTxt = 'sem comunicação';
      glow = 'none';
    } else if (!st.rede_ativa) {
      dotColor = '#ef4444';
      statusTxt = 'queda de energia';
      glow = '0 0 7px #ef4444';
    }

    const estado = st.estado ?? 'idle';
    const cor = COR_ESTADO[estado] ?? '#38bdf8';
    const labelEstado = LABEL_ESTADO[estado] ?? estado;

    // ── Gauge SoC (semicírculo) ──────────────────────────────────────────────
    const f = Math.max(0, Math.min(100, st.soc_pct)) / 100;
    const cx = 105, cy = 95, r = 82;
    const bg = arc(cx, cy, r, 180, 0);
    const val = f > 0 ? arc(cx, cy, r, 180, 180 - f * 180) : '';

    // ── Autonomia (barra tipo bateria + tempo) ───────────────────────────────
    const auton = fmtDur(st.autonomia_min);
    const autonLabel =
      estado === 'carregando'
        ? (auton ? `carga cheia em ~${auton}` : 'carregando')
        : (auton ? `~${auton} restantes` : 'estimando…');
    const battery = this.renderBattery(f, cor);

    // ── Métricas ─────────────────────────────────────────────────────────────
    const vol = st.ac_in_vol != null ? `${Math.round(st.ac_in_vol)} V` : '—';
    const tb = st.temp_bateria != null ? `${Math.round(st.temp_bateria)}°C` : '—';
    const ti = st.temp_mos != null ? `${Math.round(st.temp_mos)}°C` : '—';

    const secHead = (txt: string) =>
      `<div style="font-size:0.6rem;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:5px;">${txt}</div>`;
    const cell = (lab: string, valHtml: string) =>
      `<div style="flex:1;text-align:center;background:rgba(148,163,184,0.1);border-radius:8px;padding:6px 4px;">
         <div style="font-size:0.62rem;color:#6b7280;">${lab}</div>
         <div style="font-size:0.95rem;font-weight:600;color:#1f2937;margin-top:2px;">${valHtml}</div>
       </div>`;

    this.content.innerHTML = wrap(`
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.72rem;margin-bottom:2px;">
        <span style="display:flex;align-items:center;gap:6px;">
          <span style="width:9px;height:9px;border-radius:50%;background:${dotColor};box-shadow:${glow};display:inline-block;"></span>
          <span style="color:#4b5563;text-transform:uppercase;letter-spacing:0.4px;font-size:0.62rem;">${statusTxt}</span>
        </span>
        <span style="color:#9ca3af;font-size:0.65rem;">⟳ ${relTime(st.atualizado_em)}</span>
      </div>

      <div style="position:relative;text-align:center;">
        <svg viewBox="0 0 210 112" role="img" aria-label="SoC ${st.soc_pct.toFixed(1)}%" style="width:100%;max-width:210px;height:auto;">
          <path d="${bg}" fill="none" stroke="rgba(148,163,184,0.22)" stroke-width="13" stroke-linecap="round"/>
          ${val ? `<path d="${val}" fill="none" stroke="${cor}" stroke-width="13" stroke-linecap="round"/>` : ''}
        </svg>
        <div style="position:absolute;left:0;right:0;bottom:16px;line-height:1;">
          <span style="font-size:2rem;font-weight:800;color:#1f2937;">${st.soc_pct.toFixed(1)}</span><span style="font-size:0.8rem;color:#9ca3af;margin-left:2px;">%</span>
        </div>
        <div style="position:absolute;left:0;right:0;bottom:0;font-size:0.66rem;color:${cor};font-weight:600;">
          <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${cor};vertical-align:middle;margin-right:4px;"></span>${labelEstado}
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-top:6px;">
        ${cell('Entrada', `<span style="color:#22c55e;">${Math.round(st.watts_in)} W</span>`)}
        ${cell('Saída', `<span style="color:#f59e0b;">${Math.round(st.watts_out)} W</span>`)}
      </div>

      <div style="border-top:1px solid rgba(0,0,0,0.06);margin-top:10px;padding-top:8px;">
        ${secHead('Autonomia')}
        <div style="display:flex;align-items:center;gap:10px;">
          ${battery}
          <div style="font-size:0.9rem;font-weight:700;color:#1f2937;white-space:nowrap;">${autonLabel}</div>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-top:10px;">
        ${cell('Tensão rede', vol)}
        ${cell('Temp. bateria', tb)}
        ${cell('Temp. inversor', ti)}
      </div>
    `);
  }

  // Pictograma de bateria horizontal preenchido pelo SoC, cor por estado.
  private renderBattery(frac: number, cor: string): string {
    const w = 96, h = 34, cap = 5, pad = 3;
    const bodyW = w - cap;
    const innerW = bodyW - pad * 2;
    const fillW = Math.max(0, Math.min(1, frac)) * innerW;
    return `
      <svg viewBox="0 0 ${w} ${h}" style="width:96px;height:auto;flex-shrink:0;" role="img" aria-label="bateria ${Math.round(frac * 100)}%">
        <rect x="1" y="1" width="${bodyW - 2}" height="${h - 2}" rx="5" fill="none" stroke="rgba(100,116,139,0.5)" stroke-width="2"/>
        <rect x="${bodyW}" y="${h / 2 - 6}" width="${cap}" height="12" rx="2" fill="rgba(100,116,139,0.5)"/>
        ${fillW > 0 ? `<rect x="${pad}" y="${pad}" width="${fillW.toFixed(1)}" height="${h - pad * 2}" rx="3" fill="${cor}"/>` : ''}
      </svg>`;
  }
}
