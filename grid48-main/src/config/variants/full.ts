// Grid 48 — variant config (única variante após cleanup pós-WorldMonitor)
import type { PanelConfig } from '@/types';
import type { VariantConfig } from './base';

export * from './base';

// Painéis Grid 48 — coberto canonicamente em src/config/panels.ts:FULL_PANELS.
// Este DEFAULT_PANELS é leitura inicial; o app sincroniza com panels.ts.
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Mapa — Grande Florianópolis', enabled: true, priority: 1 },
  defcon: { name: 'DEFCON — Estado Operacional', enabled: true, priority: 1 },
  clima: { name: 'Clima — Previsão', enabled: true, priority: 1 },
  trafego: { name: 'Tráfego — Rotas', enabled: true, priority: 1 },
  'celesc-status': { name: 'Celesc Status', enabled: true, priority: 1 },
  'beacon-status': { name: 'Beacon Status', enabled: true, priority: 1 },
  'engine-health': { name: 'Comando & Controle', enabled: true, priority: 1 },
  sitrep: { name: 'SITREP — Pedido C2', enabled: true, priority: 1 },
};

// Layers Grid 48 — apenas Celesc (energia) e Weather Alerts (Defesa Civil).
export const DEFAULT_MAP_LAYERS = {
  celescOutages: true,
  weatherAlerts: true,
};

export const MOBILE_DEFAULT_MAP_LAYERS = {
  celescOutages: true,
  weatherAlerts: true,
};

export const VARIANT_CONFIG: VariantConfig = {
  name: 'full',
  description: 'Grid 48 — C2 Grande Florianópolis',
  panels: DEFAULT_PANELS,
  mapLayers: DEFAULT_MAP_LAYERS,
  mobileMapLayers: MOBILE_DEFAULT_MAP_LAYERS,
};
