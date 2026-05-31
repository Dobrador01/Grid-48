// Configuração compartilhada Grid 48.
import type { PanelConfig, MapLayers } from '@/types';

// Idle pause duration - usado pra pausar polling quando user fica inativo (5 min)
export const IDLE_PAUSE_MS = 5 * 60 * 1000;

// Refresh intervals - mantidos pra retro-compat com refresh-scheduler.
// Grid 48 usa DataProvider (Convex) pra a maioria dos dados; intervals
// só viraram nominais.
export const REFRESH_INTERVALS = {
  feeds: 20 * 60 * 1000,
  markets: 12 * 60 * 1000,
  crypto: 12 * 60 * 1000,
  predictions: 15 * 60 * 1000,
  ais: 15 * 60 * 1000,
};

// Monitor colors - cores dispostas pra múltiplos monitors
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

// LocalStorage keys — mantidos com prefixo "grid48-" pra retro-compat
// com saved state de usuários existentes.
export const STORAGE_KEYS = {
  panels: 'grid48-panels',
  monitors: 'grid48-monitors',
  mapLayers: 'grid48-layers',
  disabledFeeds: 'grid48-disabled-feeds',
  liveChannels: 'grid48-live-channels',
  mapMode: 'grid48-map-mode',          // 'flat' | 'globe' (Grid 48 só usa 'flat')
} as const;

export interface VariantConfig {
  name: string;
  description: string;
  panels: Record<string, PanelConfig>;
  mapLayers: MapLayers;
  mobileMapLayers: MapLayers;
}
