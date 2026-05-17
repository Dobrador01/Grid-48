// ═══════════════════════════════════════════════════════════════════════════
// Geo utilities — cálculos esféricos de distância (sem libs externas)
// ═══════════════════════════════════════════════════════════════════════════

const EARTH_RADIUS_M = 6_371_000;

/**
 * Distância em metros entre dois pontos lat/lon usando fórmula de Haversine.
 * Precisão suficiente pra escalas urbanas (erro <0.5% pra distâncias <500km).
 */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}
