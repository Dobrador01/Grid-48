import { Panel } from './Panel';
import type { BeaconSnapshot, ClimaLocalidade } from '@/services/beacon-client';

// ═══════════════════════════════════════════════════════════════════════════
// ClimaWidget — Card compacto com agora + sparkline 12h por localidade
// ═══════════════════════════════════════════════════════════════════════════
//
// Subscribe ao snapshot.clima (vindo de convex/clima/queries:getMeteorologiaState
// via beacon-client.ts). Renderiza:
//
//   ┌─────────────────────────────────┐
//   │ Casa · agora       ⟳ 12 min     │
//   │ 🌧️  21°C — Chuva moderada       │
//   │ Vento 14 km/h · umidade 88%     │
//   │ Chuva nas próximas 24h: 13.7mm  │
//   │                                 │
//   │ Próximas 12h                    │
//   │ ░▓█▓░░░░░░░ chuva (mm/h)        │
//   │ ╲╲___╱╱╲╲___ temperatura        │
//   │ 22h 0h 2h 4h 6h 8h 10h          │
//   └─────────────────────────────────┘
//
// Click no card cicla entre localidades (Casa → Trabalho → Casa). Botão único
// de "trocar" no canto superior direito quando há >1 localidade.
//
// Sparkline 100% SVG inline — sem libs. 2 séries sobrepostas:
//   - Barras de chuva (mm/h) com cor azul opaco
//   - Linha de temperatura (°C) sobreposta com cor laranja
// Eixos horizontais auto-escala pelas próximas 12 horas.
// ═══════════════════════════════════════════════════════════════════════════

export class ClimaWidget extends Panel {
  private snapshot: BeaconSnapshot = {
    alertas: [],
    health: null,
    defcon: null,
    clima: [],
    connection: { kind: 'connecting' },
  };

  // Index da localidade selecionada (cycle ao click).
  private selectedIndex = 0;

  constructor() {
    super({
      id: 'clima',
      title: 'Clima — Previsão',
    });
    this.injectStyles();
    // Click delegation: card inteiro alterna pra próxima localidade.
    this.content.addEventListener('click', (e) => {
      const trigger = (e.target as HTMLElement).closest<HTMLElement>('[data-clima-cycle]');
      if (!trigger) return;
      const total = this.snapshot.clima.length;
      if (total <= 1) return;
      this.selectedIndex = (this.selectedIndex + 1) % total;
      this.render();
    });
    this.render();
    // Re-render passivo a cada minuto pra atualizar "há X min".
    window.setInterval(() => this.render(), 60_000);
  }

  public setSnapshot(snapshot: BeaconSnapshot) {
    this.snapshot = snapshot;
    // Reajusta index se cliente removeu localidades
    if (this.selectedIndex >= snapshot.clima.length) {
      this.selectedIndex = 0;
    }
    this.render();
  }

  public render() {
    this.content.innerHTML = this.renderContent();
  }

  private injectStyles() {
    if (document.getElementById('clima-widget-style')) return;
    const style = document.createElement('style');
    style.id = 'clima-widget-style';
    style.textContent = `
      .clima-cycle-target { cursor: pointer; transition: background 0.15s; }
      .clima-cycle-target:hover { background: rgba(0,0,0,0.03); }
    `;
    document.head.appendChild(style);
  }

  protected renderContent(): string {
    const { connection, clima } = this.snapshot;

    if (connection.kind === 'no-config') {
      return this.renderState({ icon: '⚙', title: 'Clima offline',
        body: 'VITE_CONVEX_URL ausente no build.' });
    }
    if (connection.kind === 'disconnected' && clima.length === 0) {
      return this.renderState({ icon: '⏻', title: 'Sem conexão',
        body: `Tentando reconectar (${connection.retries} tentativa${connection.retries === 1 ? '' : 's'}).` });
    }
    if (clima.length === 0) {
      return this.renderState({ icon: '🌤', title: 'Aguardando primeiro snapshot',
        body: 'O cron fetch-openweather roda a cada 15 min. Pode invocar manualmente via dashboard Convex.' });
    }

    const loc = clima[this.selectedIndex] ?? clima[0]!;
    return this.renderLocalidade(loc, clima.length);
  }

  private renderState(opts: { icon: string; title: string; body: string }): string {
    return `
      <div style="padding: 1.25rem; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 0.5rem; color: #4b5563; background: rgba(245, 247, 250, 0.5); backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px); font-family: ui-sans-serif, system-ui, sans-serif;">
        <div style="font-size: 1.75rem; line-height: 1;">${opts.icon}</div>
        <div style="font-size: 0.95rem; font-weight: 700; color: #1f2937;">${opts.title}</div>
        <div style="font-size: 0.8rem; max-width: 22rem;">${opts.body}</div>
      </div>
    `;
  }

