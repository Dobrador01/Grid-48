import type { MapLayers } from '@/types';

export type MapRenderer = 'flat' | 'globe';
export type MapVariant = 'full' | 'tech' | 'finance' | 'happy' | 'commodity';

export interface LayerDefinition {
  key: keyof MapLayers;
  icon: string;
  i18nSuffix: string;
  fallbackLabel: string;
  renderers: MapRenderer[];
  premium?: 'locked' | 'enhanced';
}

const def = (
  key: keyof MapLayers,
  icon: string,
  i18nSuffix: string,
  fallbackLabel: string,
  renderers: MapRenderer[] = ['flat', 'globe'],
  premium?: 'locked' | 'enhanced',
): LayerDefinition => ({ key, icon, i18nSuffix, fallbackLabel, renderers, ...(premium && { premium }) });

// Only layers relevant to Grande Florianópolis / Brazil
export const LAYER_REGISTRY: Record<keyof MapLayers, LayerDefinition> = {
  weather:                  def('weather',                  '⛈',   'weatherAlerts',            'Alertas Meteorológicos'),
  natural:                  def('natural',                  '🌍',   'naturalEvents',            'Eventos Naturais'),
  fires:                    def('fires',                    '🔥',   'fires',                    'Incêndios'),
  climate:                  def('climate',                  '🌫',   'climateAnomalies',         'Anomalias Climáticas'),
  outages:                  def('outages',                  '📡',   'internetOutages',          'Quedas de Internet'),
  flights:                  def('flights',                  '✈',   'flightDelays',             'Aviação'),
  dayNight:                 def('dayNight',                 '🌓',   'dayNight',                 'Dia/Noite', ['flat']),
  celescOutages:            def('celescOutages',            '⚡',   'celescOutages',            'Celesc (Rede Elétrica)'),
};

const KEPT_LAYERS: Array<keyof MapLayers> = [
  'weather', 'natural', 'fires', 'climate', 'outages', 'flights', 'dayNight', 'celescOutages',
];

const VARIANT_LAYER_ORDER: Record<MapVariant, Array<keyof MapLayers>> = {
  full:      KEPT_LAYERS,
  tech:      KEPT_LAYERS,
  finance:   KEPT_LAYERS,
  happy:     KEPT_LAYERS,
  commodity: KEPT_LAYERS,
};

const I18N_PREFIX = 'components.deckgl.layers.';

export function getLayersForVariant(variant: MapVariant, renderer: MapRenderer): LayerDefinition[] {
  const keys = VARIANT_LAYER_ORDER[variant] ?? VARIANT_LAYER_ORDER.full;
  return keys
    .map(k => LAYER_REGISTRY[k])
    .filter(d => d && d.renderers.includes(renderer));
}

export function getAllowedLayerKeys(variant: MapVariant): Set<keyof MapLayers> {
  return new Set(VARIANT_LAYER_ORDER[variant] ?? VARIANT_LAYER_ORDER.full);
}

export function sanitizeLayersForVariant(layers: MapLayers, variant: MapVariant): MapLayers {
  const allowed = getAllowedLayerKeys(variant);
  const sanitized = { ...layers };
  for (const key of Object.keys(sanitized) as Array<keyof MapLayers>) {
    if (!allowed.has(key)) sanitized[key] = false;
  }
  return sanitized;
}

export const LAYER_SYNONYMS: Record<string, Array<keyof MapLayers>> = {
  storm: ['weather', 'natural'],
  hurricane: ['weather', 'natural'],
  typhoon: ['weather', 'natural'],
  cyclone: ['weather', 'natural'],
  flood: ['weather', 'natural'],
  earthquake: ['natural'],
  volcano: ['natural'],
  tsunami: ['natural'],
  wildfire: ['fires'],
  forest: ['fires'],
  night: ['dayNight'],
  sun: ['dayNight'],
  internet: ['outages'],
  aviation: ['flights'],
  flight: ['flights'],
  airplane: ['flights'],
  plane: ['flights'],
  clima: ['climate', 'weather'],
  tempo: ['weather'],
  chuva: ['weather'],
  vento: ['weather'],
  incendio: ['fires'],
  celesc: ['celescOutages'],
  energia: ['celescOutages'],
  eletrica: ['celescOutages'],
  luz: ['celescOutages'],
  apagao: ['celescOutages'],
};

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
        if (alias.includes(q)) keys.forEach(k => synonymHits.add(k));
      }
    }
    container.querySelectorAll('.layer-toggle').forEach(label => {
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
