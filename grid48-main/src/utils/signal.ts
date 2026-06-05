// ═══════════════════════════════════════════════════════════════════════════
// signal — qualidade de link LoRa em linguagem humana
// ═══════════════════════════════════════════════════════════════════════════
//
// Traduz SNR (dB) / RSSI (dBm) crus do Meshtastic numa escala amigável com
// barras (0–4), rótulo e cor. SNR é o indicador primário (melhor que RSSI em
// LoRa, que opera abaixo do piso de ruído); RSSI é fallback quando SNR ausente.
//
// Faixas de SNR adotadas (LoRa típico, piso ~ -20 dB):
//   >= 10  Excelente · >= 5 Bom · >= 0 Razoável · >= -10 Fraco · < -10 Crítico
// ═══════════════════════════════════════════════════════════════════════════

export type SignalQuality =
  | 'excelente'
  | 'bom'
  | 'razoavel'
  | 'fraco'
  | 'critico'
  | 'desconhecido';

export interface SignalReading {
  quality: SignalQuality;
  label: string;
  bars: number;       // 0..4 — barras preenchidas
  color: string;      // hex pra UI
  /** Detalhe técnico pro hover/tooltip (ex: "SNR 7.5 dB · RSSI -98 dBm"). */
  detail: string;
}

const QUALITY_META: Record<SignalQuality, { label: string; bars: number; color: string }> = {
  excelente:    { label: 'Excelente',    bars: 4, color: '#22c55e' },
  bom:          { label: 'Bom',          bars: 3, color: '#84cc16' },
  razoavel:     { label: 'Razoável',     bars: 2, color: '#eab308' },
  fraco:        { label: 'Fraco',        bars: 1, color: '#f97316' },
  critico:      { label: 'Crítico',      bars: 0, color: '#ef4444' },
  desconhecido: { label: 'Sem dados',    bars: 0, color: '#9ca3af' },
};

function qualityFromSnr(snr: number): SignalQuality {
  if (snr >= 10) return 'excelente';
  if (snr >= 5) return 'bom';
  if (snr >= 0) return 'razoavel';
  if (snr >= -10) return 'fraco';
  return 'critico';
}

function qualityFromRssi(rssi: number): SignalQuality {
  if (rssi >= -90) return 'bom';
  if (rssi >= -105) return 'razoavel';
  if (rssi >= -115) return 'fraco';
  return 'critico';
}

/**
 * Deriva a leitura amigável a partir de SNR (preferencial) e/ou RSSI.
 * Ambos opcionais — retorna 'desconhecido' quando nenhum está presente.
 */
export function readSignal(snr?: number, rssi?: number): SignalReading {
  const hasSnr = typeof snr === 'number' && Number.isFinite(snr);
  const hasRssi = typeof rssi === 'number' && Number.isFinite(rssi);

  let quality: SignalQuality;
  if (hasSnr) quality = qualityFromSnr(snr as number);
  else if (hasRssi) quality = qualityFromRssi(rssi as number);
  else quality = 'desconhecido';

  const detailParts: string[] = [];
  if (hasSnr) detailParts.push(`SNR ${(snr as number).toFixed(1)} dB`);
  if (hasRssi) detailParts.push(`RSSI ${Math.round(rssi as number)} dBm`);

  const meta = QUALITY_META[quality];
  return {
    quality,
    label: meta.label,
    bars: meta.bars,
    color: meta.color,
    detail: detailParts.join(' · ') || 'Sem leitura de sinal',
  };
}
