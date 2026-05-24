import type { MapLayers } from '@/types';

export type MapRenderer = 'flat' | 'globe';

// WorldMonitor tinha múltiplas variantes (tech/finance/happy/commodity).
// Grid 48 só tem 'full'. Mantemos o type pra retro-compat com callsites
// que ainda passam o valor — será removido em sweep futuro.
export type MapVariant = 'full' | 'tech' | 'finance' | 'happy' | 'commodity';

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
  celescOutages: def('celescOutages', '⚡', 'celescOutages',  'Celesc (Rede Elétrica)'),
  weatherAlerts: def('weatherAlerts', '⛈',  'weatherAlerts',  'Alertas Meteorológicos'),
};

const KEPT_LAYERS: Array<keyof MapLayers> = ['celescOutages', 'weatherAlerts'];

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
  // Migration: chave antiga `outages` (InternetOutage worldmonitor) era distinta de celescOutages.
  // Grid 48 só liga ao Celesc; descartamos `outages` legado.

  return {
    celescOutages: typeof migrated.celescOutages === 'boolean' ? migrated.celescOutages : true,
    weatherAlerts: typeof migrated.weatherAlerts === 'boolean' ? migrated.weatherAlerts : true,
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
