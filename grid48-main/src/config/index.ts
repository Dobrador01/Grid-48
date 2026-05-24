// Grid 48 config barrel — apenas re-exports ainda usados por código vivo.
// Histórico: barrel era catch-all de ~30 datasets WorldMonitor (tech-
// companies, finance-geo, ai-datacenters, etc.). Fase 5+ deletou tudo
// que não era Grid 48.

export { SITE_VARIANT } from './variant';

export {
  IDLE_PAUSE_MS,
  REFRESH_INTERVALS,
  MONITOR_COLORS,
  STORAGE_KEYS,
} from './variants/base';

export {
  DEFAULT_PANELS,
  DEFAULT_MAP_LAYERS,
  MOBILE_DEFAULT_MAP_LAYERS,
  LAYER_TO_SOURCE,
} from './panels';