  private renderLocalidade(loc: ClimaLocalidade, totalLocalidades: number): string {
    const c = loc.current;
    const idadeStr = this.formatRelative(loc.ts);
    const corCondicao = this.getCorByCondicao(c.condicao_id);
    const iconeEmoji = this.iconeOWMtoEmoji(c.icone);
    const switcherBadge = totalLocalidades > 1
      ? `<span style="background: rgba(0,0,0,0.06); padding: 2px 8px; border-radius: 999px; font-size: 0.65rem; font-weight: 600; color: #4b5563;">${this.selectedIndex + 1}/${totalLocalidades} · trocar</span>`
      : '';

    const sparkline = this.renderSparkline(loc.hourly);

    const alertasBlock = loc.alertas && loc.alertas.length > 0
      ? `
        <div style="margin: 0.5rem 0; padding: 6px 10px; background: rgba(249, 115, 22, 0.12); border-left: 3px solid #f97316; border-radius: 4px; font-size: 0.7rem; color: #9a3412;">
          <strong>⚠ ${this.escapeHtml(loc.alertas[0]!.evento)}</strong>
          ${loc.alertas.length > 1 ? ` <span style="opacity: 0.7;">+${loc.alertas.length - 1} outro${loc.alertas.length - 1 === 1 ? '' : 's'}</span>` : ''}
        </div>
      `
      : '';

    return `
      <div data-clima-cycle class="clima-cycle-target" style="padding: 0.85rem 1rem; height: 100%; background: rgba(245, 247, 250, 0.5); backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px); font-family: ui-sans-serif, system-ui, sans-serif; overflow-y: auto;">
        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;">
          <div style="font-size: 0.78rem; font-weight: 700; color: #1f2937;">
            ${this.escapeHtml(loc.localidade_label)} · <span style="font-weight: 500; color: #6b7280;">agora</span>
          </div>
          <div style="font-size: 0.65rem; color: #9ca3af;">⟳ ${idadeStr}</div>
        </div>

        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 4px;">
          <div style="font-size: 2rem; line-height: 1;">${iconeEmoji}</div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 1.5rem; font-weight: 800; color: ${corCondicao}; line-height: 1.1;">${c.temperatura_c.toFixed(1)}°C</div>
            <div style="font-size: 0.72rem; color: #4b5563; text-transform: capitalize;">${this.escapeHtml(c.condicao_descricao)}</div>
          </div>
          ${switcherBadge}
        </div>

        <div style="font-size: 0.7rem; color: #6b7280; margin-bottom: 6px;">
          Sensação ${c.sensacao_c.toFixed(1)}°C · vento ${c.vento_kmh.toFixed(1)} km/h${c.vento_rajada_kmh ? ` (rajadas ${c.vento_rajada_kmh.toFixed(0)})` : ''} · umidade ${c.umidade_pct}%
          ${typeof c.chuva_1h_mm === 'number' && c.chuva_1h_mm > 0 ? ` · chuva agora ${c.chuva_1h_mm.toFixed(1)}mm/h` : ''}
        </div>

        ${loc.chuva_24h_mm > 0 ? `
          <div style="font-size: 0.7rem; color: #2563eb; margin-bottom: 8px; font-weight: 600;">
            💧 Previsão de chuva hoje: ${loc.chuva_24h_mm.toFixed(1)} mm
          </div>
        ` : ''}

        ${alertasBlock}

        <div style="border-top: 1px solid rgba(0,0,0,0.06); margin-top: 6px; padding-top: 6px;">
          <div style="font-size: 0.6rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 4px;">Próximas 12h</div>
          ${sparkline}
        </div>
      </div>
    `;
  }

  /**
   * Sparkline SVG sobrepondo barras de chuva (azul) e linha de temperatura
   * (laranja) ao longo das próximas 12h. Eixo X = horas, eixo Y dual:
   *   - barras de chuva escaladas em [0, max(chuva, 5mm)]
   *   - linha de temp escalada em [min-2, max+2] pra não cortar nas bordas
   *
   * Sem libs externas, viewBox responsivo, gradient fill nas barras.
   */
  private renderSparkline(hourly: ClimaLocalidade['hourly']): string {
    if (hourly.length === 0) {
      return `<div style="font-size: 0.7rem; color: #9ca3af; padding: 8px;">Sem dados de previsão.</div>`;
    }
    const w = 300;
    const h = 70;
    const padLeft = 18;
    const padRight = 8;
    const padTop = 8;
    const padBottom = 18;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBottom;
    const n = hourly.length;
    const stepX = chartW / Math.max(1, n - 1);

    const temps = hourly.map((p) => p.temperatura_c);
    const chuvas = hourly.map((p) => p.chuva_1h_mm ?? 0);
    const tMin = Math.min(...temps) - 2;
    const tMax = Math.max(...temps) + 2;
    const tRange = Math.max(0.1, tMax - tMin);
    const chuvaMax = Math.max(5, ...chuvas);

    const yTemp = (t: number) => padTop + (1 - (t - tMin) / tRange) * chartH;
    const xAt = (i: number) => padLeft + i * stepX;

    // Barras de chuva
    const barWidth = Math.max(2, stepX * 0.6);
    const bars = hourly.map((p, i) => {
      const mm = p.chuva_1h_mm ?? 0;
      const barH = (mm / chuvaMax) * chartH;
      const x = xAt(i) - barWidth / 2;
      const y = padTop + chartH - barH;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barH.toFixed(1)}" fill="#2563eb" opacity="${mm > 0 ? 0.65 : 0}" rx="1.5" />`;
    }).join('');

