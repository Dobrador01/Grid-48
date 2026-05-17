import type { PanelConfig } from '@/types';
import type { DataSourceId } from '@/services/data-freshness';
// ============================================
// FULL VARIANT (Geopolitical)
// ============================================
// Panel order matters! First panels appear at top of grid.
// Desired order: live-news, AI Insights, AI Strategic Posture, cii, strategic-risk, then rest
const FULL_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Mapa — Grande Florianópolis', enabled: true, priority: 1 },
  'defcon': { name: 'DEFCON — Estado Operacional', enabled: true, priority: 1 },
  'clima': { name: 'Clima — Previsão', enabled: true, priority: 1 },
  'celesc-status': { name: 'Celesc Status', enabled: true, priority: 1 },
  'beacon-status': { name: 'Beacon Status', enabled: true, priority: 1 },
  // Consolidado: 'tactical-status' (header MODE) + 'engine-health' (breakdown)
  // virou um único painel 'engine-health' rotulado como "Comando & Controle".
  'engine-health': { name: 'Comando & Controle', enabled: true, priority: 1 },
  'sitrep': { name: 'SITREP — Pedido C2', enabled: true, priority: 1 },
};

const FULL_MAP_LAYERS: any = {
  // Grid 48: todas as camadas geopolÃ­ticas globais desativadas por padrÃ£o
  iranAttacks: false,
  gpsJamming: false,
  satellites: false,
  notamOverlay: false,

  conflicts: false,
  bases: false,
  cables: false,
  pipelines: false,
  hotspots: true,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: false,
  weather: true,
  economic: false,
  waterways: false,
  outages: true,
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: true,
  spaceports: false,
  minerals: false,
  fires: false,
  // Data source layers
  ucdpEvents: false,
  displacement: false,
  climate: false,
  // Tech layers (disabled in full variant)
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  // Finance layers (disabled in full variant)
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  // Happy variant layers
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  tradeRoutes: false,
  ciiChoropleth: false,
  dayNight: false,
  // Celesc power grid layer
  celescOutages: true,
  // Commodity layers (disabled in full variant)
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
};

const FULL_MOBILE_MAP_LAYERS: any = {
  // Grid 48: todas as camadas geopolÃ­ticas globais desativadas por padrÃ£o
  iranAttacks: false,
  gpsJamming: false,
  satellites: false,
  notamOverlay: false,

  conflicts: false,
  bases: false,
  cables: false,
  pipelines: false,
  hotspots: true,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: false,
  weather: true,
  economic: false,
  waterways: false,
  outages: true,
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: true,
  spaceports: false,
  minerals: false,
  fires: false,
  // Data source layers
  ucdpEvents: false,
  displacement: false,
  climate: false,
  // Tech layers (disabled in full variant)
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  // Finance layers (disabled in full variant)
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  // Happy variant layers
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  tradeRoutes: false,
  ciiChoropleth: false,
  dayNight: false,
  // Celesc power grid layer
  celescOutages: true,
  // Commodity layers (disabled in full variant)
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
};

export const DEFAULT_PANELS = FULL_PANELS;
export const DEFAULT_MAP_LAYERS = FULL_MAP_LAYERS;
export const MOBILE_DEFAULT_MAP_LAYERS = FULL_MOBILE_MAP_LAYERS;

/** Maps map-layer toggle keys to their data-freshness source IDs (single source of truth). */
export const LAYER_TO_SOURCE: Partial<Record<any, DataSourceId[]>> = {
  military: ['opensky', 'wingbits'],
  ais: ['ais'],
  natural: ['usgs'],
  weather: ['weather'],
  outages: ['outages'],
  cyberThreats: ['cyber_threats'],
  protests: ['acled', 'gdelt_doc'],
  ucdpEvents: ['ucdp'],
  displacement: ['unhcr'],
  climate: ['climate'],
};

// ============================================
// PANEL CATEGORY MAP (variant-aware)
// ============================================
// Maps category keys to panel keys. Only categories with at least one
// matching panel in the active variant's DEFAULT_PANELS are shown.
// The `variants` field restricts a category to specific site variants;
// omit it to show the category for all variants.
export const PANEL_CATEGORY_MAP: Record<string, { labelKey: string; panelKeys: string[]; variants?: string[] }> = {
  core: {
    labelKey: 'header.panelCatCore',
    panelKeys: ['map', 'defcon', 'clima', 'celesc-status', 'engine-health', 'sitrep', 'beacon-status'],
  },
};

// Monitor palette â€” fixed category colors persisted to localStorage (not theme-dependent)
export const MONITOR_COLORS = [
  '#44ff88',
  '#ff8844',
  '#4488ff',
  '#ff44ff',
  '#ffff44',
  '#ff4444',
  '#44ffff',
  '#88ff44',
  '#ff88ff',
  '#88ffff',
];

export const STORAGE_KEYS = {
  panels: 'worldmonitor-panels',
  monitors: 'worldmonitor-monitors',
  mapLayers: 'worldmonitor-layers',
  disabledFeeds: 'worldmonitor-disabled-feeds',
} as const;
