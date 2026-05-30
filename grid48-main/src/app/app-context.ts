import type { Monitor, PanelConfig, MapLayers } from '@/types';
import type { MapContainer, Panel } from '@/components';
import type { UnifiedSettings } from '@/components/UnifiedSettings';
import type { ParsedMapUrlState } from '@/utils';

export interface AppModule {
  init(): void | Promise<void>;
  destroy(): void;
}

export interface AppContext {
  map: MapContainer | null;
  readonly isMobile: boolean;
  readonly container: HTMLElement;

  panels: Record<string, Panel>;
  panelSettings: Record<string, PanelConfig>;

  mapLayers: MapLayers;

  disabledSources: Set<string>;

  inFlight: Set<string>;
  seenGeoAlerts: Set<string>;
  monitors: Monitor[];

  unifiedSettings: UnifiedSettings | null;

  isDestroyed: boolean;
  isPlaybackMode: boolean;
  isIdle: boolean;
  initialLoadComplete: boolean;
  resolvedLocation: 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';

  initialUrlState: ParsedMapUrlState | null;
  readonly PANEL_ORDER_KEY: string;
  readonly PANEL_SPANS_KEY: string;
}
