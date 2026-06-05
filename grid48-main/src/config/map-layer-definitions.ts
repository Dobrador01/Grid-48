import type { MapLayers } from '@/types';

export type MapRenderer = 'flat' | 'globe';

// Grid 48 tem uma única variante. Type mantido pra retro-compat com
// callsites (getLayersForVariant etc.) que recebem o valor mas o ignoram.
export type MapVariant = 'full';

export interface LayerDefinition {
  key: keyof MapLayers;
  icon: string;
  i18nSuffix: string;
  fallbackLabel: string;
  renderers: MapRenderer[];
}

const def = (
  key: keyof MapLayers,
  icon: string,
  i18nSuffix: string,
  fallbackLabel: string,
  renderers: MapRenderer[] = ['flat'],
): LayerDefinition => ({ key, icon, i18nSuffix, fallbackLabel, renderers });

// Layers do Grid 48 — apenas Celesc + Weather Alerts (Defesa Civil).
export const LAYER_REGISTRY: Record<keyof MapLayers, LayerDefinition> = {
  celescOutages:  def('celescOutages',  '⚡', 'celescOutages',  'Celesc (Rede Elétrica)'),
  weatherAlerts:  def('weatherAlerts',  '⛈',  'weatherAlerts',  'Alertas Meteorológicos'),
  loraTrail:      def('loraTrail',      '🛰', 'loraTrail',      'Trilha das tags'),
  loraHeatDirect: def('loraHeatDirect', '📡', 'loraHeatDirect', 'Cobertura direta (0 hop)'),
  loraHeat1:      def('loraHeat1',      '🔗', 'loraHeat1',      'Alcance via 1 salto'),
  loraHeat2plus:  def('loraHeat2plus',  '🕸', 'loraHeat2plus',  'Alcance via 2+ saltos'),
};

const KEPT_LAYERS: Array<keyof MapLayers> = [
  'celescOutages', 'weatherAlerts',
  'loraTrail', 'loraHeatDirect', 'loraHeat1', 'loraHeat2plus',
];

export function getLayersForVariant(_variant: MapVariant, renderer: MapRenderer): LayerDefinition[] {
  return KEPT_LAYERS
    .map((k) => LAYER_REGISTRY[k])
    .filter((d): d is LayerDefinition => Boolean(d && d.renderers.includes(renderer)));
}

export function getAllowedLayerKeys(_variant: MapVariant): Set<keyof MapLayers> {
  return new Set(KEPT_LAYERS);
}

export function sanitizeLayersForVariant(layers: Partial<MapLayers> & Record<string, unknown>, _variant: MapVariant): MapLayers {
  // Migration: chave antiga `weather` virou `weatherAlerts` (rename pós-cleanup).
  const migrated: Record<string, unknown> = { ...layers };
  if ('weather' in migrated && !('weatherAlerts' in migrated)) {
    migrated.weatherAlerts = migrated.weather;
  }
  const bool = (k: string, fallback: boolean) =>
    typeof migrated[k] === 'boolean' ? (migrated[k] as boolean) : fallback;
  return {
    celescOutages:  bool('celescOutages', true),
    weatherAlerts:  bool('weatherAlerts', true),
    // Camadas LoRa default OFF — só aparecem quando o user liga (sem poluir o mapa).
    loraTrail:      bool('loraTrail', false),
    loraHeatDirect: bool('loraHeatDirect', false),
    loraHeat1:      bool('loraHeat1', false),
    loraHeat2plus:  bool('loraHeat2plus', false),
  };
}

// Sinônimos pra search de layers (futuro recurso de busca).
export const LAYER_SYNONYMS: Record<string, Array<keyof MapLayers>> = {
  celesc: ['celescOutages'],
  energia: ['celescOutages'],
  eletrica: ['celescOutages'],
  luz: ['celescOutages'],
  apagao: ['celescOutages'],
  clima: ['weatherAlerts'],
  tempo: ['weatherAlerts'],
  chuva: ['weatherAlerts'],
  vento: ['weatherAlerts'],
  alerta: ['weatherAlerts'],
  storm: ['weatherAlerts'],
  flood: ['weatherAlerts'],
};

const I18N_PREFIX = 'components.deckgl.layers.';

export function resolveLayerLabel(def: LayerDefinition, tFn?: (key: string) => string): string {
  if (tFn) {
    const translated = tFn(I18N_PREFIX + def.i18nSuffix);
    if (translated && translated !== I18N_PREFIX + def.i18nSuffix) return translated;
  }
  return def.fallbackLabel;
}

export function bindLayerSearch(container: HTMLElement): void {
  const searchInput = container.querySelector('.layer-search') as HTMLInputElement | null;
  if (!searchInput) return;
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    const synonymHits = new Set<string>();
    if (q) {
      for (const [alias, keys] of Object.entries(LAYER_SYNONYMS)) {
        if (alias.includes(q)) keys.forEach((k) => synonymHits.add(String(k)));
      }
    }
    container.querySelectorAll('.layer-toggle').forEach((label) => {
      const el = label as HTMLElement;
      if (el.hasAttribute('data-layer-hidden')) return;
      if (!q) { el.style.display = ''; return; }
      const key = label.getAttribute('data-layer') || '';
      const text = label.textContent?.toLowerCase() || '';
      const match = text.includes(q) || key.toLowerCase().includes(q) || synonymHits.has(key);
      el.style.display = match ? '' : 'none';
    });
  });
}
