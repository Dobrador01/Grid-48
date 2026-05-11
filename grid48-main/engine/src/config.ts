export const KNOWN_RADIO_DEVICES = [
  { vid: '10C4', pid: 'EA60', name: 'Silicon Labs CP210x' },
  { vid: '1915', pid: '521F', name: 'Nordic nRF52 (RAK4631)' },
  { vid: '0403', pid: '6001', name: 'FTDI FT232' },
];

export const ENGINE_PORT = parseInt(process.env.ENGINE_PORT || '3001');
export const DB_PATH = process.env.DB_PATH || './data/grid48.db';
// Single Convex deployment serves both Beacon OSINT (alertas_rss queries)
// and Gateway (telemetry POST + SITREP routes). Pre-consolidation this was
// split into CONVEX_GW_URL and CONVEX_BEACON_URL — kept as fallbacks so old
// .env files still boot, but new deploys should set just CONVEX_URL.
export const CONVEX_URL =
  process.env.CONVEX_URL ||
  process.env.CONVEX_GW_URL ||
  process.env.CONVEX_BEACON_URL ||
  '';
export const GATEWAY_PSK = process.env.PSK_GATEWAY || '';