    // Linha de temperatura
    const tempPath = hourly.map((_, i) => {
      const x = xAt(i);
      const y = yTemp(temps[i]!);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');

    // Labels de hora — mostra a cada 3 horas pra não poluir
    const horaLabels = hourly.map((p, i) => {
      if (i % 3 !== 0) return '';
      const d = new Date(p.ts);
      const hora = d.getHours().toString().padStart(2, '0') + 'h';
      const x = xAt(i);
      return `<text x="${x.toFixed(1)}" y="${(h - 4).toFixed(0)}" text-anchor="middle" font-size="9" fill="#9ca3af" font-family="ui-monospace, monospace">${hora}</text>`;
    }).join('');

    // Eixo Y left (temperatura)
    const tempMaxLabel = `<text x="2" y="${(padTop + 4).toFixed(0)}" font-size="9" fill="#ea580c" font-family="ui-monospace, monospace">${tMax.toFixed(0)}°</text>`;
    const tempMinLabel = `<text x="2" y="${(padTop + chartH).toFixed(0)}" font-size="9" fill="#ea580c" font-family="ui-monospace, monospace">${tMin.toFixed(0)}°</text>`;

    // Tooltip discreto: mostra valores no primeiro e último ponto
    const firstTemp = `<circle cx="${xAt(0)}" cy="${yTemp(temps[0]!)}" r="2.5" fill="#ea580c" />`;
    const lastIdx = n - 1;
    const lastTemp = `<circle cx="${xAt(lastIdx)}" cy="${yTemp(temps[lastIdx]!)}" r="2.5" fill="#ea580c" />`;

    return `
      <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="display: block; width: 100%; height: auto;">
        ${bars}
        <path d="${tempPath}" fill="none" stroke="#ea580c" stroke-width="1.5" stroke-linejoin="round" />
        ${firstTemp}
        ${lastTemp}
        ${tempMaxLabel}
        ${tempMinLabel}
        ${horaLabels}
      </svg>
      <div style="display: flex; gap: 14px; font-size: 0.6rem; color: #6b7280; margin-top: 2px; padding-left: 18px;">
        <span><span style="display: inline-block; width: 8px; height: 8px; background: #ea580c; border-radius: 1px; vertical-align: middle;"></span> Temperatura</span>
        <span><span style="display: inline-block; width: 8px; height: 8px; background: #2563eb; opacity: 0.65; border-radius: 1px; vertical-align: middle;"></span> Chuva (mm/h)</span>
      </div>
    `;
  }

  /**
   * Mapeia o ID da condição OpenWeather (200..804) pra uma cor de acento.
   * Critério: tempestade/chuva = azul; nublado = cinza; sol = âmbar.
   * Fonte dos IDs: https://openweathermap.org/weather-conditions
   */
  private getCorByCondicao(id: number): string {
    if (id >= 200 && id < 300) return '#7c3aed'; // tempestade roxo
    if (id >= 300 && id < 600) return '#2563eb'; // chuva azul
    if (id >= 600 && id < 700) return '#0ea5e9'; // neve azul claro
    if (id >= 700 && id < 800) return '#a16207'; // névoa/poeira âmbar
    if (id === 800) return '#f59e0b';           // céu limpo âmbar
    if (id > 800) return '#6b7280';             // nuvens cinza
    return '#374151';
  }

  /**
   * Mapeia o ícone OpenWeather (ex: "10d") pra emoji. Bate o suficiente pra
   * leitura rápida no card sem precisar baixar SVGs/PNGs.
   */
  private iconeOWMtoEmoji(icone: string): string {
    // Normaliza pra remover sufixo d/n (dia/noite); poderíamos diferenciar
    // se quiser sol/lua em algum momento.
    const code = icone.slice(0, 2);
    const isNight = icone.endsWith('n');
    switch (code) {
      case '01': return isNight ? '🌙' : '☀️';
      case '02': return isNight ? '☁️' : '🌤️';
      case '03': return '☁️';
      case '04': return '☁️';
      case '09': return '🌧️';
      case '10': return isNight ? '🌧️' : '🌦️';
      case '11': return '⛈️';
      case '13': return '❄️';
      case '50': return '🌫️';
      default: return '🌡️';
    }
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
