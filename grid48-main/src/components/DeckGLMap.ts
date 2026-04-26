/**
 * DeckGLMap - WebGL-accelerated map visualization for desktop
 * Uses deck.gl for high-performance rendering of large datasets
 * Mobile devices gracefully degrade to the D3/SVG-based Map component
 */
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer, LayersList, PickingInfo } from '@deck.gl/core';
import { GeoJsonLayer, ScatterplotLayer, PathLayer, IconLayer, PolygonLayer } from '@deck.gl/layers';
import maplibregl from 'maplibre-gl';
import { registerPMTilesProtocol, FALLBACK_DARK_STYLE, FALLBACK_LIGHT_STYLE, getMapProvider, getMapTheme, getStyleForProvider, isLightMapTheme } from '@/config/basemap';
import Supercluster from 'supercluster';
import type {
  MapLayers,
  Hotspot,
  NewsItem,
  InternetOutage,
  RelatedAsset,
  AssetType,
  AisDisruptionEvent,
  AisDensityZone,
  CableAdvisory,
  RepairShip,
  SocialUnrestEvent,
  AIDataCenter,
  MilitaryFlight,
  MilitaryVessel,
  MilitaryFlightCluster,
  MilitaryVesselCluster,
  NaturalEvent,
  UcdpGeoEvent,
  MapProtestCluster,
  MapTechHQCluster,
  MapTechEventCluster,
  MapDatacenterCluster,
  CableHealthRecord,
  MilitaryBaseEnriched,
} from '@/types';
import type { AirportDelayAlert, PositionSample } from '@/services/aviation';
import { fetchAircraftPositions } from '@/services/aviation';
import type { GpsJamHex } from '@/services/gps-interference';
import type { CelescMunicipioPayload } from '@/types/celesc';
import type { ImageryScene } from '@/generated/server/grid48/imagery/v1/service_server';
import type { Earthquake } from '@/services/earthquakes';
import type { ClimateAnomaly } from '@/services/climate';
import { PathStyleExtension } from '@deck.gl/extensions';
import type { WeatherAlert } from '@/services/weather';
import { escapeHtml } from '@/utils/sanitize';
import { tokenizeForMatch, matchKeyword, matchesAnyKeyword, findMatchingKeywords } from '@/utils/keyword-match';
import { t } from '@/services/i18n';
import { debounce, rafSchedule, getCurrentTheme } from '@/utils/index';
import { showLayerWarning } from '@/utils/layer-warning';
import { localizeMapLabels } from '@/utils/map-locale';
import {
  INTEL_HOTSPOTS,
  CONFLICT_ZONES,

  MILITARY_BASES,
  UNDERSEA_CABLES,
  NUCLEAR_FACILITIES,
  GAMMA_IRRADIATORS,
  PIPELINES,
  AI_DATA_CENTERS,
  SITE_VARIANT,
  TECH_HQS,
} from '@/config';
import type { GulfInvestment } from '@/types';
import { getLayersForVariant, resolveLayerLabel, bindLayerSearch, type MapVariant } from '@/config/map-layer-definitions';
import { getSecretState } from '@/services/runtime-config';
import { MapPopup, type PopupType } from './MapPopup';
import {
  updateHotspotEscalation,
  getHotspotEscalation,
  setMilitaryData,
  setCIIGetter,
  setGeoAlertGetter,
} from '@/services/hotspot-escalation';
import { getCountryScore } from '@/services/country-instability';
import { getAlertsNearLocation } from '@/services/geo-convergence';
import type { PositiveGeoEvent } from '@/services/positive-events-geo';
import type { KindnessPoint } from '@/services/kindness-data';
import type { HappinessData } from '@/services/happiness-data';
import type { RenewableInstallation } from '@/services/renewable-installations';
import type { SpeciesRecovery } from '@/services/conservation-data';
import { getCountriesGeoJson, getCountryAtCoordinates, getCountryBbox } from '@/services/country-geometry';
import type { FeatureCollection, Geometry } from 'geojson';

import { isAllowedPreviewUrl } from '@/utils/imagery-preview';

export type TimeRange = '1h' | '6h' | '24h' | '48h' | '7d' | 'all';
export type DeckMapView = 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania' | 'sjf';
type MapInteractionMode = 'flat' | '3d';

export interface CountryClickPayload {
  lat: number;
  lon: number;
  code?: string;
  name?: string;
}

interface DeckMapState {
  zoom: number;
  pan: { x: number; y: number };
  view: DeckMapView;
  layers: MapLayers;
  timeRange: TimeRange;
}

interface HotspotWithBreaking extends Hotspot {
  hasBreaking?: boolean;
}

interface TechEventMarker {
  id: string;
  title: string;
  location: string;
  lat: number;
  lng: number;
  country: string;
  startDate: string;
  endDate: string;
  url: string | null;
  daysUntil: number;
}

// View presets with longitude, latitude, zoom
const VIEW_PRESETS: Record<DeckMapView, { longitude: number; latitude: number; zoom: number }> = {
  // Grid 48 default Ã¢â‚¬â€ Grande FlorianÃƒÂ³polis / SÃƒÂ£o JosÃƒÂ©
  sjf: { longitude: -48.5495, latitude: -27.5969, zoom: 12 },
  global: { longitude: 0, latitude: 20, zoom: 1.5 },
  america: { longitude: -95, latitude: 38, zoom: 3 },
  mena: { longitude: 45, latitude: 28, zoom: 3.5 },
  eu: { longitude: 15, latitude: 50, zoom: 3.5 },
  asia: { longitude: 105, latitude: 35, zoom: 3 },
  latam: { longitude: -60, latitude: -15, zoom: 3 },
  africa: { longitude: 20, latitude: 5, zoom: 3 },
  oceania: { longitude: 135, latitude: -25, zoom: 3.5 },
};

const MAP_INTERACTION_MODE: MapInteractionMode =
  import.meta.env.VITE_MAP_INTERACTION_MODE === 'flat' ? 'flat' : '3d';

const HAPPY_DARK_STYLE = '/map-styles/happy-dark.json';
const HAPPY_LIGHT_STYLE = '/map-styles/happy-light.json';
const isHappyVariant = SITE_VARIANT === 'happy';

// Zoom thresholds for layer visibility and labels (matches old Map.ts)
// Zoom-dependent layer visibility and labels
const LAYER_ZOOM_THRESHOLDS: Record<string, { minZoom: number; showLabels?: number }> = {
  natural: { minZoom: 1, showLabels: 2 },
  gulfInvestments: { minZoom: 2, showLabels: 5 },
};
// Export for external use
export { LAYER_ZOOM_THRESHOLDS };

// Theme-aware overlay color function Ã¢â‚¬â€ refreshed each buildLayers() call
function getOverlayColors() {
  const isLight = getCurrentTheme() === 'light';
  return {
    // Threat dots: IDENTICAL in both modes (user locked decision)
    hotspotHigh: [255, 68, 68, 200] as [number, number, number, number],
    hotspotElevated: [255, 165, 0, 200] as [number, number, number, number],
    hotspotLow: [255, 255, 0, 180] as [number, number, number, number],

    // Conflict zone fills: more transparent in light mode
    conflict: isLight
      ? [255, 0, 0, 60] as [number, number, number, number]
      : [255, 0, 0, 100] as [number, number, number, number],

    // Infrastructure/category markers: darker variants in light mode for map readability
    base: [0, 150, 255, 200] as [number, number, number, number],
    nuclear: isLight
      ? [180, 120, 0, 220] as [number, number, number, number]
      : [255, 215, 0, 200] as [number, number, number, number],
    datacenter: isLight
      ? [13, 148, 136, 200] as [number, number, number, number]
      : [0, 255, 200, 180] as [number, number, number, number],
    cable: [0, 200, 255, 150] as [number, number, number, number],
    cableHighlight: [255, 100, 100, 200] as [number, number, number, number],
    cableFault: [255, 50, 50, 220] as [number, number, number, number],
    cableDegraded: [255, 165, 0, 200] as [number, number, number, number],
    earthquake: [255, 100, 50, 200] as [number, number, number, number],
    vesselMilitary: [255, 100, 100, 220] as [number, number, number, number],
    flightMilitary: [255, 50, 50, 220] as [number, number, number, number],
    protest: [255, 150, 0, 200] as [number, number, number, number],
    outage: [255, 50, 50, 180] as [number, number, number, number],
    weather: [100, 150, 255, 180] as [number, number, number, number],
    startupHub: isLight
      ? [22, 163, 74, 220] as [number, number, number, number]
      : [0, 255, 150, 200] as [number, number, number, number],
    techHQ: [100, 200, 255, 200] as [number, number, number, number],
    accelerator: isLight
      ? [180, 120, 0, 220] as [number, number, number, number]
      : [255, 200, 0, 200] as [number, number, number, number],
    cloudRegion: [150, 100, 255, 180] as [number, number, number, number],
    stockExchange: isLight
      ? [20, 120, 200, 220] as [number, number, number, number]
      : [80, 200, 255, 210] as [number, number, number, number],
    financialCenter: isLight
      ? [0, 150, 110, 215] as [number, number, number, number]
      : [0, 220, 150, 200] as [number, number, number, number],
    centralBank: isLight
      ? [180, 120, 0, 220] as [number, number, number, number]
      : [255, 210, 80, 210] as [number, number, number, number],
    commodityHub: isLight
      ? [190, 95, 40, 220] as [number, number, number, number]
      : [255, 150, 80, 200] as [number, number, number, number],
    gulfInvestmentSA: [0, 168, 107, 220] as [number, number, number, number],
    gulfInvestmentUAE: [255, 0, 100, 220] as [number, number, number, number],
    ucdpStateBased: [255, 50, 50, 200] as [number, number, number, number],
    ucdpNonState: [255, 165, 0, 200] as [number, number, number, number],
    ucdpOneSided: [255, 255, 0, 200] as [number, number, number, number],
  };
}
// Initialize and refresh on every buildLayers() call
let COLORS = getOverlayColors();

// SVG icons as data URLs for different marker shapes
const MARKER_ICONS = {
  // Square - for datacenters
  square: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="3" fill="white"/></svg>`),
  // Diamond - for hotspots
  diamond: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><polygon points="16,2 30,16 16,30 2,16" fill="white"/></svg>`),
  // Triangle up - for military bases
  triangleUp: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><polygon points="16,2 30,28 2,28" fill="white"/></svg>`),
  // Hexagon - for nuclear
  hexagon: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><polygon points="16,2 28,9 28,23 16,30 4,23 4,9" fill="white"/></svg>`),
  // Circle - fallback
  circle: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="white"/></svg>`),
  // Star - for special markers
  star: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><polygon points="16,2 20,12 30,12 22,19 25,30 16,23 7,30 10,19 2,12 12,12" fill="white"/></svg>`),
  // Airplane silhouette - top-down with wings and tail (pointing north, rotated by trackDeg)
  plane: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M16 2 L17.5 10 L17 12 L27 17 L27 19 L17 16 L17 24 L20 26.5 L20 28 L16 27 L12 28 L12 26.5 L15 24 L15 16 L5 19 L5 17 L15 12 L14.5 10 Z" fill="white"/></svg>`),
};
// @ts-ignore

const _BASES_ICON_MAPPING = { triangleUp: { x: 0, y: 0, width: 32, height: 32, mask: true } };
// @ts-ignore
const _NUCLEAR_ICON_MAPPING = { hexagon: { x: 0, y: 0, width: 32, height: 32, mask: true } };
// @ts-ignore
const _DATACENTER_ICON_MAPPING = { square: { x: 0, y: 0, width: 32, height: 32, mask: true } };
const AIRCRAFT_ICON_MAPPING = { plane: { x: 0, y: 0, width: 32, height: 32, mask: true } };

const CONFLICT_COUNTRY_ISO: Record<string, string[]> = {
  iran: ['IR'],
  ukraine: ['UA'],
  sudan: ['SD'],
  myanmar: ['MM'],
};

function ensureClosedRing(ring: [number, number][]): [number, number][] {
  if (ring.length < 2) return ring;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

export class DeckGLMap {
  private static readonly MAX_CLUSTER_LEAVES = 200;

  private container: HTMLElement;
  private deckOverlay: MapboxOverlay | null = null;
  private maplibreMap: maplibregl.Map | null = null;
  private state: DeckMapState;
  private popup: MapPopup;
  private isResizing = false;
  private savedTopLat: number | null = null;
  private correctingCenter = false;

  // Data stores
  private hotspots: HotspotWithBreaking[];
  private earthquakes: Earthquake[] = [];
  private weatherAlerts: WeatherAlert[] = [];
  private outages: InternetOutage[] = [];
  private naturalEvents: NaturalEvent[] = [];
  private firmsFireData: Array<{ lat: number; lon: number; brightness: number; frp: number; confidence: number; region: string; acq_date: string; daynight: string }> = [];
  private techEvents: TechEventMarker[] = [];
  private flightDelays: AirportDelayAlert[] = [];
  private aircraftPositions: PositionSample[] = [];
  private aircraftFetchTimer: ReturnType<typeof setInterval> | null = null;
  private news: NewsItem[] = [];
  private newsLocations: Array<{ lat: number; lon: number; title: string; threatLevel: string; timestamp?: Date }> = [];
  private newsLocationFirstSeen = new Map<string, number>();
  private climateAnomalies: ClimateAnomaly[] = [];
  private positiveEvents: PositiveGeoEvent[] = [];
  private kindnessPoints: KindnessPoint[] = [];

  // Phase 8 overlay data
  private happinessScores: Map<string, number> = new Map();
  private happinessYear = 0;
  private happinessSource = '';
  // @ts-ignore -- DCE removed
  private countriesGeoJsonData: FeatureCollection<Geometry> | null = null;
  // @ts-ignore -- DCE removed
  private conflictZoneGeoJson: GeoJSON.FeatureCollection | null = null;

  // CII choropleth data
  private ciiScoresMap: Map<string, { score: number; level: string }> = new Map();
  private ciiScoresVersion = 0;

  // Celesc Sensor Data
  private celescLookup = new Map<string, CelescMunicipioPayload>();
  private lastUpdate = Date.now();
  private geojsonData: FeatureCollection | null = null;

  // Country highlight state
  private countryGeoJsonLoaded = false;
  private countryHoverSetup = false;
  private highlightedCountryCode: string | null = null;

  // Callbacks
  private onHotspotClick?: (hotspot: Hotspot) => void;
  private onTimeRangeChange?: (range: TimeRange) => void;
  private onCountryClick?: (country: CountryClickPayload) => void;
  private onLayerChange?: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void;
  private onStateChange?: (state: DeckMapState) => void;
  private onAircraftPositionsUpdate?: (positions: PositionSample[]) => void;

  // Highlighted assets
  private highlightedAssets: Record<AssetType, Set<string>> = {
    pipeline: new Set(),
    cable: new Set(),
    datacenter: new Set(),
    base: new Set(),
    nuclear: new Set(),
  };

  private renderRafId: number | null = null;
  private renderPaused = false;
  private renderPending = false;
  private webglLost = false;
  private usedFallbackStyle = false;
  private styleLoadTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private tileMonitorGeneration = 0;


  private layerCache: Map<string, Layer> = new Map();
  private lastZoomThreshold = 0;
  private protestSC: Supercluster | null = null;
  private techHQSC: Supercluster | null = null;
  private techEventSC: Supercluster | null = null;
  private datacenterSC: Supercluster | null = null;
  private datacenterSCSource: AIDataCenter[] = [];
  private protestClusters: MapProtestCluster[] = [];
  private protestSuperclusterSource: SocialUnrestEvent[] = [];
  private newsPulseIntervalId: ReturnType<typeof setInterval> | null = null;
  private dayNightIntervalId: ReturnType<typeof setInterval> | null = null;
  private cachedNightPolygon: [number, number][] | null = null;
  private readonly startupTime = Date.now();
  // @ts-ignore
  private _lastCableHighlightSignature = '';
  // @ts-ignore
  private _lastCableHealthSignature = '';
  // @ts-ignore
  private _lastPipelineHighlightSignature = '';
  private debouncedRebuildLayers: (() => void) & { cancel(): void };
  private debouncedFetchAircraft: (() => void) & { cancel(): void };
  private rafUpdateLayers: (() => void) & { cancel(): void };
  private handleThemeChange: () => void;
  private handleMapThemeChange: () => void;
  private moveTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private lastAircraftFetchCenter: [number, number] | null = null;
  private lastAircraftFetchZoom = -1;
  private aircraftFetchSeq = 0;

  constructor(container: HTMLElement, initialState: DeckMapState) {
    this.container = container;
    this.state = {
      ...initialState,
      pan: { ...initialState.pan },
      layers: { ...initialState.layers },
    };
    this.hotspots = [...INTEL_HOTSPOTS];

    fetch('https://raw.githubusercontent.com/tbrugz/geodata-br/master/geojson/geojs-42-mun.json')
      .then(res => res.json())
      .then(data => {
        this.geojsonData = data as FeatureCollection;
        this.debouncedRebuildLayers();
      })
      .catch(err => console.warn('[DeckGLMap] Failed to load SC GeoJSON', err));

    window.addEventListener('CELESC_DATA_READY', () => {
      if ((window as any).__CELESC_GLOBAL_DATA__) {
        this.setCelescOutages((window as any).__CELESC_GLOBAL_DATA__);
      }
    });

    // AvaliaÃƒÂ§ÃƒÂ£o sincrÃƒÂ´nica para bater a inaniÃƒÂ§ÃƒÂ£o na carga assÃƒÂ­ncrona da malha (Race Condition)
    if ((window as any).__CELESC_GLOBAL_DATA__) {
      this.setCelescOutages((window as any).__CELESC_GLOBAL_DATA__);
    }

    window.addEventListener('CELESC_CITY_SELECTED', this.handleCityFocus.bind(this));

    this.debouncedRebuildLayers = debounce(() => {
      if (this.renderPaused || this.webglLost || !this.maplibreMap) return;
      this.maplibreMap.resize();
      try { this.deckOverlay?.setProps({ layers: this.buildLayers() }); } catch { /* map mid-teardown */ }
      this.maplibreMap.triggerRepaint();
    }, 150);
    // DCE: fetchServerBases removed
    this.debouncedFetchAircraft = debounce(() => this.fetchViewportAircraft(), 500);
    this.rafUpdateLayers = rafSchedule(() => {
      if (this.renderPaused || this.webglLost || !this.maplibreMap) return;
      try { this.deckOverlay?.setProps({ layers: this.buildLayers() }); } catch { /* map mid-teardown */ }
      this.maplibreMap?.triggerRepaint();
    });

    this.setupDOM();
    this.popup = new MapPopup(container);

    this.handleThemeChange = () => {
      if (isHappyVariant) {
        this.switchBasemap();
        return;
      }
      const provider = getMapProvider();
      const mapTheme = getMapTheme(provider);
      const paintTheme = isLightMapTheme(mapTheme) ? 'light' as const : 'dark' as const;
      this.updateCountryLayerPaint(paintTheme);
      this.render();
    };
    window.addEventListener('theme-changed', this.handleThemeChange);

    this.handleMapThemeChange = () => {
      this.switchBasemap();
    };
    window.addEventListener('map-theme-changed', this.handleMapThemeChange);

    this.initMapLibre();

    this.maplibreMap?.on('load', () => {
      localizeMapLabels(this.maplibreMap);
      this.rebuildTechHQSupercluster();
      this.rebuildDatacenterSupercluster();
      this.initDeck();
      this.loadCountryBoundaries();
    // DCE: fetchServerBases removed
      this.render();
    });

    this.createControls();
    this.createTimeSlider();
    this.createLayerToggles();
    this.createLegend();

    // Start day/night timer only if layer is initially enabled
    if (this.state.layers.dayNight) {
      this.startDayNightTimer();
    }
  }

  private startDayNightTimer(): void {
    if (this.dayNightIntervalId) return;
    this.cachedNightPolygon = this.computeNightPolygon();
    this.dayNightIntervalId = setInterval(() => {
      this.cachedNightPolygon = this.computeNightPolygon();
      this.render();
    }, 5 * 60 * 1000);
  }

  private stopDayNightTimer(): void {
    if (this.dayNightIntervalId) {
      clearInterval(this.dayNightIntervalId);
      this.dayNightIntervalId = null;
    }
    this.cachedNightPolygon = null;
  }

  private setupDOM(): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'deckgl-map-wrapper';
    wrapper.id = 'deckglMapWrapper';
    wrapper.style.cssText = 'position: relative; width: 100%; height: 100%; overflow: hidden;';

    // MapLibre container - deck.gl renders directly into MapLibre via MapboxOverlay
    const mapContainer = document.createElement('div');
    mapContainer.id = 'deckgl-basemap';
    mapContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%;';
    wrapper.appendChild(mapContainer);

    const attribution = document.createElement('div');
    attribution.className = 'map-attribution';
    attribution.innerHTML = isHappyVariant
      ? 'Ã‚Â© <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a> Ã‚Â© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
      : 'Ã‚Â© <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> Ã‚Â© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
    wrapper.appendChild(attribution);

    this.container.appendChild(wrapper);
  }

  private initMapLibre(): void {
    if (maplibregl.getRTLTextPluginStatus() === 'unavailable') {
      maplibregl.setRTLTextPlugin(
        '/mapbox-gl-rtl-text.min.js',
        true,
      );
    }

    const initialProvider = isHappyVariant ? 'openfreemap' as const : getMapProvider();
    if (initialProvider === 'pmtiles' || initialProvider === 'auto') registerPMTilesProtocol();

    const preset = VIEW_PRESETS[this.state.view];
    const initialMapTheme = getMapTheme(initialProvider);
    const primaryStyle = isHappyVariant
      ? (getCurrentTheme() === 'light' ? HAPPY_LIGHT_STYLE : HAPPY_DARK_STYLE)
      : getStyleForProvider(initialProvider, initialMapTheme);
    if (!isHappyVariant && typeof primaryStyle === 'string' && !primaryStyle.includes('pmtiles')) {
      this.usedFallbackStyle = true;
      const attr = this.container.querySelector('.map-attribution');
      if (attr) attr.innerHTML = 'Ã‚Â© <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> Ã‚Â© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
    }

    const basemapEl = document.getElementById('deckgl-basemap');
    if (!basemapEl) return;

    this.maplibreMap = new maplibregl.Map({
      container: basemapEl,
      style: primaryStyle,
      center: [preset.longitude, preset.latitude],
      zoom: preset.zoom,
      renderWorldCopies: false,
      attributionControl: false,
      interactive: true,
      ...(MAP_INTERACTION_MODE === 'flat'
        ? {
          maxPitch: 0,
          pitchWithRotate: false,
          dragRotate: false,
          touchPitch: false,
        }
        : {}),
    });

    const recreateWithFallback = () => {
      if (this.usedFallbackStyle) return;
      this.usedFallbackStyle = true;
      const fallback = isLightMapTheme(initialMapTheme) ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE;
      console.warn(`[DeckGLMap] Primary basemap failed, recreating with fallback: ${fallback}`);
      const attr = this.container.querySelector('.map-attribution');
      if (attr) attr.innerHTML = 'Ã‚Â© <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> Ã‚Â© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
      this.maplibreMap?.remove();
      const fallbackEl = document.getElementById('deckgl-basemap');
      if (!fallbackEl) return;
      this.maplibreMap = new maplibregl.Map({
        container: fallbackEl,
        style: fallback,
        center: [preset.longitude, preset.latitude],
        zoom: preset.zoom,
        renderWorldCopies: false,
        attributionControl: false,
        interactive: true,
        ...(MAP_INTERACTION_MODE === 'flat'
          ? {
            maxPitch: 0,
            pitchWithRotate: false,
            dragRotate: false,
            touchPitch: false,
          }
          : {}),
      });
      this.maplibreMap.on('load', () => {
        localizeMapLabels(this.maplibreMap);
        this.rebuildTechHQSupercluster();
        this.rebuildDatacenterSupercluster();
        this.initDeck();
        this.loadCountryBoundaries();
    // DCE: fetchServerBases removed
        this.render();
      });
    };

    let tileLoadOk = false;
    let tileErrorCount = 0;

    this.maplibreMap.on('error', (e: { error?: Error; message?: string }) => {
      const msg = e.error?.message ?? e.message ?? '';
      console.warn('[DeckGLMap] map error:', msg);
      if (msg.includes('Failed to fetch') || msg.includes('AJAXError') || msg.includes('CORS') || msg.includes('NetworkError') || msg.includes('403') || msg.includes('Forbidden')) {
        tileErrorCount++;
        if (!tileLoadOk && tileErrorCount >= 2) {
          recreateWithFallback();
        }
      }
    });

    this.maplibreMap.on('data', (e: { dataType?: string }) => {
      if (e.dataType === 'source') {
        tileLoadOk = true;
        if (this.styleLoadTimeoutId) {
          clearTimeout(this.styleLoadTimeoutId);
          this.styleLoadTimeoutId = null;
        }
      }
    });

    this.styleLoadTimeoutId = setTimeout(() => {
      this.styleLoadTimeoutId = null;
      if (!tileLoadOk) recreateWithFallback();
    }, 10000);

    const canvas = this.maplibreMap.getCanvas();
    canvas.addEventListener('webglcontextlost', (e: any) => {
      e.preventDefault();
      this.webglLost = true;
      console.warn('[DeckGLMap] WebGL context lost Ã¢â‚¬â€ will restore when browser recovers');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.webglLost = false;
      console.info('[DeckGLMap] WebGL context restored');
      this.maplibreMap?.triggerRepaint();
    });

    // Pin top edge during drag-resize: correct center shift synchronously
    // inside MapLibre's own resize() call (before it renders the frame).
    this.maplibreMap.on('move', () => {
      if (this.correctingCenter || !this.isResizing || !this.maplibreMap) return;
      if (this.savedTopLat === null) return;

      const w = this.maplibreMap.getCanvas().clientWidth;
      if (w <= 0) return;
      const currentTop = this.maplibreMap.unproject([w / 2, 0]).lat;
      const delta = this.savedTopLat - currentTop;

      if (Math.abs(delta) > 1e-6) {
        this.correctingCenter = true;
        const c = this.maplibreMap.getCenter();
        const clampedLat = Math.max(-90, Math.min(90, c.lat + delta));
        this.maplibreMap.jumpTo({ center: [c.lng, clampedLat] });
        this.correctingCenter = false;
        // Do NOT update savedTopLat Ã¢â‚¬â€ keep the original mousedown position
        // so every frame targets the exact same geographic anchor.
      }
    });
  }

  private initDeck(): void {
    if (!this.maplibreMap) return;

    this.deckOverlay = new MapboxOverlay({
      interleaved: true,
      layers: this.buildLayers(),
      getTooltip: (info: PickingInfo) => this.getTooltip(info),
      onClick: (info: PickingInfo) => this.handleClick(info),
      pickingRadius: 10,
      useDevicePixels: window.devicePixelRatio > 2 ? 2 : true,
      onError: (error: Error) => console.warn('[DeckGLMap] Render error (non-fatal):', error.message),
    });

    this.maplibreMap.addControl(this.deckOverlay as unknown as maplibregl.IControl);

    this.maplibreMap.on('movestart', () => {
      if (this.moveTimeoutId) {
        clearTimeout(this.moveTimeoutId);
        this.moveTimeoutId = null;
      }
    });

    this.maplibreMap.on('moveend', () => {
      (this as any).lastSCZoom = -1;
      this.rafUpdateLayers();
      this.debouncedFetchAircraft();
      this.state.zoom = this.maplibreMap?.getZoom() ?? this.state.zoom;
      this.onStateChange?.(this.getState());
    });

    this.maplibreMap.on('move', () => {
      if (this.moveTimeoutId) clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = setTimeout(() => {
        (this as any).lastSCZoom = -1;
        this.rafUpdateLayers();
      }, 100);
    });

    this.maplibreMap.on('zoom', () => {
      if (this.moveTimeoutId) clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = setTimeout(() => {
        (this as any).lastSCZoom = -1;
        this.rafUpdateLayers();
      }, 100);
    });

    this.maplibreMap.on('zoomend', () => {
      const currentZoom = Math.floor(this.maplibreMap?.getZoom() || 2);
      const thresholdCrossed = Math.abs(currentZoom - this.lastZoomThreshold) >= 1;
      if (thresholdCrossed) {
        this.lastZoomThreshold = currentZoom;
        this.debouncedRebuildLayers();
      }
      this.state.zoom = this.maplibreMap?.getZoom() ?? this.state.zoom;
      this.onStateChange?.(this.getState());
    });
  }

  // Recebedor Ativo de dados do Beacon/Convex OSINT
  public setBeaconAlerts(alertas: import('../services/beacon-client').BeaconAlert[]): void {
      (this as any).beaconAlerts = alertas || [];
      if (this.deckOverlay) {
          this.deckOverlay.setProps({ layers: this.buildLayers() });
      }
  }

  public setCelescOutages(data: CelescMunicipioPayload[]): void {
    if (!Array.isArray(data) || data.length === 0) return;
    
    // Garante que a chave seja String estrita para o lookup funcionar
    this.celescLookup = new Map(data.map(c => [String(c.codIbge), c]));
    this.lastUpdate = Date.now();
    
    // Envia o pulso de vida para o motor do Mapbox/Deck.gl
    if (this.deckOverlay) {
      this.deckOverlay.setProps({
        layers: this.buildLayers()
      });
    } else {
      console.error("[Grid 48] Ã¢ÂÅ’ InstÃƒÂ¢ncia do deckOverlay nÃƒÂ£o encontrada para atualizar camadas.");
    }
  }

  private setSelectedCityInfo(cidade: CelescMunicipioPayload | null): void {
    (this as any).selectedCityInfo = cidade;
    let tt = document.getElementById('deckgl-forced-tooltip');

    if (!cidade) {
      if (tt && tt.parentNode) tt.parentNode.removeChild(tt);
      return;
    }

    if (!tt) {
      tt = document.createElement('div');
      tt.id = 'deckgl-forced-tooltip';
      tt.style.cssText = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background-color: rgba(0, 0, 0, 0.9); border: 1px solid #374151; padding: 1rem; border-radius: 0.25rem; color: #ffffff; font-family: monospace; font-size: 0.75rem; z-index: 50; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25); pointer-events: none; min-width: 250px;';
      this.container.appendChild(tt);
    }

    const pctFormatted = typeof cidade.pct === 'number' ? (cidade.pct % 1 === 0 ? cidade.pct : cidade.pct.toFixed(2)) : cidade.pct;
    const bairrosHtml = cidade.bairros && cidade.bairros.length > 0 
      ? cidade.bairros.map(b => 
          `<div style="display: flex; justify-content: space-between; border-bottom: 1px solid #1f2937; padding: 0.25rem 0;">
             <span style="color: #9ca3af;">${escapeHtml(b.nome)}</span>
             <span style="color: #fca5a5; margin-left: 1rem;">${b.ucsAfetadas}</span>
           </div>`
        ).join('')
      : '<div style="color: #9ca3af; padding: 0.25rem 0;">Sem UCs afetadas por bairro</div>';

    tt.innerHTML = `
      <h3 style="color: #f87171; font-weight: 700; margin-bottom: 0.5rem; font-size: 1rem;">${escapeHtml(cidade.nome)} - ${pctFormatted}% OFF</h3>
      <p style="margin-bottom: 0.5rem; font-size: 0.875rem;">Total: ${cidade.ucsAfetadas} UCs Offline</p>
      <div style="max-height: 8rem; overflow-y: auto; padding-right: 0.25rem; margin-top: 0.5rem;">
        ${bairrosHtml}
      </div>
    `;
  }

  handleBeaconHover(info: any) {
    let tt = document.getElementById('deckgl-forced-tooltip');

    if (!info.object) {
      if (tt && tt.parentNode) tt.parentNode.removeChild(tt);
      return;
    }

    if (!tt) {
      tt = document.createElement('div');
      tt.id = 'deckgl-forced-tooltip';
      tt.style.cssText = 'position: absolute; background-color: rgba(0, 0, 0, 0.9); border: 1px solid #374151; padding: 1rem; border-radius: 0.25rem; color: #ffffff; font-family: monospace; font-size: 0.75rem; z-index: 50; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25); pointer-events: none; min-width: 200px; transform: translate(-50%, -100%) translateY(-20px);';
      this.container.appendChild(tt);
    }

    const { titulo, risco } = info.object;
    const color = risco === 'Alto' ? '#ef4444' : risco === 'Medio' ? '#f97316' : '#eab308';
    tt.style.left = info.x + 'px';
    tt.style.top = info.y + 'px';
    const titleDiv = document.createElement('p');
    titleDiv.style.cssText = "margin: 0; font-size: 0.85rem; font-weight: 700;";
    titleDiv.textContent = titulo;
    
    tt.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; background-color: ${color}; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold; margin-bottom: 8px;">
         Risco ${risco}
      </div>
    `;
    tt.appendChild(titleDiv);
  }

  handleCityFocus(event: any) {
    console.log("[Grid 48] Ã¢Å¡Â¡ Evento recebido no DeckGLMap:", event);

    // 1. Desempacotar o Payload (Defesa contra o Hotfix #1 Stringified)
    let cidade;
    try {
      cidade = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail;
    } catch (e: any) {
      console.error("[Grid 48] Ã¢ÂÅ’ Erro ao decodificar event.detail:", e);
      return;
    }
    
    console.log("[Grid 48] Ã°Å¸â€œÂ Cidade extraÃƒÂ­da:", cidade);

    if (!cidade || !cidade.codIbge) {
      console.warn("[Grid 48] Ã¢Å¡Â Ã¯Â¸Â OperaÃƒÂ§ÃƒÂ£o abortada: codIbge ausente no payload.");
      return;
    }
    if (!this.geojsonData || !(this.geojsonData as any).features) {
      console.error("[Grid 48] Ã¢ÂÅ’ Malha do IBGE nÃƒÂ£o encontrada na memÃƒÂ³ria (this.geojsonData).");
      return;
    }

    // 2. Achar a geometria exata da cidade no GeoJSON
    const feature = (this.geojsonData as any).features.find((f: any) => String(f.properties.id) === String(cidade.codIbge));
    if (!feature || !feature.geometry) {
      console.warn("[Grid 48] Ã¢Å¡Â Ã¯Â¸Â Geometria nÃƒÂ£o encontrada no IBGE para o cÃƒÂ³digo:", cidade.codIbge);
      return;
    }

    // 3. Achar o centrÃƒÂ³ide achatando as coordenadas da Bounding Box
    try {
      const flatCoords = feature.geometry.coordinates.flat(Infinity);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < flatCoords.length; i += 2) {
        if (flatCoords[i] < minX) minX = flatCoords[i];
        if (flatCoords[i] > maxX) maxX = flatCoords[i];
        if (flatCoords[i+1] < minY) minY = flatCoords[i+1];
        if (flatCoords[i+1] > maxY) maxY = flatCoords[i+1];
      }
      const lon = (minX + maxX) / 2;
      const lat = (minY + maxY) / 2;

      console.log(`[Grid 48] Ã°Å¸Å½Â¯ Voando para ${cidade.nome} [Lat: ${lat.toFixed(4)}, Lon: ${lon.toFixed(4)}]`);

      // 4. Injetar a nova cÃƒÂ¢mera diretamente no mapa base nativo (MapLibre/MapBox)
      if (this.maplibreMap) {
        this.maplibreMap.flyTo({
          center: [lon, lat],
          zoom: 11.5,
          speed: 1.2,
          essential: true
        });
      } else {
        console.error("[Grid 48] Ã¢ÂÅ’ InstÃƒÂ¢ncia this.maplibreMap nÃƒÂ£o encontrada!");
      }

      // 5. Acionar a fÃƒÂ¡brica sintÃƒÂ©tica do Tooltip
      if (typeof this.setSelectedCityInfo === 'function') {
        this.setSelectedCityInfo(cidade);
      } else {
        console.warn("[Grid 48] Ã¢Å¡Â Ã¯Â¸Â FunÃƒÂ§ÃƒÂ£o setSelectedCityInfo ausente. Tooltip nÃƒÂ£o serÃƒÂ¡ exibido.");
      }

    } catch (err: any) {
      console.error("[Grid 48] Ã¢ÂÅ’ Falha crÃƒÂ­tica no cÃƒÂ¡lculo de FlyTo:", err);
    }
  }


  public setIsResizing(value: boolean): void {
    this.isResizing = value;
    if (value && this.maplibreMap) {
      const w = this.maplibreMap.getCanvas().clientWidth;
      if (w > 0) {
        this.savedTopLat = this.maplibreMap.unproject([w / 2, 0]).lat;
      }
    } else {
      this.savedTopLat = null;
    }
  }

  public resize(): void {
    this.maplibreMap?.resize();
  }
  // @ts-ignore

  private _getSetSignature(set: Set<string>): string {
    return [...set].sort().join('|');
  }

  private hasRecentNews(now = Date.now()): boolean {
    for (const ts of this.newsLocationFirstSeen.values()) {
      if (now - ts < 30_000) return true;
    }
    return false;
  }

  private getTimeRangeMs(range: TimeRange = this.state.timeRange): number {
    const ranges: Record<TimeRange, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '48h': 48 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      'all': Infinity,
    };
    return ranges[range];
  }

  private parseTime(value: Date | string | number | undefined | null): number | null {
    if (value == null) return null;
    const ts = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  private filterByTime<T>(
    items: T[],
    getTime: (item: T) => Date | string | number | undefined | null
  ): T[] {
    if (this.state.timeRange === 'all') return items;
    const cutoff = Date.now() - this.getTimeRangeMs();
    return items.filter((item) => {
      const ts = this.parseTime(getTime(item));
      return ts == null ? true : ts >= cutoff;
    });
  }

  private getFilteredProtests(): SocialUnrestEvent[] {
    return this.filterByTime((this as any).protests, (event) => event.time);
  }



  private rebuildProtestSupercluster(source: SocialUnrestEvent[] = this.getFilteredProtests()): void {
    this.protestSuperclusterSource = source;
    const points = source.map((p, i) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] as [number, number] },
      properties: {
        index: i,
        country: p.country,
        severity: p.severity,
        eventType: p.eventType,
        sourceType: p.sourceType,
        validated: Boolean(p.validated),
        fatalities: Number.isFinite(p.fatalities) ? Number(p.fatalities) : 0,
        timeMs: p.time.getTime(),
      },
    }));
    this.protestSC = new Supercluster({
      radius: 60,
      maxZoom: 14,
      map: (props: Record<string, unknown>) => ({
        index: Number(props.index ?? 0),
        country: String(props.country ?? ''),
        maxSeverityRank: props.severity === 'high' ? 2 : props.severity === 'medium' ? 1 : 0,
        riotCount: props.eventType === 'riot' ? 1 : 0,
        highSeverityCount: props.severity === 'high' ? 1 : 0,
        verifiedCount: props.validated ? 1 : 0,
        totalFatalities: Number(props.fatalities ?? 0) || 0,
        riotTimeMs: props.eventType === 'riot' && props.sourceType !== 'gdelt' && Number.isFinite(Number(props.timeMs)) ? Number(props.timeMs) : 0,
      }),
      reduce: (acc: Record<string, unknown>, props: Record<string, unknown>) => {
        acc.maxSeverityRank = Math.max(Number(acc.maxSeverityRank ?? 0), Number(props.maxSeverityRank ?? 0));
        acc.riotCount = Number(acc.riotCount ?? 0) + Number(props.riotCount ?? 0);
        acc.highSeverityCount = Number(acc.highSeverityCount ?? 0) + Number(props.highSeverityCount ?? 0);
        acc.verifiedCount = Number(acc.verifiedCount ?? 0) + Number(props.verifiedCount ?? 0);
        acc.totalFatalities = Number(acc.totalFatalities ?? 0) + Number(props.totalFatalities ?? 0);
        const accRiot = Number(acc.riotTimeMs ?? 0);
        const propRiot = Number(props.riotTimeMs ?? 0);
        acc.riotTimeMs = Number.isFinite(propRiot) ? Math.max(accRiot, propRiot) : accRiot;
        if (!acc.country && props.country) acc.country = props.country;
      },
    });
    this.protestSC.load(points);
    (this as any).lastSCZoom = -1;
  }

  private rebuildTechHQSupercluster(): void {
    const points = TECH_HQS.map((h, i) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [h.lon, h.lat] as [number, number] },
      properties: {
        index: i,
        city: h.city,
        country: h.country,
        type: h.type,
      },
    }));
    this.techHQSC = new Supercluster({
      radius: 50,
      maxZoom: 14,
      map: (props: Record<string, unknown>) => ({
        index: Number(props.index ?? 0),
        city: String(props.city ?? ''),
        country: String(props.country ?? ''),
        faangCount: props.type === 'faang' ? 1 : 0,
        unicornCount: props.type === 'unicorn' ? 1 : 0,
        publicCount: props.type === 'public' ? 1 : 0,
      }),
      reduce: (acc: Record<string, unknown>, props: Record<string, unknown>) => {
        acc.faangCount = Number(acc.faangCount ?? 0) + Number(props.faangCount ?? 0);
        acc.unicornCount = Number(acc.unicornCount ?? 0) + Number(props.unicornCount ?? 0);
        acc.publicCount = Number(acc.publicCount ?? 0) + Number(props.publicCount ?? 0);
        if (!acc.city && props.city) acc.city = props.city;
        if (!acc.country && props.country) acc.country = props.country;
      },
    });
    this.techHQSC.load(points);
    (this as any).lastSCZoom = -1;
  }

  private rebuildTechEventSupercluster(): void {
    const points = this.techEvents.map((e, i) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [e.lng, e.lat] as [number, number] },
      properties: {
        index: i,
        location: e.location,
        country: e.country,
        daysUntil: e.daysUntil,
      },
    }));
    this.techEventSC = new Supercluster({
      radius: 50,
      maxZoom: 14,
      map: (props: Record<string, unknown>) => {
        const daysUntil = Number(props.daysUntil ?? Number.MAX_SAFE_INTEGER);
        return {
          index: Number(props.index ?? 0),
          location: String(props.location ?? ''),
          country: String(props.country ?? ''),
          soonestDaysUntil: Number.isFinite(daysUntil) ? daysUntil : Number.MAX_SAFE_INTEGER,
          soonCount: Number.isFinite(daysUntil) && daysUntil <= 14 ? 1 : 0,
        };
      },
      reduce: (acc: Record<string, unknown>, props: Record<string, unknown>) => {
        acc.soonestDaysUntil = Math.min(
          Number(acc.soonestDaysUntil ?? Number.MAX_SAFE_INTEGER),
          Number(props.soonestDaysUntil ?? Number.MAX_SAFE_INTEGER),
        );
        acc.soonCount = Number(acc.soonCount ?? 0) + Number(props.soonCount ?? 0);
        if (!acc.location && props.location) acc.location = props.location;
        if (!acc.country && props.country) acc.country = props.country;
      },
    });
    this.techEventSC.load(points);
    (this as any).lastSCZoom = -1;
  }

  private rebuildDatacenterSupercluster(): void {
    const activeDCs = AI_DATA_CENTERS.filter(dc => dc.status !== 'decommissioned');
    this.datacenterSCSource = activeDCs;
    const points = activeDCs.map((dc, i) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [dc.lon, dc.lat] as [number, number] },
      properties: {
        index: i,
        country: dc.country,
        chipCount: dc.chipCount,
        powerMW: dc.powerMW ?? 0,
        status: dc.status,
      },
    }));
    this.datacenterSC = new Supercluster({
      radius: 70,
      maxZoom: 14,
      map: (props: Record<string, unknown>) => ({
        index: Number(props.index ?? 0),
        country: String(props.country ?? ''),
        totalChips: Number(props.chipCount ?? 0) || 0,
        totalPowerMW: Number(props.powerMW ?? 0) || 0,
        existingCount: props.status === 'existing' ? 1 : 0,
        plannedCount: props.status === 'planned' ? 1 : 0,
      }),
      reduce: (acc: Record<string, unknown>, props: Record<string, unknown>) => {
        acc.totalChips = Number(acc.totalChips ?? 0) + Number(props.totalChips ?? 0);
        acc.totalPowerMW = Number(acc.totalPowerMW ?? 0) + Number(props.totalPowerMW ?? 0);
        acc.existingCount = Number(acc.existingCount ?? 0) + Number(props.existingCount ?? 0);
        acc.plannedCount = Number(acc.plannedCount ?? 0) + Number(props.plannedCount ?? 0);
        if (!acc.country && props.country) acc.country = props.country;
      },
    });
    this.datacenterSC.load(points);
    (this as any).lastSCZoom = -1;
  }





  private isLayerVisible(layerKey: keyof MapLayers): boolean {
    const threshold = LAYER_ZOOM_THRESHOLDS[layerKey];
    if (!threshold) return true;
    const zoom = this.maplibreMap?.getZoom() || 2;
    return zoom >= threshold.minZoom;
  }

  private buildLayers(): LayersList {
    const startTime = performance.now();
    // Refresh theme-aware overlay colors on each rebuild
    COLORS = getOverlayColors();
    const layers: (Layer | null | false)[] = [];
    const { layers: mapLayers } = this.state;
    const filteredEarthquakes = mapLayers.natural ? this.filterByTime(this.earthquakes, (eq) => eq.occurredAt) : [];
    const filteredNaturalEvents = mapLayers.natural ? this.filterByTime(this.naturalEvents, (event) => event.date) : [];
    const filteredWeatherAlerts = mapLayers.weather ? this.filterByTime(this.weatherAlerts, (alert) => alert.onset) : [];
    const filteredOutages = mapLayers.outages ? this.filterByTime(this.outages, (outage) => outage.pubDate) : [];
    const filteredFlightDelays = mapLayers.flights ? this.filterByTime(this.flightDelays, (delay) => delay.updatedAt) : [];

    // Day/night overlay (rendered first as background)
    if (mapLayers.dayNight) {
      if (!this.dayNightIntervalId) this.startDayNightTimer();
      layers.push(this.createDayNightLayer());
    } else {
      if (this.dayNightIntervalId) this.stopDayNightTimer();
      this.layerCache.delete('day-night-layer');
    }



    // Earthquakes layer
    if (mapLayers.natural && filteredEarthquakes.length > 0) {
      layers.push(this.createEarthquakesLayer(filteredEarthquakes));
    }

    // Natural events layers (non-TC scatter + TC tracks/cones/centers)
    if (mapLayers.natural && filteredNaturalEvents.length > 0) {
      layers.push(...this.createNaturalEventsLayers(filteredNaturalEvents));
    }

    // Satellite fires layer (NASA FIRMS)
    if (mapLayers.fires && this.firmsFireData.length > 0) {
      layers.push(this.createFiresLayer());
    }

    // Weather alerts layer
    if (mapLayers.weather && filteredWeatherAlerts.length > 0) {
      layers.push(this.createWeatherLayer(filteredWeatherAlerts));
    }

    // Internet outages layer
    if (mapLayers.outages && filteredOutages.length > 0) {
      layers.push(this.createOutagesLayer(filteredOutages));
    }

    // Aviation layer (flight delays + NOTAM closures + aircraft positions)
    if (mapLayers.flights && filteredFlightDelays.length > 0) {
      layers.push(this.createFlightDelaysLayer(filteredFlightDelays));
      const closures = filteredFlightDelays.filter(d => d.delayType === 'closure');
      if (closures.length > 0) {
        layers.push(this.createNotamOverlayLayer(closures));
      }
    }

    // Aircraft positions layer (live tracking, under flights toggle)
    if (mapLayers.flights && this.aircraftPositions.length > 0) {
      layers.push(this.createAircraftPositionsLayer());
    }

    // Climate anomalies heatmap layer
    if (mapLayers.climate && this.climateAnomalies.length > 0) {
      layers.push((this as any).createClimateHeatmapLayer());
    }


    // News geo-locations (always shown if data exists)
    if (this.newsLocations.length > 0) {
      layers.push(...this.createNewsLocationsLayer());
    }

    // Celesc Sensor
    if (this.geojsonData) {
      layers.push(
        new GeoJsonLayer({
          id: 'sc-municipios',
          data: this.geojsonData,
          visible: this.state.layers.celescOutages ?? true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 80] as [number, number, number, number],
          getFillColor: (feature: any) => {
            if (!(window as any).geoJsonLogPrinted) {
              console.log("[Grid 48] Ã°Å¸Å¡Â¨ ESTRUTURA REAL DO GEOJSON:", feature.properties);
              (window as any).geoJsonLogPrinted = true;
            }

            if (!this.celescLookup) return [60, 60, 60, 40] as [number, number, number, number];
            const cidade = this.celescLookup.get(String(feature.properties.id));
            
            if (!cidade || typeof cidade.pct !== 'number' || cidade.pct === 0) return [60, 60, 60, 40] as [number, number, number, number];
            
            if (cidade.pct >= 50) return [255, 0, 0, 200] as [number, number, number, number];
            if (cidade.pct >= 20) return [255, 140, 0, 200] as [number, number, number, number];
            if (cidade.pct >= 5)  return [255, 204, 0, 200] as [number, number, number, number];
            return [0, 200, 0, 150] as [number, number, number, number];
          },
          updateTriggers: {
            getFillColor: [this.lastUpdate]
          }
        })
      );

    // Beacon OSINT Hotspots via O(1) Geometry Lookup
    if (this.state.layers.weather && (this as any).beaconAlerts && (this as any).beaconAlerts.length > 0 && this.geojsonData) {
       const featuresArray = (this.geojsonData as any).features || [];
       const pts: any[] = [];
       for (const al of (this as any).beaconAlerts) {
           for (const ibge of al.cidades_afetadas_ibge) {
               const f = featuresArray.find((feat: any) => String(feat.properties.id) === String(ibge));
               if (f && f.geometry) {
                   const flatCoords = f.geometry.coordinates.flat(Infinity);
                   let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                   for (let i = 0; i < flatCoords.length; i += 2) {
                       if (flatCoords[i] < minX) minX = flatCoords[i];
                       if (flatCoords[i] > maxX) maxX = flatCoords[i];
                       if (flatCoords[i+1] < minY) minY = flatCoords[i+1];
                       if (flatCoords[i+1] > maxY) maxY = flatCoords[i+1];
                   }
                   const lon = (minX + maxX) / 2;
                   const lat = (minY + maxY) / 2;
                   pts.push({ position: [lon, lat], titulo: al.titulo, risco: al.nivel_risco });
               }
           }
       }

       if(pts.length > 0) {
           layers.push(
               new ScatterplotLayer({
                   id: 'beacon-osint-threats',
                   data: pts,
                   getPosition: (d: any) => d.position,
                   getRadius: (d: any) => d.risco === 'Alto' ? 12000 : (d.risco === 'Medio' ? 8000 : 5000),
                   getFillColor: (d: any) => d.risco === 'Alto' ? [255, 0, 0, 200] : (d.risco === 'Medio' ? [255, 165, 0, 180] : [255, 255, 0, 180]),
                   pickable: true,
                   onHover: (info: any) => this.handleBeaconHover(info),
                   opacity: 0.8,
                   stroked: true,
                   getLineColor: [255, 255, 255],
                   lineWidthMinPixels: 2,
                   updateTriggers: {
                     getFillColor: [pts.length]
                   }
               })
           );
       }
    }
    }

    const result = layers.filter(Boolean) as LayersList;
    const elapsed = performance.now() - startTime;
    if (import.meta.env.DEV && elapsed > 16) {
      console.warn(`[DeckGLMap] buildLayers took ${elapsed.toFixed(2)}ms (>16ms budget), ${result.length} layers`);
    }
    return result;
  }

  // Layer creation methods
  // @ts-ignore


  private _buildConflictZoneGeoJson(): GeoJSON.FeatureCollection {
    if ((this as any).conflictZoneGeoJson) return (this as any).conflictZoneGeoJson;

    const features: GeoJSON.Feature[] = [];

    for (const zone of CONFLICT_ZONES) {
      const isoCodes = CONFLICT_COUNTRY_ISO[zone.id];
      let usedCountryGeometry = false;

      if (isoCodes?.length && (this as any).countriesGeoJsonData) {
        for (const feature of (this as any).countriesGeoJsonData.features) {
          const code = feature.properties?.['ISO3166-1-Alpha-2'];
          if (typeof code !== 'string' || !isoCodes.includes(code)) continue;

          features.push({
            type: 'Feature',
            properties: { id: zone.id, name: zone.name, intensity: zone.intensity },
            geometry: feature.geometry,
          });
          usedCountryGeometry = true;
        }
      }

      if (usedCountryGeometry) continue;

      features.push({
        type: 'Feature',
        properties: { id: zone.id, name: zone.name, intensity: zone.intensity },
        geometry: { type: 'Polygon', coordinates: [ensureClosedRing(zone.coords)] },
      });
    }

    (this as any).conflictZoneGeoJson = { type: 'FeatureCollection', features };
    return (this as any).conflictZoneGeoJson;
  }
  // @ts-ignore



  private _getBasesData(): MilitaryBaseEnriched[] {
    return (this as any).serverBasesLoaded ? (this as any).serverBases : MILITARY_BASES as MilitaryBaseEnriched[];
  }
  // @ts-ignore

  private _getBaseColor(type: string, a: number): [number, number, number, number] {
    switch (type) {
      case 'us-nato': return [68, 136, 255, a];
      case 'russia': return [255, 68, 68, a];
      case 'china': return [255, 136, 68, a];
      case 'uk': return [68, 170, 255, a];
      case 'france': return [0, 85, 164, a];
      case 'india': return [255, 153, 51, a];
      case 'japan': return [188, 0, 45, a];
      default: return [136, 136, 136, a];
    }
  }







  private createFlightDelaysLayer(delays: AirportDelayAlert[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'flight-delays-layer',
      data: delays,
      getPosition: (d: any) => [d.lon, d.lat],
      getRadius: (d) => {
        if (d.severity === 'severe') return 15000;
        if (d.severity === 'major') return 12000;
        if (d.severity === 'moderate') return 10000;
        return 8000;
      },
      getFillColor: (d: any) => {
        if (d.severity === 'severe') return [255, 50, 50, 200] as [number, number, number, number];
        if (d.severity === 'major') return [255, 150, 0, 200] as [number, number, number, number];
        if (d.severity === 'moderate') return [255, 200, 100, 180] as [number, number, number, number];
        return [180, 180, 180, 150] as [number, number, number, number];
      },
      radiusMinPixels: 4,
      radiusMaxPixels: 15,
      pickable: true,
    });
  }

  private createNotamOverlayLayer(closures: AirportDelayAlert[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'notam-overlay-layer',
      data: closures,
      getPosition: (d: any) => [d.lon, d.lat],
      getRadius: 55000,
      getFillColor: [255, 40, 40, 100] as [number, number, number, number],
      getLineColor: [255, 40, 40, 200] as [number, number, number, number],
      stroked: true,
      lineWidthMinPixels: 2,
      radiusMinPixels: 8,
      radiusMaxPixels: 40,
      pickable: true,
    });
  }

  private createAircraftPositionsLayer(): IconLayer<PositionSample> {
    return new IconLayer<PositionSample>({
      id: 'aircraft-positions-layer',
      data: this.aircraftPositions,
      getPosition: (d: any) => [d.lon, d.lat],
      getIcon: () => 'plane',
      iconAtlas: MARKER_ICONS.plane,
      iconMapping: AIRCRAFT_ICON_MAPPING,
      getSize: (d) => d.onGround ? 14 : 18,
      getColor: (d) => {
        if (d.onGround) return [120, 120, 120, 160] as [number, number, number, number];
        return [160, 100, 255, 220] as [number, number, number, number]; // Purple for all airborne
      },
      getAngle: (d) => -d.trackDeg,
      sizeMinPixels: 8,
      sizeMaxPixels: 28,
      sizeScale: 1,
      pickable: true,
      billboard: false,
    });
  }


  /** Empty sentinel layer Ã¢â‚¬â€ keeps a stable layer ID for deck.gl interleaved mode without rendering anything. */



  private createEarthquakesLayer(earthquakes: Earthquake[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'earthquakes-layer',
      data: earthquakes,
      getPosition: (d: any) => [d.location?.longitude ?? 0, d.location?.latitude ?? 0],
      getRadius: (d) => Math.pow(2, d.magnitude) * 1000,
      getFillColor: (d: any) => {
        const mag = d.magnitude;
        if (mag >= 6) return [255, 0, 0, 200] as [number, number, number, number];
        if (mag >= 5) return [255, 100, 0, 200] as [number, number, number, number];
        return COLORS.earthquake;
      },
      radiusMinPixels: 4,
      radiusMaxPixels: 30,
      pickable: true,
    });
  }

  private static readonly TC_WIND_COLORS: [number, [number, number, number, number]][] = [
    [137, [255, 96, 96, 200]],    // Cat5
    [113, [255, 140, 0, 200]],    // Cat4
    [96,  [255, 140, 0, 200]],    // Cat3
    [83,  [255, 231, 117, 200]],  // Cat2
    [64,  [255, 231, 117, 200]],  // Cat1
    [34,  [94, 186, 255, 200]],   // TS
    [0,   [160, 160, 160, 160]],  // TD
  ];

  private static windColor(kt: number): [number, number, number, number] {
    for (const [threshold, color] of DeckGLMap.TC_WIND_COLORS) {
      if (kt >= threshold) return color;
    }
    return [160, 160, 160, 160];
  }

  private createNaturalEventsLayers(events: NaturalEvent[]): Layer[] {
    const nonTC = events.filter(e => !e.stormName && !e.windKt);
    const cyclones = events.filter(e => e.stormName || e.windKt);
    const layers: Layer[] = [];

    if (nonTC.length > 0) {
      layers.push(new ScatterplotLayer({
        id: 'natural-events-layer',
        data: nonTC,
        getPosition: (d: NaturalEvent) => [d.lon, d.lat],
        getRadius: (d: NaturalEvent) => d.title.startsWith('Ã°Å¸â€Â´') ? 20000 : d.title.startsWith('Ã°Å¸Å¸Â ') ? 15000 : 8000,
        getFillColor: (d: NaturalEvent) => {
          if (d.title.startsWith('Ã°Å¸â€Â´')) return [255, 0, 0, 220] as [number, number, number, number];
          if (d.title.startsWith('Ã°Å¸Å¸Â ')) return [255, 140, 0, 200] as [number, number, number, number];
          return [255, 150, 50, 180] as [number, number, number, number];
        },
        radiusMinPixels: 5,
        radiusMaxPixels: 18,
        pickable: true,
      }));
    }

    if (cyclones.length === 0) return layers;

    // Cone polygons (render first, underneath tracks)
    const coneData: { polygon: number[][]; stormName: string; _event: NaturalEvent }[] = [];
    for (const e of cyclones) {
      if (!e.conePolygon?.length) continue;
      for (const ring of e.conePolygon) {
        coneData.push({ polygon: ring, stormName: e.stormName || e.title, _event: e });
      }
    }
    if (coneData.length > 0) {
      layers.push(new PolygonLayer({
        id: 'storm-cone-layer',
        data: coneData,
        getPolygon: (d: { polygon: number[][] }) => d.polygon,
        getFillColor: [255, 255, 255, 30],
        getLineColor: [255, 255, 255, 80],
        lineWidthMinPixels: 1,
        pickable: true,
      }));
    }

    // Past track segments (per-segment wind coloring)
    const pastSegments: { path: [number, number][]; windKt: number; stormName: string; _event: NaturalEvent }[] = [];
    for (const e of cyclones) {
      if (!e.pastTrack?.length) continue;
      for (let i = 0; i < e.pastTrack.length - 1; i++) {
        const a = e.pastTrack[i]!;
        const b = e.pastTrack[i + 1]!;
        pastSegments.push({
          path: [[a.lon, a.lat] as [number, number], [b.lon, b.lat] as [number, number]],
          windKt: b.windKt ?? a.windKt ?? 0,
          stormName: e.stormName || e.title,
          _event: e,
        });
      }
    }
    if (pastSegments.length > 0) {
      layers.push(new PathLayer({
        id: 'storm-past-track-layer',
        data: pastSegments,
        getPath: (d: { path: [number, number][] }) => d.path,
        getColor: (d: { windKt: number }) => DeckGLMap.windColor(d.windKt),
        getWidth: 3,
        widthUnits: 'pixels' as const,
        pickable: true,
      }));
    }

    // Forecast track
    const forecastPaths: { path: [number, number][]; stormName: string; _event: NaturalEvent }[] = [];
    for (const e of cyclones) {
      if (!e.forecastTrack?.length) continue;
      forecastPaths.push({
        path: [[e.lon, e.lat] as [number, number], ...e.forecastTrack.map(p => [p.lon, p.lat] as [number, number])],
        stormName: e.stormName || e.title,
        _event: e,
      });
    }
    if (forecastPaths.length > 0) {
      layers.push(new PathLayer({
        id: 'storm-forecast-track-layer',
        data: forecastPaths,
        getPath: (d: { path: [number, number][] }) => d.path,
        getColor: [255, 100, 100, 200],
        getWidth: 2,
        widthUnits: 'pixels' as const,
        getDashArray: [6, 4],
        dashJustified: true,
        pickable: true,
        extensions: [new PathStyleExtension({ dash: true })],
      }));
    }

    // Storm center markers (on top)
    layers.push(new ScatterplotLayer({
      id: 'storm-centers-layer',
      data: cyclones,
      getPosition: (d: NaturalEvent) => [d.lon, d.lat],
      getRadius: 15000,
      getFillColor: (d: NaturalEvent) => DeckGLMap.windColor(d.windKt ?? 0),
      getLineColor: [255, 255, 255, 200],
      lineWidthMinPixels: 2,
      stroked: true,
      radiusMinPixels: 6,
      radiusMaxPixels: 20,
      pickable: true,
    }));

    return layers;
  }

  private createFiresLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'fires-layer',
      data: this.firmsFireData,
      getPosition: (d: (typeof this.firmsFireData)[0]) => [d.lon, d.lat],
      getRadius: (d: (typeof this.firmsFireData)[0]) => Math.min(d.frp * 200, 30000) || 5000,
      getFillColor: (d: (typeof this.firmsFireData)[0]) => {
        if (d.brightness > 400) return [255, 30, 0, 220] as [number, number, number, number];
        if (d.brightness > 350) return [255, 140, 0, 200] as [number, number, number, number];
        return [255, 220, 50, 180] as [number, number, number, number];
      },
      radiusMinPixels: 3,
      radiusMaxPixels: 12,
      pickable: true,
    });
  }


  private createWeatherLayer(alerts: WeatherAlert[]): ScatterplotLayer {
    // Filter weather alerts that have centroid coordinates
    const alertsWithCoords = alerts.filter(a => a.centroid && a.centroid.length === 2);

    return new ScatterplotLayer({
      id: 'weather-layer',
      data: alertsWithCoords,
      getPosition: (d: any) => d.centroid as [number, number], // centroid is [lon, lat]
      getRadius: 25000,
      getFillColor: (d: any) => {
        if (d.severity === 'Extreme') return [255, 0, 0, 200] as [number, number, number, number];
        if (d.severity === 'Severe') return [255, 100, 0, 180] as [number, number, number, number];
        if (d.severity === 'Moderate') return [255, 170, 0, 160] as [number, number, number, number];
        return COLORS.weather;
      },
      radiusMinPixels: 8,
      radiusMaxPixels: 20,
      pickable: true,
    });
  }

  private createOutagesLayer(outages: InternetOutage[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'outages-layer',
      data: outages,
      getPosition: (d: any) => [d.lon, d.lat],
      getRadius: 20000,
      getFillColor: COLORS.outage,
      radiusMinPixels: 6,
      radiusMaxPixels: 18,
      pickable: true,
    });
  }




















  // Commodity variant layers



  // Tech variant layers









  private pulseTime = 0;

  private canPulse(now = Date.now()): boolean {
    return now - this.startupTime > 60_000;
  }

  private hasRecentRiot(now = Date.now(), windowMs = 2 * 60 * 60 * 1000): boolean {
    const hasRecentClusterRiot = this.protestClusters.some(c =>
      c.hasRiot && c.latestRiotEventTimeMs != null && (now - c.latestRiotEventTimeMs) < windowMs
    );
    if (hasRecentClusterRiot) return true;

    // Fallback to raw protests because syncPulseAnimation can run before cluster data refreshes.
    return (this as any).protests.some((p: any) => {
      if (p.eventType !== 'riot' || p.sourceType === 'gdelt') return false;
      const ts = p.time.getTime();
      return Number.isFinite(ts) && (now - ts) < windowMs;
    });
  }

  private needsPulseAnimation(now = Date.now()): boolean {
    return this.hasRecentNews(now)
      || this.hasRecentRiot(now)
      || this.hotspots.some(h => h.hasBreaking)
      || this.positiveEvents.some(e => e.count > 10)
      || this.kindnessPoints.some(p => p.type === 'real');
  }

  private syncPulseAnimation(now = Date.now()): void {
    if (this.renderPaused) {
      if (this.newsPulseIntervalId !== null) this.stopPulseAnimation();
      return;
    }
    const shouldPulse = this.canPulse(now) && this.needsPulseAnimation(now);
    if (shouldPulse && this.newsPulseIntervalId === null) {
      this.startPulseAnimation();
    } else if (!shouldPulse && this.newsPulseIntervalId !== null) {
      this.stopPulseAnimation();
    }
  }

  private startPulseAnimation(): void {
    if (this.newsPulseIntervalId !== null) return;
    const PULSE_UPDATE_INTERVAL_MS = 500;

    this.newsPulseIntervalId = setInterval(() => {
      const now = Date.now();
      if (!this.needsPulseAnimation(now)) {
        this.pulseTime = now;
        this.stopPulseAnimation();
        this.rafUpdateLayers();
        return;
      }
      this.pulseTime = now;
      this.rafUpdateLayers();
    }, PULSE_UPDATE_INTERVAL_MS);
  }

  private stopPulseAnimation(): void {
    if (this.newsPulseIntervalId !== null) {
      clearInterval(this.newsPulseIntervalId);
      this.newsPulseIntervalId = null;
    }
  }

  private createNewsLocationsLayer(): ScatterplotLayer[] {
    const zoom = this.maplibreMap?.getZoom() || 2;
    const alphaScale = zoom < 2.5 ? 0.4 : zoom < 4 ? 0.7 : 1.0;
    const filteredNewsLocations = this.filterByTime(this.newsLocations, (location) => location.timestamp);
    const THREAT_RGB: Record<string, [number, number, number]> = {
      critical: [239, 68, 68],
      high: [249, 115, 22],
      medium: [234, 179, 8],
      low: [34, 197, 94],
      info: [59, 130, 246],
    };
    const THREAT_ALPHA: Record<string, number> = {
      critical: 220,
      high: 190,
      medium: 160,
      low: 120,
      info: 80,
    };

    const now = this.pulseTime || Date.now();
    const PULSE_DURATION = 30_000;

    const layers: ScatterplotLayer[] = [
      new ScatterplotLayer({
        id: 'news-locations-layer',
        data: filteredNewsLocations,
        getPosition: (d: any) => [d.lon, d.lat],
        getRadius: 18000,
        getFillColor: (d: any) => {
          const rgb = THREAT_RGB[d.threatLevel] || [59, 130, 246];
          const a = Math.round((THREAT_ALPHA[d.threatLevel] || 120) * alphaScale);
          return [...rgb, a] as [number, number, number, number];
        },
        radiusMinPixels: 3,
        radiusMaxPixels: 12,
        pickable: true,
      }),
    ];

    const recentNews = filteredNewsLocations.filter(d => {
      const firstSeen = this.newsLocationFirstSeen.get(d.title);
      return firstSeen && (now - firstSeen) < PULSE_DURATION;
    });

    if (recentNews.length > 0) {
      const pulse = 1.0 + 1.5 * (0.5 + 0.5 * Math.sin(now / 318));

      layers.push(new ScatterplotLayer({
        id: 'news-pulse-layer',
        data: recentNews,
        getPosition: (d: any) => [d.lon, d.lat],
        getRadius: 18000,
        radiusScale: pulse,
        radiusMinPixels: 6,
        radiusMaxPixels: 30,
        pickable: false,
        stroked: true,
        filled: false,
        getLineColor: (d) => {
          const rgb = THREAT_RGB[d.threatLevel] || [59, 130, 246];
          const firstSeen = this.newsLocationFirstSeen.get(d.title) || now;
          const age = now - firstSeen;
          const fadeOut = Math.max(0, 1 - age / PULSE_DURATION);
          const a = Math.round(150 * fadeOut * alphaScale);
          return [...rgb, a] as [number, number, number, number];
        },
        lineWidthMinPixels: 1.5,
        updateTriggers: { pulseTime: now },
      }));
    }

    return layers;
  }





  private static readonly CII_LEVEL_HEX: Record<string, string> = {
    critical: '#b91c1c', high: '#dc2626', elevated: '#f59e0b', normal: '#eab308', low: '#22c55e',
  };






  private getTooltip(info: PickingInfo): { html: string } | null {
    if (!info.object) return null;

    const rawLayerId = info.layer?.id || '';
    const layerId = rawLayerId.endsWith('-ghost') ? rawLayerId.slice(0, -6) : rawLayerId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = info.object as any;
    const text = (value: unknown): string => escapeHtml(String(value ?? ''));

    switch (layerId) {
      case 'hotspots-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.subtext)}</div>` };
      case 'earthquakes-layer':
        return { html: `<div class="deckgl-tooltip"><strong>M${(obj.magnitude || 0).toFixed(1)} ${t('components.deckgl.tooltip.earthquake')}</strong><br/>${text(obj.place)}</div>` };
      case 'military-vessels-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.operatorCountry)}</div>` };
      case 'military-flights-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.callsign || obj.registration || t('components.deckgl.tooltip.militaryAircraft'))}</strong><br/>${text(obj.type)}</div>` };
      case 'military-vessel-clusters-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name || t('components.deckgl.tooltip.vesselCluster'))}</strong><br/>${obj.vesselCount || 0} ${t('components.deckgl.tooltip.vessels')}<br/>${text(obj.activityType)}</div>` };
      case 'military-flight-clusters-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name || t('components.deckgl.tooltip.flightCluster'))}</strong><br/>${obj.flightCount || 0} ${t('components.deckgl.tooltip.aircraft')}<br/>${text(obj.activityType)}</div>` };
      case 'protests-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.title)}</strong><br/>${text(obj.country)}</div>` };
      case 'protest-clusters-layer':
        if (obj.count === 1) {
          const item = obj.items?.[0];
          return { html: `<div class="deckgl-tooltip"><strong>${text(item?.title || t('components.deckgl.tooltip.protest'))}</strong><br/>${text(item?.city || item?.country || '')}</div>` };
        }
        return { html: `<div class="deckgl-tooltip"><strong>${t('components.deckgl.tooltip.protestsCount', { count: String(obj.count) })}</strong><br/>${text(obj.country)}</div>` };
      case 'tech-hq-clusters-layer':
        if (obj.count === 1) {
          const hq = obj.items?.[0];
          return { html: `<div class="deckgl-tooltip"><strong>${text(hq?.company || '')}</strong><br/>${text(hq?.city || '')}</div>` };
        }
        return { html: `<div class="deckgl-tooltip"><strong>${t('components.deckgl.tooltip.techHQsCount', { count: String(obj.count) })}</strong><br/>${text(obj.city)}</div>` };
      case 'tech-event-clusters-layer':
        if (obj.count === 1) {
          const ev = obj.items?.[0];
          return { html: `<div class="deckgl-tooltip"><strong>${text(ev?.title || '')}</strong><br/>${text(ev?.location || '')}</div>` };
        }
        return { html: `<div class="deckgl-tooltip"><strong>${t('components.deckgl.tooltip.techEventsCount', { count: String(obj.count) })}</strong><br/>${text(obj.location)}</div>` };
      case 'datacenter-clusters-layer':
        if (obj.count === 1) {
          const dc = obj.items?.[0];
          return { html: `<div class="deckgl-tooltip"><strong>${text(dc?.name || '')}</strong><br/>${text(dc?.owner || '')}</div>` };
        }
        return { html: `<div class="deckgl-tooltip"><strong>${t('components.deckgl.tooltip.dataCentersCount', { count: String(obj.count) })}</strong><br/>${text(obj.country)}</div>` };
      case 'bases-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.country)}${obj.kind ? ` Ã‚Â· ${text(obj.kind)}` : ''}</div>` };
      case 'bases-cluster-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${obj.count} bases</strong></div>` };
      case 'nuclear-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.type)}</div>` };
      case 'datacenters-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.owner)}</div>` };
      case 'cables-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${t('components.deckgl.tooltip.underseaCable')}</div>` };
      case 'pipelines-layer': {
        const pipelineType = String(obj.type || '').toLowerCase();
        const pipelineTypeLabel = pipelineType === 'oil'
          ? t('popups.pipeline.types.oil')
          : pipelineType === 'gas'
            ? t('popups.pipeline.types.gas')
            : pipelineType === 'products'
              ? t('popups.pipeline.types.products')
              : `${text(obj.type)} ${t('components.deckgl.tooltip.pipeline')}`;
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${pipelineTypeLabel}</div>` };
      }
      case 'conflict-zones-layer': {
        const props = obj.properties || obj;
        return { html: `<div class="deckgl-tooltip"><strong>${text(props.name)}</strong><br/>${t('components.deckgl.tooltip.conflictZone')}</div>` };
      }

      case 'natural-events-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.title)}</strong><br/>${text(obj.category || t('components.deckgl.tooltip.naturalEvent'))}</div>` };
      case 'storm-centers-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.stormName || obj.title)}</strong><br/>${text(obj.classification || '')} ${obj.windKt ? obj.windKt + ' kt' : ''}</div>` };
      case 'storm-forecast-track-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.stormName)}</strong><br/>${t('popups.naturalEvent.classification')}: Forecast Track</div>` };
      case 'storm-past-track-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.stormName)}</strong><br/>Past Track (${obj.windKt} kt)</div>` };
      case 'storm-cone-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.stormName)}</strong><br/>Forecast Cone</div>` };
      case 'ais-density-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${t('components.deckgl.layers.shipTraffic')}</strong><br/>${t('popups.intensity')}: ${text(obj.intensity)}</div>` };
      case 'waterways-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${t('components.deckgl.layers.strategicWaterways')}</div>` };
      case 'economic-centers-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.country)}</div>` };
      case 'stock-exchanges-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.shortName)}</strong><br/>${text(obj.city)}, ${text(obj.country)}</div>` };
      case 'financial-centers-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.type)} ${t('components.deckgl.tooltip.financialCenter')}</div>` };
      case 'central-banks-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.shortName)}</strong><br/>${text(obj.city)}, ${text(obj.country)}</div>` };
      case 'commodity-hubs-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.type)} Ã‚Â· ${text(obj.city)}</div>` };
      case 'startup-hubs-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.city)}</strong><br/>${text(obj.country)}</div>` };
      case 'tech-hqs-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.company)}</strong><br/>${text(obj.city)}</div>` };
      case 'accelerators-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.city)}</div>` };
      case 'cloud-regions-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.provider)}</strong><br/>${text(obj.region)}</div>` };
      case 'tech-events-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.title)}</strong><br/>${text(obj.location)}</div>` };
      case 'irradiators-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.type || t('components.deckgl.layers.gammaIrradiators'))}</div>` };
      case 'spaceports-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.country || t('components.deckgl.layers.spaceports'))}</div>` };
      case 'ports-layer': {
        const typeIcon = obj.type === 'naval' ? 'Ã¢Å¡â€œ' : obj.type === 'oil' || obj.type === 'lng' ? 'Ã°Å¸â€ºÂ¢Ã¯Â¸Â' : 'Ã°Å¸ÂÂ­';
        return { html: `<div class="deckgl-tooltip"><strong>${typeIcon} ${text(obj.name)}</strong><br/>${text(obj.type || t('components.deckgl.tooltip.port'))} - ${text(obj.country)}</div>` };
      }
      case 'flight-delays-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)} (${text(obj.iata)})</strong><br/>${text(obj.severity)}: ${text(obj.reason)}</div>` };
      case 'notam-overlay-layer':
        return { html: `<div class="deckgl-tooltip"><strong style="color:#ff2828;">&#9888; NOTAM CLOSURE</strong><br/>${text(obj.name)} (${text(obj.iata)})<br/><span style="opacity:.7">${text((obj.reason || '').slice(0, 100))}</span></div>` };
      case 'aircraft-positions-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.callsign || obj.icao24)}</strong><br/>${obj.altitudeFt?.toLocaleString() ?? 0} ft Ã‚Â· ${obj.groundSpeedKts ?? 0} kts Ã‚Â· ${Math.round(obj.trackDeg ?? 0)}Ã‚Â°</div>` };
      case 'apt-groups-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.aka)}<br/>${t('popups.sponsor')}: ${text(obj.sponsor)}</div>` };
      case 'minerals-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.mineral)} - ${text(obj.country)}<br/>${text(obj.operator)}</div>` };
      case 'mining-sites-layer': {
        const statusLabel = obj.status === 'producing' ? 'Ã¢â€ºÂÃ¯Â¸Â Producing' : obj.status === 'development' ? 'Ã°Å¸â€Â§ Development' : 'Ã°Å¸â€Â Exploration';
        const outputStr = obj.annualOutput ? `<br/><span style="opacity:.75">${text(obj.annualOutput)}</span>` : '';
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.mineral)} Ã‚Â· ${text(obj.country)}<br/>${statusLabel}${outputStr}</div>` };
      }
      case 'processing-plants-layer': {
        const typeLabel = obj.type === 'smelter' ? 'Ã°Å¸ÂÂ­ Smelter' : obj.type === 'refinery' ? 'Ã¢Å¡â€”Ã¯Â¸Â Refinery' : obj.type === 'separation' ? 'Ã°Å¸Â§Âª Separation' : 'Ã°Å¸Ââ€”Ã¯Â¸Â Processing';
        const capacityStr = obj.capacityTpa ? `<br/><span style="opacity:.75">${text(String((obj.capacityTpa / 1000).toFixed(0)))}k t/yr</span>` : '';
        const mineralLabel = obj.mineral ?? (Array.isArray(obj.materials) ? obj.materials.join(', ') : '');
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(mineralLabel)} Ã‚Â· ${text(obj.country)}<br/>${typeLabel}${capacityStr}</div>` };
      }
      case 'commodity-ports-layer': {
        const commoditiesStr = Array.isArray(obj.commodities) ? obj.commodities.join(', ') : '';
        const volumeStr = obj.annualVolumeMt ? `<br/><span style="opacity:.75">${text(String(obj.annualVolumeMt))}Mt/yr</span>` : '';
        return { html: `<div class="deckgl-tooltip"><strong>Ã¢Å¡â€œ ${text(obj.name)}</strong><br/>${text(obj.country)}<br/>${text(commoditiesStr)}${volumeStr}</div>` };
      }
      case 'ais-disruptions-layer':
        return { html: `<div class="deckgl-tooltip"><strong>AIS ${text(obj.type || t('components.deckgl.tooltip.disruption'))}</strong><br/>${text(obj.severity)} ${t('popups.severity')}<br/>${text(obj.description)}</div>` };
      case 'gps-jamming-layer':
        return { html: `<div class="deckgl-tooltip"><strong>GPS Jamming</strong><br/>${text(obj.level)} Ã‚Â· NP avg: ${Number(obj.npAvg).toFixed(2)}<br/>H3: ${text(obj.h3)}</div>` };
      case 'cable-advisories-layer': {
        const cableName = UNDERSEA_CABLES.find(c => c.id === obj.cableId)?.name || obj.cableId;
        return { html: `<div class="deckgl-tooltip"><strong>${text(cableName)}</strong><br/>${text(obj.severity || t('components.deckgl.tooltip.advisory'))}<br/>${text(obj.description)}</div>` };
      }
      case 'repair-ships-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name || t('components.deckgl.tooltip.repairShip'))}</strong><br/>${text(obj.status)}</div>` };
      case 'weather-layer': {
        const areaDesc = typeof obj.areaDesc === 'string' ? obj.areaDesc : '';
        const area = areaDesc ? `<br/><small>${text(areaDesc.slice(0, 50))}${areaDesc.length > 50 ? '...' : ''}</small>` : '';
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.event || t('components.deckgl.layers.weatherAlerts'))}</strong><br/>${text(obj.severity)}${area}</div>` };
      }
      case 'outages-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.asn || t('components.deckgl.tooltip.internetOutage'))}</strong><br/>${text(obj.country)}</div>` };
      case 'cyber-threats-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${t('popups.any /* cyberThreat removed */.title')}</strong><br/>${text(obj.severity || t('components.deckgl.tooltip.medium'))} Ã‚Â· ${text(obj.country || t('popups.unknown'))}</div>` };
      case 'iran-events-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${t('components.deckgl.layers.iranAttacks')}: ${text(obj.category || '')}</strong><br/>${text((obj.title || '').slice(0, 80))}</div>` };
      case 'news-locations-layer':
        return { html: `<div class="deckgl-tooltip"><strong>Ã°Å¸â€œÂ° ${t('components.deckgl.tooltip.news')}</strong><br/>${text(obj.title?.slice(0, 80) || '')}</div>` };
      case 'sc-municipios': {
        const feature = obj;
        const codFeature = String(feature.properties?.id);
        const cidade = this.celescLookup.get(codFeature);
        if (!cidade) {
          return { html: `<div class="deckgl-tooltip"><strong>${escapeHtml(feature.properties?.name || '')}</strong></div>` };
        }
        const pctFormatted = typeof cidade.pct === 'number' ? (cidade.pct % 1 === 0 ? cidade.pct : cidade.pct.toFixed(2)) : cidade.pct;
        const bairrosHtml = cidade.bairros && cidade.bairros.length > 0 
          ? `<div style="max-height: 100px; overflow-y: auto; margin-top: 5px; font-size: 0.9em;">
               ${cidade.bairros.map(b => `<div style="margin-bottom:2px;">Ã¢â‚¬Â¢ ${escapeHtml(b.nome)}: <strong>${b.ucsAfetadas}</strong> UCs</div>`).join('')}
             </div>`
          : '<div style="margin-top: 5px; font-size: 0.9em; opacity: 0.8;">Nenhum bairro com interrupÃƒÂ§ÃƒÂ£o</div>';
          
        return { html: `<div class="deckgl-tooltip" style="min-width:200px;">
                          <strong style="font-size:1.1em;">${escapeHtml(cidade.nome)}</strong><br/>
                          <div style="margin-top: 4px;">UCs Offline: <strong>${cidade.ucsAfetadas}</strong> (${pctFormatted}%)</div>
                          ${bairrosHtml}
                        </div>` };
      }
      case 'positive-events-layer': {
        const catLabel = obj.category ? obj.category.replace(/-/g, ' & ') : 'Positive Event';
        const countInfo = obj.count > 1 ? `<br/><span style="opacity:.7">${obj.count} sources reporting</span>` : '';
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/><span style="text-transform:capitalize">${text(catLabel)}</span>${countInfo}</div>` };
      }
      case 'kindness-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong></div>` };
      case 'happiness-choropleth-layer': {
        const hcName = obj.properties?.name ?? 'Unknown';
        const hcCode = obj.properties?.['ISO3166-1-Alpha-2'];
        const hcScore = hcCode ? this.happinessScores.get(hcCode as string) : undefined;
        const hcScoreStr = hcScore != null ? hcScore.toFixed(1) : 'No data';
        return { html: `<div class="deckgl-tooltip"><strong>${text(hcName)}</strong><br/>Happiness: ${hcScoreStr}/10${hcScore != null ? `<br/><span style="opacity:.7">${text(this.happinessSource)} (${this.happinessYear})</span>` : ''}</div>` };
      }
      case 'cii-choropleth-layer': {
        const ciiName = obj.properties?.name ?? 'Unknown';
        const ciiCode = obj.properties?.['ISO3166-1-Alpha-2'];
        const ciiEntry = ciiCode ? this.ciiScoresMap.get(ciiCode as string) : undefined;
        if (!ciiEntry) return { html: `<div class="deckgl-tooltip"><strong>${text(ciiName)}</strong><br/><span style="opacity:.7">No CII data</span></div>` };
        const levelColor = DeckGLMap.CII_LEVEL_HEX[ciiEntry.level] ?? '#888';
        return { html: `<div class="deckgl-tooltip"><strong>${text(ciiName)}</strong><br/>CII: <span style="color:${levelColor};font-weight:600">${ciiEntry.score}/100</span><br/><span style="text-transform:capitalize;opacity:.7">${text(ciiEntry.level)}</span></div>` };
      }
      case 'species-recovery-layer': {
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.commonName)}</strong><br/>${text(obj.recoveryZone?.name ?? obj.region)}<br/><span style="opacity:.7">Status: ${text(obj.recoveryStatus)}</span></div>` };
      }
      case 'renewable-installations-layer': {
        const riTypeLabel = obj.type ? String(obj.type).charAt(0).toUpperCase() + String(obj.type).slice(1) : 'Renewable';
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${riTypeLabel} &middot; ${obj.capacityMW?.toLocaleString() ?? '?'} MW<br/><span style="opacity:.7">${text(obj.country)} &middot; ${obj.year}</span></div>` };
      }
      case 'gulf-investments-layer': {
        const inv = obj as GulfInvestment;
        const flag = inv.investingCountry === 'SA' ? 'Ã°Å¸â€¡Â¸Ã°Å¸â€¡Â¦' : 'Ã°Å¸â€¡Â¦Ã°Å¸â€¡Âª';
        const usd = inv.investmentUSD != null
          ? (inv.investmentUSD >= 1000 ? `$${(inv.investmentUSD / 1000).toFixed(1)}B` : `$${inv.investmentUSD}M`)
          : t('components.deckgl.tooltip.undisclosed');
        const stake = inv.stakePercent != null ? `<br/>${text(String(inv.stakePercent))}% ${t('components.deckgl.tooltip.stake')}` : '';
        return {
          html: `<div class="deckgl-tooltip">
            <strong>${flag} ${text(inv.assetName)}</strong><br/>
            <em>${text(inv.investingEntity)}</em><br/>
            ${text(inv.targetCountry)} Ã‚Â· ${text(inv.sector)}<br/>
            <strong>${usd}</strong>${stake}<br/>
            <span style="text-transform:capitalize">${text(inv.status)}</span>
          </div>`,
        };
      }
      case 'satellite-imagery-layer': {
        let imgHtml = `<div class="deckgl-tooltip"><strong>&#128752; ${text(obj.satellite)}</strong><br/>${text(obj.datetime)}<br/>Res: ${Number(obj.resolutionM)}m \u00B7 ${text(obj.mode)}`;
        if (isAllowedPreviewUrl(obj.previewUrl)) {
          const safeHref = escapeHtml(new URL(obj.previewUrl).href);
          imgHtml += `<br><img src="${safeHref}" referrerpolicy="no-referrer" style="max-width:180px;max-height:120px;margin-top:4px;border-radius:4px;" class="imagery-preview">`;
        }
        imgHtml += '</div>';
        return { html: imgHtml };
      }
      default:
        return null;
    }
  }

  private static readonly CHOROPLETH_LAYER_IDS = new Set([
    'cii-choropleth-layer',
    'happiness-choropleth-layer',
  ]);

  private handleClick(info: PickingInfo): void {
    if (!info.object || (info.layer && info.layer.id !== 'sc-municipios')) {
      this.setSelectedCityInfo(null);
    }

    const isChoropleth = info.layer?.id ? DeckGLMap.CHOROPLETH_LAYER_IDS.has(info.layer.id) : false;
    if (!info.object || isChoropleth) {
      if (info.coordinate && this.onCountryClick) {
        const [lon, lat] = info.coordinate as [number, number];
        const country = isChoropleth && info.object?.properties
          ? { code: info.object.properties['ISO3166-1-Alpha-2'] as string, name: info.object.properties.name as string }
          : this.resolveCountryFromCoordinate(lon, lat);
        this.onCountryClick({
          lat,
          lon,
          ...(country ? { code: country.code, name: country.name } : {}),
        });
      }
      return;
    }

    const rawClickLayerId = info.layer?.id || '';
    const layerId = rawClickLayerId.endsWith('-ghost') ? rawClickLayerId.slice(0, -6) : rawClickLayerId;

    // Hotspots show popup with related news
    if (layerId === 'hotspots-layer') {
      const hotspot = info.object as Hotspot;
      const relatedNews = this.getRelatedNews(hotspot);
      this.popup.show({
        type: 'hotspot',
        data: hotspot,
        relatedNews,
        x: info.x,
        y: info.y,
      });
      this.popup.loadHotspotGdeltContext(hotspot);
      this.onHotspotClick?.(hotspot);
      return;
    }

    // Handle cluster layers with single/multi logic
    if (layerId === 'protest-clusters-layer') {
      const cluster = info.object as MapProtestCluster;
      if (cluster.items.length === 0 && cluster._clusterId != null && this.protestSC) {
        try {
          const leaves = this.protestSC.getLeaves(cluster._clusterId, DeckGLMap.MAX_CLUSTER_LEAVES);
          cluster.items = leaves.map(l => this.protestSuperclusterSource[l.properties.index]).filter((x): x is SocialUnrestEvent => !!x);
          cluster.sampled = cluster.items.length < cluster.count;
        } catch (e: any) {
          console.warn('[DeckGLMap] stale protest cluster', cluster._clusterId, e);
          return;
        }
      }
      if (cluster.count === 1 && cluster.items[0]) {
        this.popup.show({ type: 'protest', data: cluster.items[0], x: info.x, y: info.y });
      } else {
        this.popup.show({
          type: 'protestCluster',
          data: {
            items: cluster.items,
            country: cluster.country,
            count: cluster.count,
            riotCount: cluster.riotCount,
            highSeverityCount: cluster.highSeverityCount,
            verifiedCount: cluster.verifiedCount,
            totalFatalities: cluster.totalFatalities,
            sampled: cluster.sampled,
          },
          x: info.x,
          y: info.y,
        });
      }
      return;
    }
    if (layerId === 'tech-hq-clusters-layer') {
      const cluster = info.object as MapTechHQCluster;
      if (cluster.items.length === 0 && cluster._clusterId != null && this.techHQSC) {
        try {
          const leaves = this.techHQSC.getLeaves(cluster._clusterId, DeckGLMap.MAX_CLUSTER_LEAVES);
          cluster.items = leaves.map(l => TECH_HQS[l.properties.index]).filter(Boolean) as typeof TECH_HQS;
          cluster.sampled = cluster.items.length < cluster.count;
        } catch (e: any) {
          console.warn('[DeckGLMap] stale techHQ cluster', cluster._clusterId, e);
          return;
        }
      }
      if (cluster.count === 1 && cluster.items[0]) {
        this.popup.show({ type: 'techHQ', data: cluster.items[0], x: info.x, y: info.y });
      } else {
        this.popup.show({
          type: 'techHQCluster',
          data: {
            items: cluster.items,
            city: cluster.city,
            country: cluster.country,
            count: cluster.count,
            faangCount: cluster.faangCount,
            unicornCount: cluster.unicornCount,
            publicCount: cluster.publicCount,
            sampled: cluster.sampled,
          },
          x: info.x,
          y: info.y,
        });
      }
      return;
    }
    if (layerId === 'tech-event-clusters-layer') {
      const cluster = info.object as MapTechEventCluster;
      if (cluster.items.length === 0 && cluster._clusterId != null && this.techEventSC) {
        try {
          const leaves = this.techEventSC.getLeaves(cluster._clusterId, DeckGLMap.MAX_CLUSTER_LEAVES);
          cluster.items = leaves.map(l => this.techEvents[l.properties.index]).filter((x): x is TechEventMarker => !!x);
          cluster.sampled = cluster.items.length < cluster.count;
        } catch (e: any) {
          console.warn('[DeckGLMap] stale techEvent cluster', cluster._clusterId, e);
          return;
        }
      }
      if (cluster.count === 1 && cluster.items[0]) {
        this.popup.show({ type: 'techEvent', data: cluster.items[0], x: info.x, y: info.y });
      } else {
        this.popup.show({
          type: 'techEventCluster',
          data: {
            items: cluster.items,
            location: cluster.location,
            country: cluster.country,
            count: cluster.count,
            soonCount: cluster.soonCount,
            sampled: cluster.sampled,
          },
          x: info.x,
          y: info.y,
        });
      }
      return;
    }
    if (layerId === 'datacenter-clusters-layer') {
      const cluster = info.object as MapDatacenterCluster;
      if (cluster.items.length === 0 && cluster._clusterId != null && this.datacenterSC) {
        try {
          const leaves = this.datacenterSC.getLeaves(cluster._clusterId, DeckGLMap.MAX_CLUSTER_LEAVES);
          cluster.items = leaves.map(l => this.datacenterSCSource[l.properties.index]).filter((x): x is AIDataCenter => !!x);
          cluster.sampled = cluster.items.length < cluster.count;
        } catch (e: any) {
          console.warn('[DeckGLMap] stale datacenter cluster', cluster._clusterId, e);
          return;
        }
      }
      if (cluster.count === 1 && cluster.items[0]) {
        this.popup.show({ type: 'datacenter', data: cluster.items[0], x: info.x, y: info.y });
      } else {
        this.popup.show({
          type: 'datacenterCluster',
          data: {
            items: cluster.items,
            region: cluster.region || cluster.country,
            country: cluster.country,
            count: cluster.count,
            totalChips: cluster.totalChips,
            totalPowerMW: cluster.totalPowerMW,
            existingCount: cluster.existingCount,
            plannedCount: cluster.plannedCount,
            sampled: cluster.sampled,
          },
          x: info.x,
          y: info.y,
        });
      }
      return;
    }

    // Map layer IDs to popup types
    const layerToPopupType: Record<string, PopupType> = {
      'conflict-zones-layer': 'conflict',

      'bases-layer': 'base',
      'nuclear-layer': 'nuclear',
      'irradiators-layer': 'irradiator',
      'datacenters-layer': 'datacenter',
      'cables-layer': 'cable',
      'pipelines-layer': 'pipeline',
      'earthquakes-layer': 'earthquake',
      'weather-layer': 'weather',
      'outages-layer': 'outage',
      'cyber-threats-layer': 'celescOutage',
      'iran-events-layer': 'celescOutage',
      'protests-layer': 'protest',
      'military-flights-layer': 'militaryFlight',
      'military-vessels-layer': 'militaryVessel',
      'military-vessel-clusters-layer': 'militaryVesselCluster',
      'military-flight-clusters-layer': 'militaryFlightCluster',
      'natural-events-layer': 'natEvent',
      'storm-centers-layer': 'natEvent',
      'storm-forecast-track-layer': 'natEvent',
      'storm-past-track-layer': 'natEvent',
      'storm-cone-layer': 'natEvent',
      'waterways-layer': 'waterway',
      'economic-centers-layer': 'economic',
      'stock-exchanges-layer': 'stockExchange',
      'financial-centers-layer': 'financialCenter',
      'central-banks-layer': 'centralBank',
      'commodity-hubs-layer': 'commodityHub',
      'spaceports-layer': 'spaceport',
      'ports-layer': 'port',
      'flight-delays-layer': 'flight',
      'notam-overlay-layer': 'flight',
      'aircraft-positions-layer': 'aircraft',
      'startup-hubs-layer': 'startupHub',
      'tech-hqs-layer': 'techHQ',
      'accelerators-layer': 'accelerator',
      'cloud-regions-layer': 'cloudRegion',
      'tech-events-layer': 'techEvent',
      'apt-groups-layer': 'apt',
      'minerals-layer': 'mineral',
      'ais-disruptions-layer': 'ais',
      'gps-jamming-layer': 'gpsJamming',
      'cable-advisories-layer': 'cable-advisory',
      'repair-ships-layer': 'repair-ship',
      'celesc-outages-layer': 'celescOutage',
    };

    const popupType = layerToPopupType[layerId];
    if (!popupType) return;

    // For synthetic storm layers, unwrap the backing NaturalEvent
    let data = info.object?._event ?? info.object;
    if (layerId === 'conflict-zones-layer' && info.object.properties) {
      // Find the full conflict zone data from config
      const conflictId = info.object.properties.id;
      const fullConflict = CONFLICT_ZONES.find(c => c.id === conflictId);
      if (fullConflict) data = fullConflict;
    }

    // (iranEvent enrichment removed â€” DCE)

    // Get click coordinates relative to container
    const x = info.x ?? 0;
    const y = info.y ?? 0;

    this.popup.show({
      type: popupType,
      data: data,
      x,
      y,
    });
  }


  // UI Creation methods
  private createControls(): void {
    const controls = document.createElement('div');
    controls.className = 'map-controls deckgl-controls';
    controls.innerHTML = `
      <div class="zoom-controls">
        <button class="map-btn zoom-in" title="${t('components.deckgl.zoomIn')}">+</button>
        <button class="map-btn zoom-out" title="${t('components.deckgl.zoomOut')}">-</button>
        <button class="map-btn zoom-reset" title="${t('components.deckgl.resetView')}">&#8962;</button>
      </div>
      <div class="view-selector">
        <select class="view-select">
          <option value="global">${t('components.deckgl.views.global')}</option>
          <option value="america">${t('components.deckgl.views.americas')}</option>
          <option value="mena">${t('components.deckgl.views.mena')}</option>
          <option value="eu">${t('components.deckgl.views.europe')}</option>
          <option value="asia">${t('components.deckgl.views.asia')}</option>
          <option value="latam">${t('components.deckgl.views.latam')}</option>
          <option value="africa">${t('components.deckgl.views.africa')}</option>
          <option value="oceania">${t('components.deckgl.views.oceania')}</option>
        </select>
      </div>
    `;

    this.container.appendChild(controls);

    // Bind events - use event delegation for reliability
    controls.addEventListener('click', (e: any) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('zoom-in')) this.zoomIn();
      else if (target.classList.contains('zoom-out')) this.zoomOut();
      else if (target.classList.contains('zoom-reset')) this.resetView();
    });

    const viewSelect = controls.querySelector('.view-select') as HTMLSelectElement;
    viewSelect.value = this.state.view;
    viewSelect.addEventListener('change', () => {
      this.setView(viewSelect.value as DeckMapView);
    });
  }

  private createTimeSlider(): void {
    const slider = document.createElement('div');
    slider.className = 'time-slider deckgl-time-slider';
    slider.innerHTML = `
      <div class="time-options">
        <button class="time-btn ${this.state.timeRange === '1h' ? 'active' : ''}" data-range="1h">1h</button>
        <button class="time-btn ${this.state.timeRange === '6h' ? 'active' : ''}" data-range="6h">6h</button>
        <button class="time-btn ${this.state.timeRange === '24h' ? 'active' : ''}" data-range="24h">24h</button>
        <button class="time-btn ${this.state.timeRange === '48h' ? 'active' : ''}" data-range="48h">48h</button>
        <button class="time-btn ${this.state.timeRange === '7d' ? 'active' : ''}" data-range="7d">7d</button>
        <button class="time-btn ${this.state.timeRange === 'all' ? 'active' : ''}" data-range="all">${t('components.deckgl.timeAll')}</button>
      </div>
    `;

    this.container.appendChild(slider);

    slider.querySelectorAll('.time-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const range = (btn as HTMLElement).dataset.range as TimeRange;
        this.setTimeRange(range);
      });
    });
  }

  private updateTimeSliderButtons(): void {
    const slider = this.container.querySelector('.deckgl-time-slider');
    if (!slider) return;
    slider.querySelectorAll('.time-btn').forEach((btn) => {
      const range = (btn as HTMLElement).dataset.range as TimeRange | undefined;
      btn.classList.toggle('active', range === this.state.timeRange);
    });
  }

  private createLayerToggles(): void {
    const toggles = document.createElement('div');
    toggles.className = 'layer-toggles deckgl-layer-toggles';

    const layerDefs = getLayersForVariant((SITE_VARIANT || 'full') as MapVariant, 'flat');
    const _wmKey = getSecretState('WORLDMONITOR_API_KEY').present;
    const layerConfig = layerDefs.map(def => ({
      key: def.key,
      label: resolveLayerLabel(def, t),
      icon: def.icon,
      premium: def.premium,
    }));

    toggles.innerHTML = `
      <div class="toggle-header">
        <span>${t('components.deckgl.layersTitle')}</span>
        <button class="layer-help-btn" title="${t('components.deckgl.layerGuide')}">?</button>
        <button class="toggle-collapse">&#9660;</button>
      </div>
      <input type="text" class="layer-search" placeholder="${t('components.deckgl.layerSearch')}" autocomplete="off" spellcheck="false" />
      <div class="toggle-list" style="max-height: 32vh; overflow-y: auto; scrollbar-width: thin;">
        ${layerConfig.map(({ key, label, icon, premium }) => {
          const isLocked = premium === 'locked' && !_wmKey;
          const isEnhanced = premium === 'enhanced' && !_wmKey;
          return `
          <label class="layer-toggle${isLocked ? ' layer-toggle-locked' : ''}" data-layer="${key}">
            <input type="checkbox" ${this.state.layers[key as keyof MapLayers] ? 'checked' : ''}${isLocked ? ' disabled' : ''}>
            <span class="toggle-icon">${icon}</span>
            <span class="toggle-label">${label}${isLocked ? ' \uD83D\uDD12' : ''}${isEnhanced ? ' <span class="layer-pro-badge">PRO</span>' : ''}</span>
          </label>`;
        }).join('')}
      </div>
    `;

    const authorBadge = document.createElement('div');
    authorBadge.className = 'map-author-badge';
    authorBadge.textContent = 'Ã‚Â© Elie Habib Ã‚Â· SomeoneÃ¢â€žÂ¢';
    toggles.appendChild(authorBadge);

    this.container.appendChild(toggles);

    // Bind toggle events
    toggles.querySelectorAll('.layer-toggle input').forEach(input => {
      input.addEventListener('change', () => {
        const layer = (input as HTMLInputElement).closest('.layer-toggle')?.getAttribute('data-layer') as keyof MapLayers;
        if (layer) {
          this.state.layers[layer] = (input as HTMLInputElement).checked;
          if (layer === 'flights') this.manageAircraftTimer((input as HTMLInputElement).checked);
          this.render();
          this.onLayerChange?.(layer, (input as HTMLInputElement).checked, 'user');
          if ((layer as any) === 'ciiChoropleth') {
            const ciiLeg = this.container.querySelector('#ciiChoroplethLegend') as HTMLElement | null;
            if (ciiLeg) ciiLeg.style.display = (input as HTMLInputElement).checked ? 'block' : 'none';
          }
          this.enforceLayerLimit();
        }
      });
    });
    this.enforceLayerLimit();

    // Help button
    const helpBtn = toggles.querySelector('.layer-help-btn');
    helpBtn?.addEventListener('click', () => this.showLayerHelp());

    // Collapse toggle
    const collapseBtn = toggles.querySelector('.toggle-collapse');
    const toggleList = toggles.querySelector('.toggle-list');

    // Manual scroll: intercept wheel, prevent map zoom, scroll the list ourselves
    if (toggleList) {
      toggles.addEventListener('wheel', (e: any) => {
        e.stopPropagation();
        e.preventDefault();
        toggleList.scrollTop += e.deltaY;
      }, { passive: false });
      toggles.addEventListener('touchmove', (e: any) => e.stopPropagation(), { passive: false });
    }
    bindLayerSearch(toggles);
    const searchEl = toggles.querySelector('.layer-search') as HTMLElement | null;

    collapseBtn?.addEventListener('click', () => {
      toggleList?.classList.toggle('collapsed');
      if (searchEl) searchEl.style.display = toggleList?.classList.contains('collapsed') ? 'none' : '';
      if (collapseBtn) collapseBtn.innerHTML = toggleList?.classList.contains('collapsed') ? '&#9654;' : '&#9660;';
    });
  }

  /** Show layer help popup explaining each layer */
  private showLayerHelp(): void {
    const existing = this.container.querySelector('.layer-help-popup');
    if (existing) {
      existing.remove();
      return;
    }

    const popup = document.createElement('div');
    popup.className = 'layer-help-popup';

    const label = (layerKey: string): string => t(`components.deckgl.layers.${layerKey}`).toUpperCase();
    const staticLabel = (labelKey: string): string => t(`components.deckgl.layerHelp.labels.${labelKey}`).toUpperCase();
    const helpItem = (layerLabel: string, descriptionKey: string): string =>
      `<div class="layer-help-item"><span>${layerLabel}</span> ${t(`components.deckgl.layerHelp.descriptions.${descriptionKey}`)}</div>`;
    const helpSection = (titleKey: string, items: string[], noteKey?: string): string => `
      <div class="layer-help-section">
        <div class="layer-help-title">${t(`components.deckgl.layerHelp.sections.${titleKey}`)}</div>
        ${items.join('')}
        ${noteKey ? `<div class="layer-help-note">${t(`components.deckgl.layerHelp.notes.${noteKey}`)}</div>` : ''}
      </div>
    `;
    const helpHeader = `
      <div class="layer-help-header">
        <span>${t('components.deckgl.layerHelp.title')}</span>
        <button class="layer-help-close" aria-label="Close">Ãƒâ€”</button>
      </div>
    `;

    const techHelpContent = `
      ${helpHeader}
      <div class="layer-help-content">
        ${helpSection('techEcosystem', [
      helpItem(label('startupHubs'), 'techStartupHubs'),
      helpItem(label('cloudRegions'), 'techCloudRegions'),
      helpItem(label('techHQs'), 'techHQs'),
      helpItem(label('accelerators'), 'techAccelerators'),
      helpItem(label('techEvents'), 'techEvents'),
    ])}
        ${helpSection('infrastructure', [
      helpItem(label('underseaCables'), 'infraCables'),
      helpItem(label('aiDataCenters'), 'infraDatacenters'),
      helpItem(label('internetOutages'), 'infraOutages'),
      helpItem(label('cyberThreats'), 'techCyberThreats'),
    ])}
        ${helpSection('naturalEconomic', [
      helpItem(label('naturalEvents'), 'naturalEventsTech'),
      helpItem(label('fires'), 'techFires'),
      helpItem(staticLabel('countries'), 'countriesOverlay'),
      helpItem(label('dayNight'), 'dayNight'),
    ])}
      </div>
    `;

    const financeHelpContent = `
      ${helpHeader}
      <div class="layer-help-content">
        ${helpSection('financeCore', [
      helpItem(label('stockExchanges'), 'financeExchanges'),
      helpItem(label('financialCenters'), 'financeCenters'),
      helpItem(label('centralBanks'), 'financeCentralBanks'),
      helpItem(label('commodityHubs'), 'financeCommodityHubs'),
      helpItem(label('gulfInvestments'), 'financeGulfInvestments'),
    ])}
        ${helpSection('infrastructureRisk', [
      helpItem(label('underseaCables'), 'financeCables'),
      helpItem(label('pipelines'), 'financePipelines'),
      helpItem(label('internetOutages'), 'financeOutages'),
      helpItem(label('cyberThreats'), 'financeCyberThreats'),
      helpItem(label('tradeRoutes'), 'tradeRoutes'),
    ])}
        ${helpSection('macroContext', [
      helpItem(label('economicCenters'), 'economicCenters'),
      helpItem(label('strategicWaterways'), 'macroWaterways'),
      helpItem(label('weatherAlerts'), 'weatherAlertsMarket'),
      helpItem(label('naturalEvents'), 'naturalEventsMacro'),
      helpItem(label('dayNight'), 'dayNight'),
    ])}
      </div>
    `;

    const fullHelpContent = `
      ${helpHeader}
      <div class="layer-help-content">
        ${helpSection('timeFilter', [
      helpItem(staticLabel('timeRecent'), 'timeRecent'),
      helpItem(staticLabel('timeExtended'), 'timeExtended'),
    ], 'timeAffects')}
        ${helpSection('geopolitical', [
      helpItem(label('conflictZones'), 'geoConflicts'),

      helpItem(label('intelHotspots'), 'geoHotspots'),
      helpItem(staticLabel('sanctions'), 'geoSanctions'),
      helpItem(label('protests'), 'geoProtests'),
      helpItem(label('ucdpEvents'), 'geoUcdpEvents'),
      helpItem(label('displacementFlows'), 'geoDisplacement'),
    ])}
        ${helpSection('militaryStrategic', [
      helpItem(label('militaryBases'), 'militaryBases'),
      helpItem(label('nuclearSites'), 'militaryNuclear'),
      helpItem(label('gammaIrradiators'), 'militaryIrradiators'),
      helpItem(label('militaryActivity'), 'militaryActivity'),
      helpItem(label('spaceports'), 'militarySpaceports'),
    ])}
        ${helpSection('infrastructure', [
      helpItem(label('underseaCables'), 'infraCablesFull'),
      helpItem(label('pipelines'), 'infraPipelinesFull'),
      helpItem(label('internetOutages'), 'infraOutages'),
      helpItem(label('aiDataCenters'), 'infraDatacentersFull'),
      helpItem(label('cyberThreats'), 'infraCyberThreats'),
    ])}
        ${helpSection('transport', [
      helpItem(label('shipTraffic'), 'transportShipping'),
      helpItem(label('tradeRoutes'), 'tradeRoutes'),
      helpItem(label('flightDelays'), 'transportDelays'),
    ])}
        ${helpSection('naturalEconomic', [
      helpItem(label('naturalEvents'), 'naturalEventsFull'),
      helpItem(label('fires'), 'firesFull'),
      helpItem(label('weatherAlerts'), 'weatherAlerts'),
      helpItem(label('climateAnomalies'), 'climateAnomalies'),
      helpItem(label('economicCenters'), 'economicCenters'),
      helpItem(label('criticalMinerals'), 'mineralsFull'),
    ])}
        ${helpSection('overlays', [
      helpItem(label('dayNight'), 'dayNight'),
      helpItem(staticLabel('countries'), 'countriesOverlay'),
      helpItem(label('strategicWaterways'), 'waterwaysLabels'),
    ])}
      </div>
    `;

    popup.innerHTML = SITE_VARIANT === 'tech'
      ? techHelpContent
      : SITE_VARIANT === 'finance'
        ? financeHelpContent
        : fullHelpContent;

    popup.querySelector('.layer-help-close')?.addEventListener('click', () => popup.remove());

    // Prevent scroll events from propagating to map
    const content = popup.querySelector('.layer-help-content');
    if (content) {
      content.addEventListener('wheel', (e: any) => e.stopPropagation(), { passive: false });
      content.addEventListener('touchmove', (e: any) => e.stopPropagation(), { passive: false });
    }

    // Close on click outside
    setTimeout(() => {
      const closeHandler = (e: MouseEvent) => {
        if (!popup.contains(e.target as Node)) {
          popup.remove();
          document.removeEventListener('click', closeHandler);
        }
      };
      document.addEventListener('click', closeHandler);
    }, 100);

    this.container.appendChild(popup);
  }

  private createLegend(): void {
    const legend = document.createElement('div');
    legend.className = 'map-legend deckgl-legend';

    // SVG shapes for different marker types
    const shapes = {
      circle: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="${color}"/></svg>`,
      triangle: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><polygon points="6,1 11,10 1,10" fill="${color}"/></svg>`,
      square: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="1" fill="${color}"/></svg>`,
      hexagon: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><polygon points="6,1 10.5,3.5 10.5,8.5 6,11 1.5,8.5 1.5,3.5" fill="${color}"/></svg>`,
    };

    const isLight = getCurrentTheme() === 'light';
    const legendItems = SITE_VARIANT === 'tech'
      ? [
        { shape: shapes.circle(isLight ? 'rgb(22, 163, 74)' : 'rgb(0, 255, 150)'), label: t('components.deckgl.legend.startupHub') },
        { shape: shapes.circle('rgb(100, 200, 255)'), label: t('components.deckgl.legend.techHQ') },
        { shape: shapes.circle(isLight ? 'rgb(180, 120, 0)' : 'rgb(255, 200, 0)'), label: t('components.deckgl.legend.accelerator') },
        { shape: shapes.circle('rgb(150, 100, 255)'), label: t('components.deckgl.legend.cloudRegion') },
        { shape: shapes.square('rgb(136, 68, 255)'), label: t('components.deckgl.legend.datacenter') },
      ]
      : SITE_VARIANT === 'finance'
        ? [
          { shape: shapes.circle('rgb(255, 215, 80)'), label: t('components.deckgl.legend.stockExchange') },
          { shape: shapes.circle('rgb(0, 220, 150)'), label: t('components.deckgl.legend.financialCenter') },
          { shape: shapes.hexagon('rgb(255, 210, 80)'), label: t('components.deckgl.legend.centralBank') },
          { shape: shapes.square('rgb(255, 150, 80)'), label: t('components.deckgl.legend.commodityHub') },
          { shape: shapes.triangle('rgb(80, 170, 255)'), label: t('components.deckgl.legend.waterway') },
        ]
        : SITE_VARIANT === 'happy'
          ? [
            { shape: shapes.circle('rgb(34, 197, 94)'), label: 'Positive Event' },
            { shape: shapes.circle('rgb(234, 179, 8)'), label: 'Breakthrough' },
            { shape: shapes.circle('rgb(74, 222, 128)'), label: 'Act of Kindness' },
            { shape: shapes.circle('rgb(255, 100, 50)'), label: 'Natural Event' },
            { shape: shapes.square('rgb(34, 180, 100)'), label: 'Happy Country' },
            { shape: shapes.circle('rgb(74, 222, 128)'), label: 'Species Recovery Zone' },
            { shape: shapes.circle('rgb(255, 200, 50)'), label: 'Renewable Installation' },
            { shape: shapes.circle('rgb(160, 100, 255)'), label: t('components.deckgl.legend.aircraft') },
          ]
          : [
            { shape: shapes.circle('rgb(255, 68, 68)'), label: t('components.deckgl.legend.highAlert') },
            { shape: shapes.circle('rgb(255, 165, 0)'), label: t('components.deckgl.legend.elevated') },
            { shape: shapes.circle(isLight ? 'rgb(180, 120, 0)' : 'rgb(255, 255, 0)'), label: t('components.deckgl.legend.monitoring') },
            { shape: shapes.triangle('rgb(68, 136, 255)'), label: t('components.deckgl.legend.base') },
            { shape: shapes.hexagon(isLight ? 'rgb(180, 120, 0)' : 'rgb(255, 220, 0)'), label: t('components.deckgl.legend.nuclear') },
            { shape: shapes.square('rgb(136, 68, 255)'), label: t('components.deckgl.legend.datacenter') },
            { shape: shapes.circle('rgb(160, 100, 255)'), label: t('components.deckgl.legend.aircraft') },
          ];

    legend.innerHTML = `
      <span class="legend-label-title">${t('components.deckgl.legend.title')}</span>
      ${legendItems.map(({ shape, label }) => `<span class="legend-item">${shape}<span class="legend-label">${label}</span></span>`).join('')}
    `;

    // CII choropleth gradient legend (shown when layer is active)
    const ciiLegend = document.createElement('div');
    ciiLegend.className = 'cii-choropleth-legend';
    ciiLegend.id = 'ciiChoroplethLegend';
    ciiLegend.style.display = (this.state.layers as any).ciiChoropleth ? 'block' : 'none';
    ciiLegend.innerHTML = `
      <span class="legend-label-title" style="font-size:9px;letter-spacing:0.5px;">CII SCALE</span>
      <div style="display:flex;align-items:center;gap:2px;margin-top:2px;">
        <div style="width:100%;height:8px;border-radius:3px;background:linear-gradient(to right,#28b33e,#dcc030,#e87425,#dc2626,#7f1d1d);"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:8px;opacity:0.7;margin-top:1px;">
        <span>0</span><span>31</span><span>51</span><span>66</span><span>81</span><span>100</span>
      </div>
    `;
    legend.appendChild(ciiLegend);

    this.container.appendChild(legend);
  }

  // Public API methods (matching MapComponent interface)
  public render(): void {
    if (this.renderPaused) {
      this.renderPending = true;
      return;
    }
    if (this.renderRafId !== null) {
      cancelAnimationFrame(this.renderRafId);
    }
    this.renderRafId = requestAnimationFrame(() => {
      this.renderRafId = null;
      this.updateLayers();
    });
  }

  public setRenderPaused(paused: boolean): void {
    if (this.renderPaused === paused) return;
    this.renderPaused = paused;
    if (paused) {
      if (this.renderRafId !== null) {
        cancelAnimationFrame(this.renderRafId);
        this.renderRafId = null;
        this.renderPending = true;
      }
      this.stopPulseAnimation();
      this.stopDayNightTimer();
      return;
    }

    this.syncPulseAnimation();
    if (this.state.layers.dayNight) this.startDayNightTimer();
    if (!paused && this.renderPending) {
      this.renderPending = false;
      this.render();
    }
  }

  private updateLayers(): void {
    if (this.renderPaused || this.webglLost || !this.maplibreMap) return;
    const startTime = performance.now();
    try {
      this.deckOverlay?.setProps({ layers: this.buildLayers() });
    } catch { /* map may be mid-teardown (null.getProjection) */ }
    this.maplibreMap.triggerRepaint();
    const elapsed = performance.now() - startTime;
    if (import.meta.env.DEV && elapsed > 16) {
      console.warn(`[DeckGLMap] updateLayers took ${elapsed.toFixed(2)}ms (>16ms budget)`);
    }
    this.updateZoomHints();
  }

  private updateZoomHints(): void {
    const toggleList = this.container.querySelector('.deckgl-layer-toggles .toggle-list');
    if (!toggleList) return;
    for (const [key, enabled] of Object.entries(this.state.layers)) {
      const toggle = toggleList.querySelector(`.layer-toggle[data-layer="${key}"]`) as HTMLElement | null;
      if (!toggle) continue;
      const zoomHidden = !!enabled && !this.isLayerVisible(key as keyof MapLayers);
      toggle.classList.toggle('zoom-hidden', zoomHidden);
    }
  }

  public setView(view: DeckMapView): void {
    const preset = VIEW_PRESETS[view];
    if (!preset) return;
    this.state.view = view;

    if (this.maplibreMap) {
      this.maplibreMap.flyTo({
        center: [preset.longitude, preset.latitude],
        zoom: preset.zoom,
        duration: 1000,
      });
    }

    const viewSelect = this.container.querySelector('.view-select') as HTMLSelectElement;
    if (viewSelect) viewSelect.value = view;

    this.onStateChange?.(this.getState());
  }

  public setZoom(zoom: number): void {
    this.state.zoom = zoom;
    if (this.maplibreMap) {
      this.maplibreMap.setZoom(zoom);
    }
  }

  public setCenter(lat: number, lon: number, zoom?: number): void {
    if (this.maplibreMap) {
      this.maplibreMap.flyTo({
        center: [lon, lat],
        ...(zoom != null && { zoom }),
        duration: 500,
      });
    }
  }

  public fitCountry(code: string): void {
    const bbox = getCountryBbox(code);
    if (!bbox || !this.maplibreMap) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    this.maplibreMap.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
      padding: 40,
      duration: 800,
      maxZoom: 8,
    });
  }

  public getCenter(): { lat: number; lon: number } | null {
    if (this.maplibreMap) {
      const center = this.maplibreMap.getCenter();
      return { lat: center.lat, lon: center.lng };
    }
    return null;
  }

  public getBbox(): string | null {
    if (!this.maplibreMap) return null;
    const b = this.maplibreMap.getBounds();
    return `${b.getWest().toFixed(4)},${b.getSouth().toFixed(4)},${b.getEast().toFixed(4)},${b.getNorth().toFixed(4)}`;
  }

  public setTimeRange(range: TimeRange): void {
    this.state.timeRange = range;
    this.rebuildProtestSupercluster();
    this.onTimeRangeChange?.(range);
    this.updateTimeSliderButtons();
    this.render(); // Debounced
  }

  public getTimeRange(): TimeRange {
    return this.state.timeRange;
  }

  public setLayers(layers: MapLayers): void {
    this.state.layers = { ...layers };
    if (!this.state.layers.celescOutages) {
      this.setSelectedCityInfo(null);
    }
    this.manageAircraftTimer(this.state.layers.flights);
    this.render(); // Debounced

    Object.entries(this.state.layers).forEach(([key, value]) => {
      const toggle = this.container.querySelector(`.layer-toggle[data-layer="${key}"] input`) as HTMLInputElement;
      if (toggle) toggle.checked = value;
    });
  }

  public getState(): DeckMapState {
    return {
      ...this.state,
      pan: { ...this.state.pan },
      layers: { ...this.state.layers },
    };
  }

  // Zoom controls - public for external access
  public zoomIn(): void {
    if (this.maplibreMap) {
      this.maplibreMap.zoomIn();
    }
  }

  public zoomOut(): void {
    if (this.maplibreMap) {
      this.maplibreMap.zoomOut();
    }
  }

  private resetView(): void {
    this.setView('global');
  }






  /**
   * Compute the solar terminator polygon (night side of the Earth).
   * Uses standard astronomical formulas to find the subsolar point,
   * then traces the terminator line and closes around the dark pole.
   */
  private computeNightPolygon(): [number, number][] {
    const now = new Date();
    const JD = now.getTime() / 86400000 + 2440587.5;
    const D = JD - 2451545.0; // Days since J2000.0

    // Solar mean anomaly (radians)
    const g = ((357.529 + 0.98560028 * D) % 360) * Math.PI / 180;

    // Solar ecliptic longitude (degrees)
    const q = (280.459 + 0.98564736 * D) % 360;
    const L = q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g);
    const LRad = L * Math.PI / 180;

    // Obliquity of ecliptic (radians)
    const eRad = (23.439 - 0.00000036 * D) * Math.PI / 180;

    // Solar declination (radians)
    const decl = Math.asin(Math.sin(eRad) * Math.sin(LRad));

    // Solar right ascension (radians)
    const RA = Math.atan2(Math.cos(eRad) * Math.sin(LRad), Math.cos(LRad));

    // Greenwich Mean Sidereal Time (degrees)
    const GMST = ((18.697374558 + 24.06570982441908 * D) % 24) * 15;

    // Sub-solar longitude (degrees, normalized to [-180, 180])
    let sunLng = RA * 180 / Math.PI - GMST;
    sunLng = ((sunLng % 360) + 540) % 360 - 180;

    // Trace terminator line (1Ã‚Â° steps for smooth curve at high zoom)
    const tanDecl = Math.tan(decl);
    const points: [number, number][] = [];

    // Near equinox (|tanDecl| Ã¢â€°Ë† 0), the terminator is nearly a great circle
    // through the poles Ã¢â‚¬â€ use a vertical line at the subsolar meridian Ã‚Â±90Ã‚Â°
    if (Math.abs(tanDecl) < 1e-6) {
      for (let lat = -90; lat <= 90; lat += 1) {
        points.push([sunLng + 90, lat]);
      }
      for (let lat = 90; lat >= -90; lat -= 1) {
        points.push([sunLng - 90, lat]);
      }
      return points;
    }

    for (let lng = -180; lng <= 180; lng += 1) {
      const ha = (lng - sunLng) * Math.PI / 180;
      const lat = Math.atan(-Math.cos(ha) / tanDecl) * 180 / Math.PI;
      points.push([lng, lat]);
    }

    // Close polygon around the dark pole
    const darkPoleLat = decl > 0 ? -90 : 90;
    points.push([180, darkPoleLat]);
    points.push([-180, darkPoleLat]);

    return points;
  }

  private createDayNightLayer(): PolygonLayer {
    const nightPolygon = this.cachedNightPolygon ?? (this.cachedNightPolygon = this.computeNightPolygon());
    const isLight = getCurrentTheme() === 'light';

    return new PolygonLayer({
      id: 'day-night-layer',
      data: [{ polygon: nightPolygon }],
      getPolygon: (d: { polygon: [number, number][] }) => d.polygon,
      getFillColor: isLight ? [0, 0, 40, 35] : [0, 0, 20, 55],
      filled: true,
      stroked: true,
      getLineColor: isLight ? [100, 100, 100, 40] : [200, 200, 255, 25],
      getLineWidth: 1,
      lineWidthUnits: 'pixels' as const,
      pickable: false,
    });
  }

  // Data setters - all use render() for debouncing
  public setEarthquakes(earthquakes: Earthquake[]): void {
    this.earthquakes = earthquakes;
    this.render();
  }

  public setWeatherAlerts(alerts: WeatherAlert[]): void {
    this.weatherAlerts = alerts;
    this.render();
  }

  public setImageryScenes(scenes: ImageryScene[]): void {
    (this as any).imageryScenes = scenes;
    this.render();
  }

  public setOutages(outages: InternetOutage[]): void {
    this.outages = outages;
    this.render();
  }

  public setCyberThreats(threats: any /* CyberThreat removed */[]): void {
    (this as any).cyberThreats = threats;
    this.render();
  }

  public setIranEvents(events: any /* IranEvent removed */[]): void {
    (this as any).iranEvents = events;
    this.render();
  }

  public setAisData(disruptions: AisDisruptionEvent[], density: AisDensityZone[]): void {
    (this as any).aisDisruptions = disruptions;
    (this as any).aisDensity = density;
    this.render();
  }

  public setCableActivity(advisories: CableAdvisory[], repairShips: RepairShip[]): void {
    (this as any).cableAdvisories = advisories;
    (this as any).repairShips = repairShips;
    this.render();
  }


  public setCableHealth(healthMap: Record<string, CableHealthRecord>): void {
    (this as any).healthByCableId = healthMap;
    this.layerCache.delete('cables-layer');
    this.render();
  }

  public setProtests(events: SocialUnrestEvent[]): void {
    (this as any).protests = events;
    this.rebuildProtestSupercluster();
    this.render();
    this.syncPulseAnimation();
  }

  public setFlightDelays(delays: AirportDelayAlert[]): void {
    this.flightDelays = delays;
    this.render();
  }

  public setAircraftPositions(positions: PositionSample[]): void {
    this.aircraftPositions = positions;
    this.render();
  }

  public setMilitaryFlights(flights: MilitaryFlight[], clusters: MilitaryFlightCluster[] = []): void {
    (this as any).militaryFlights = flights;
    (this as any).militaryFlightClusters = clusters;
    this.render();
  }

  public setMilitaryVessels(vessels: MilitaryVessel[], clusters: MilitaryVesselCluster[] = []): void {
    (this as any).militaryVessels = vessels;
    (this as any).militaryVesselClusters = clusters;
    this.render();
  }


  private manageAircraftTimer(enabled: boolean): void {
    if (enabled) {
      if (!this.aircraftFetchTimer) {
        this.aircraftFetchTimer = setInterval(() => {
          this.lastAircraftFetchCenter = null; // force refresh on poll
          this.fetchViewportAircraft();
        }, 120_000); // Match server cache TTL (120s anonymous OpenSky tier)
        this.debouncedFetchAircraft();
      }
    } else {
      if (this.aircraftFetchTimer) {
        clearInterval(this.aircraftFetchTimer);
        this.aircraftFetchTimer = null;
      }
      this.aircraftPositions = [];
    }
  }

  private hasAircraftViewportChanged(): boolean {
    if (!this.maplibreMap) return false;
    if (!this.lastAircraftFetchCenter) return true;
    const center = this.maplibreMap.getCenter();
    const zoom = this.maplibreMap.getZoom();
    if (Math.abs(zoom - this.lastAircraftFetchZoom) >= 1) return true;
    const [prevLng, prevLat] = this.lastAircraftFetchCenter;
    // Threshold scales with zoom Ã¢â‚¬â€ higher zoom = smaller movement triggers fetch
    const threshold = Math.max(0.1, 2 / Math.pow(2, Math.max(0, zoom - 3)));
    return Math.abs(center.lat - prevLat) > threshold || Math.abs(center.lng - prevLng) > threshold;
  }

  private fetchViewportAircraft(): void {
    if (!this.maplibreMap) return;
    if (!this.state.layers.flights) return;
    const zoom = this.maplibreMap.getZoom();
    if (zoom < 2) {
      if (this.aircraftPositions.length > 0) {
        this.aircraftPositions = [];
        this.render();
      }
      return;
    }
    if (!this.hasAircraftViewportChanged()) return;
    const bounds = this.maplibreMap.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const seq = ++this.aircraftFetchSeq;
    fetchAircraftPositions({
      swLat: sw.lat, swLon: sw.lng,
      neLat: ne.lat, neLon: ne.lng,
    }).then((positions) => {
      if (seq !== this.aircraftFetchSeq) return; // discard stale response
      this.aircraftPositions = positions;
      this.onAircraftPositionsUpdate?.(positions);
      const center = this.maplibreMap?.getCenter();
      if (center) {
        this.lastAircraftFetchCenter = [center.lng, center.lat];
        this.lastAircraftFetchZoom = this.maplibreMap!.getZoom();
      }
      this.render();
    }).catch((err) => {
      console.error('[aircraft] fetch error', err);
    });
  }

  public setNaturalEvents(events: NaturalEvent[]): void {
    this.naturalEvents = events;
    this.render();
  }

  public setFires(fires: Array<{ lat: number; lon: number; brightness: number; frp: number; confidence: number; region: string; acq_date: string; daynight: string }>): void {
    this.firmsFireData = fires;
    this.render();
  }

  public setTechEvents(events: TechEventMarker[]): void {
    this.techEvents = events;
    this.rebuildTechEventSupercluster();
    this.render();
  }

  public setUcdpEvents(events: UcdpGeoEvent[]): void {
    (this as any).ucdpEvents = events;
    this.render();
  }

  public setDisplacementFlows(flows: any /* DisplacementFlow removed */[]): void {
    (this as any).displacementFlows = flows;
    this.render();
  }

  public setClimateAnomalies(anomalies: ClimateAnomaly[]): void {
    this.climateAnomalies = anomalies;
    this.render();
  }

  public setGpsJamming(hexes: GpsJamHex[]): void {
    (this as any).gpsJammingHexes = hexes;
    this.render();
  }

  public setNewsLocations(data: Array<{ lat: number; lon: number; title: string; threatLevel: string; timestamp?: Date }>): void {
    const now = Date.now();
    for (const d of data) {
      if (!this.newsLocationFirstSeen.has(d.title)) {
        this.newsLocationFirstSeen.set(d.title, now);
      }
    }
    for (const [key, ts] of this.newsLocationFirstSeen) {
      if (now - ts > 60_000) this.newsLocationFirstSeen.delete(key);
    }
    this.newsLocations = data;
    this.render();

    this.syncPulseAnimation(now);
  }

  public setPositiveEvents(events: PositiveGeoEvent[]): void {
    this.positiveEvents = events;
    this.syncPulseAnimation();
    this.render();
  }

  public setKindnessData(points: KindnessPoint[]): void {
    this.kindnessPoints = points;
    this.syncPulseAnimation();
    this.render();
  }

  public setHappinessScores(data: HappinessData): void {
    this.happinessScores = data.scores;
    this.happinessYear = data.year;
    this.happinessSource = data.source;
    this.render();
  }

  public setCIIScores(scores: Array<{ code: string; score: number; level: string }>): void {
    this.ciiScoresMap = new Map(scores.map(s => [s.code, { score: s.score, level: s.level }]));
    this.ciiScoresVersion++;
    this.render();
  }

  public setSpeciesRecoveryZones(species: SpeciesRecovery[]): void {
    (this as any).speciesRecoveryZones = species.filter(
      (s): s is SpeciesRecovery & { recoveryZone: { name: string; lat: number; lon: number } } =>
        s.recoveryZone != null
    );
    this.render();
  }

  public setRenewableInstallations(installations: RenewableInstallation[]): void {
    (this as any).renewableInstallations = installations;
    this.render();
  }

  public updateHotspotActivity(news: NewsItem[]): void {
    this.news = news; // Store for related news lookup

    // Update hotspot "breaking" indicators based on recent news
    const breakingKeywords = new Set<string>();
    const recentNews = news.filter(n =>
      Date.now() - n.pubDate.getTime() < 2 * 60 * 60 * 1000 // Last 2 hours
    );

    // Count matches per hotspot for escalation tracking
    const matchCounts = new Map<string, number>();

    recentNews.forEach(item => {
      const tokens = tokenizeForMatch(item.title);
      this.hotspots.forEach(hotspot => {
        if (matchesAnyKeyword(tokens, hotspot.keywords)) {
          breakingKeywords.add(hotspot.id);
          matchCounts.set(hotspot.id, (matchCounts.get(hotspot.id) || 0) + 1);
        }
      });
    });

    this.hotspots.forEach(h => {
      h.hasBreaking = breakingKeywords.has(h.id);
      const matchCount = matchCounts.get(h.id) || 0;
      // Calculate a simple velocity metric (matches per hour normalized)
      const velocity = matchCount > 0 ? matchCount / 2 : 0; // 2 hour window
      updateHotspotEscalation(h.id, matchCount, h.hasBreaking || false, velocity);
    });

    this.render();
    this.syncPulseAnimation();
  }

  /** Get news items related to a hotspot by keyword matching */
  private getRelatedNews(hotspot: Hotspot): NewsItem[] {
    const conflictTopics = ['gaza', 'ukraine', 'ukrainian', 'russia', 'russian', 'israel', 'israeli', 'iran', 'iranian', 'china', 'chinese', 'taiwan', 'taiwanese', 'korea', 'korean', 'syria', 'syrian'];

    return this.news
      .map((item) => {
        const tokens = tokenizeForMatch(item.title);
        const matchedKeywords = findMatchingKeywords(tokens, hotspot.keywords);

        if (matchedKeywords.length === 0) return null;

        const conflictMatches = conflictTopics.filter(t =>
          matchKeyword(tokens, t) && !hotspot.keywords.some(k => k.toLowerCase().includes(t))
        );

        if (conflictMatches.length > 0) {
          const strongLocalMatch = matchedKeywords.some(kw =>
            kw.toLowerCase() === hotspot.name.toLowerCase() ||
            hotspot.agencies?.some(a => matchKeyword(tokens, a))
          );
          if (!strongLocalMatch) return null;
        }

        const score = matchedKeywords.length;
        return { item, score };
      })
      .filter((x): x is { item: NewsItem; score: number } => x !== null)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 5)
      .map(x => x.item);
  }

  public updateMilitaryForEscalation(flights: MilitaryFlight[], vessels: MilitaryVessel[]): void {
    setMilitaryData(flights, vessels);
  }

  public getHotspotDynamicScore(hotspotId: string) {
    return getHotspotEscalation(hotspotId);
  }

  /** Get military flight clusters for rendering/analysis */
  public getMilitaryFlightClusters(): MilitaryFlightCluster[] {
    return (this as any).militaryFlightClusters;
  }

  /** Get military vessel clusters for rendering/analysis */
  public getMilitaryVesselClusters(): MilitaryVesselCluster[] {
    return (this as any).militaryVesselClusters;
  }

  public highlightAssets(assets: RelatedAsset[] | null): void {
    // Clear previous highlights
    Object.values(this.highlightedAssets).forEach(set => set.clear());

    if (assets) {
      assets.forEach(asset => {
        if (asset?.type && this.highlightedAssets[asset.type]) {
          this.highlightedAssets[asset.type].add(asset.id);
        }
      });
    }

    this.render(); // Debounced
  }

  public setOnHotspotClick(callback: (hotspot: Hotspot) => void): void {
    this.onHotspotClick = callback;
  }

  public setOnTimeRangeChange(callback: (range: TimeRange) => void): void {
    this.onTimeRangeChange = callback;
  }

  public setOnLayerChange(callback: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void): void {
    this.onLayerChange = callback;
  }

  public setOnStateChange(callback: (state: DeckMapState) => void): void {
    this.onStateChange = callback;
  }

  public setOnAircraftPositionsUpdate(callback: (positions: PositionSample[]) => void): void {
    this.onAircraftPositionsUpdate = callback;
  }

  public getHotspotLevels(): Record<string, string> {
    const levels: Record<string, string> = {};
    this.hotspots.forEach(h => {
      levels[h.name] = h.level || 'low';
    });
    return levels;
  }

  public setHotspotLevels(levels: Record<string, string>): void {
    this.hotspots.forEach(h => {
      if (levels[h.name]) {
        h.level = levels[h.name] as 'low' | 'elevated' | 'high';
      }
    });
    this.render(); // Debounced
  }

  public initEscalationGetters(): void {
    setCIIGetter(getCountryScore);
    setGeoAlertGetter(getAlertsNearLocation);
  }

  private layerWarningShown = false;
  private lastActiveLayerCount = 0;

  private enforceLayerLimit(): void {
    const WARN_THRESHOLD = 10;
    const togglesEl = this.container.querySelector('.deckgl-layer-toggles');
    if (!togglesEl) return;
    const activeCount = Array.from(togglesEl.querySelectorAll<HTMLInputElement>('.layer-toggle input'))
      .filter(i => (i.closest('.layer-toggle') as HTMLElement)?.style.display !== 'none')
      .filter(i => i.checked).length;
    const increasing = activeCount > this.lastActiveLayerCount;
    this.lastActiveLayerCount = activeCount;
    if (activeCount >= WARN_THRESHOLD && increasing && !this.layerWarningShown) {
      this.layerWarningShown = true;
      showLayerWarning(WARN_THRESHOLD);
    } else if (activeCount < WARN_THRESHOLD) {
      this.layerWarningShown = false;
    }
  }

  // UI visibility methods
  public hideLayerToggle(layer: keyof MapLayers): void {
    const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (toggle) {
      (toggle as HTMLElement).style.display = 'none';
      toggle.setAttribute('data-layer-hidden', '');
    }
  }

  public setLayerLoading(layer: keyof MapLayers, loading: boolean): void {
    const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (toggle) toggle.classList.toggle('loading', loading);
  }

  public setLayerReady(layer: keyof MapLayers, hasData: boolean): void {
    const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (!toggle) return;

    toggle.classList.remove('loading');
    // Match old Map.ts behavior: set 'active' only when layer enabled AND has data
    if (this.state.layers[layer] && hasData) {
      toggle.classList.add('active');
    } else {
      toggle.classList.remove('active');
    }
  }

  public flashAssets(assetType: AssetType, ids: string[]): void {
    if (!this.highlightedAssets[assetType]) return;
    ids.forEach(id => this.highlightedAssets[assetType].add(id));
    this.render();

    setTimeout(() => {
      ids.forEach(id => this.highlightedAssets[assetType]?.delete(id));
      this.render();
    }, 3000);
  }

  // Enable layer programmatically
  public enableLayer(layer: keyof MapLayers): void {
    if (!this.state.layers[layer]) {
      this.state.layers[layer] = true;
      const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"] input`) as HTMLInputElement;
      if (toggle) toggle.checked = true;
      this.render();
      this.onLayerChange?.(layer, true, 'programmatic');
      this.enforceLayerLimit();
    }
  }

  // Toggle layer on/off programmatically
  public toggleLayer(layer: keyof MapLayers): void {
    this.state.layers[layer] = !this.state.layers[layer];
    const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"] input`) as HTMLInputElement;
    if (toggle) toggle.checked = this.state.layers[layer];
    this.render();
    this.onLayerChange?.(layer, this.state.layers[layer], 'programmatic');
    this.enforceLayerLimit();
  }

  // Get center coordinates for programmatic popup positioning
  private getContainerCenter(): { x: number; y: number } {
    const rect = this.container.getBoundingClientRect();
    return { x: rect.width / 2, y: rect.height / 2 };
  }

  // Project lat/lon to screen coordinates without moving the map
  private projectToScreen(lat: number, lon: number): { x: number; y: number } | null {
    if (!this.maplibreMap) return null;
    const point = this.maplibreMap.project([lon, lat]);
    return { x: point.x, y: point.y };
  }

  // Trigger click methods - show popup at item location without moving the map
  public triggerHotspotClick(id: string): void {
    const hotspot = this.hotspots.find(h => h.id === id);
    if (!hotspot) return;

    // Get screen position for popup
    const screenPos = this.projectToScreen(hotspot.lat, hotspot.lon);
    const { x, y } = screenPos || this.getContainerCenter();

    // Get related news and show popup
    const relatedNews = this.getRelatedNews(hotspot);
    this.popup.show({
      type: 'hotspot',
      data: hotspot,
      relatedNews,
      x,
      y,
    });
    this.popup.loadHotspotGdeltContext(hotspot);
    this.onHotspotClick?.(hotspot);
  }

  public triggerConflictClick(id: string): void {
    const conflict = CONFLICT_ZONES.find(c => c.id === id);
    if (conflict) {
      // Don't pan - show popup at projected screen position or center
      const screenPos = this.projectToScreen(conflict.center[1], conflict.center[0]);
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'conflict', data: conflict, x, y });
    }
  }

  public triggerBaseClick(id: string): void {
    const base = (this as any).serverBases.find((b: any) => b.id === id) || MILITARY_BASES.find((b: any) => b.id === id);
    if (base) {
      const screenPos = this.projectToScreen(base.lat, base.lon);
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'base', data: base, x, y });
    }
  }

  public triggerPipelineClick(id: string): void {
    const pipeline = PIPELINES.find(p => p.id === id);
    if (pipeline && pipeline.points.length > 0) {
      const midIdx = Math.floor(pipeline.points.length / 2);
      const midPoint = pipeline.points[midIdx];
      // Don't pan - show popup at projected screen position or center
      const screenPos = midPoint ? this.projectToScreen(midPoint[1], midPoint[0]) : null;
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'pipeline', data: pipeline, x, y });
    }
  }

  public triggerCableClick(id: string): void {
    const cable = UNDERSEA_CABLES.find(c => c.id === id);
    if (cable && cable.points.length > 0) {
      const midIdx = Math.floor(cable.points.length / 2);
      const midPoint = cable.points[midIdx];
      // Don't pan - show popup at projected screen position or center
      const screenPos = midPoint ? this.projectToScreen(midPoint[1], midPoint[0]) : null;
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'cable', data: cable, x, y });
    }
  }

  public triggerDatacenterClick(id: string): void {
    const dc = AI_DATA_CENTERS.find(d => d.id === id);
    if (dc) {
      // Don't pan - show popup at projected screen position or center
      const screenPos = this.projectToScreen(dc.lat, dc.lon);
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'datacenter', data: dc, x, y });
    }
  }

  public triggerNuclearClick(id: string): void {
    const facility = NUCLEAR_FACILITIES.find(n => n.id === id);
    if (facility) {
      // Don't pan - show popup at projected screen position or center
      const screenPos = this.projectToScreen(facility.lat, facility.lon);
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'nuclear', data: facility, x, y });
    }
  }

  public triggerIrradiatorClick(id: string): void {
    const irradiator = GAMMA_IRRADIATORS.find(i => i.id === id);
    if (irradiator) {
      // Don't pan - show popup at projected screen position or center
      const screenPos = this.projectToScreen(irradiator.lat, irradiator.lon);
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'irradiator', data: irradiator, x, y });
    }
  }

  public flashLocation(lat: number, lon: number, durationMs = 2000): void {
    // Don't pan - project coordinates to screen position
    const screenPos = this.projectToScreen(lat, lon);
    if (!screenPos) return;

    // Flash effect by temporarily adding a highlight at the location
    const flashMarker = document.createElement('div');
    flashMarker.className = 'flash-location-marker';
    flashMarker.style.cssText = `
      position: absolute;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.5);
      border: 2px solid #fff;
      animation: flash-pulse 0.5s ease-out infinite;
      pointer-events: none;
      z-index: 1000;
      left: ${screenPos.x}px;
      top: ${screenPos.y}px;
      transform: translate(-50%, -50%);
    `;

    // Add animation keyframes if not present
    if (!document.getElementById('flash-animation-styles')) {
      const style = document.createElement('style');
      style.id = 'flash-animation-styles';
      style.textContent = `
        @keyframes flash-pulse {
          0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          100% { transform: translate(-50%, -50%) scale(2); opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }

    const wrapper = this.container.querySelector('.deckgl-map-wrapper');
    if (wrapper) {
      wrapper.appendChild(flashMarker);
      setTimeout(() => flashMarker.remove(), durationMs);
    }
  }

  // --- Country click + highlight ---

  public setOnCountryClick(cb: (country: CountryClickPayload) => void): void {
    this.onCountryClick = cb;
  }

  private resolveCountryFromCoordinate(lon: number, lat: number): { code: string; name: string } | null {
    const fromGeometry = getCountryAtCoordinates(lat, lon);
    if (fromGeometry) return fromGeometry;
    if (!this.maplibreMap || !this.countryGeoJsonLoaded) return null;
    try {
      const point = this.maplibreMap.project([lon, lat]);
      const features = this.maplibreMap.queryRenderedFeatures(point, { layers: ['country-interactive'] });
      const properties = (features?.[0]?.properties ?? {}) as Record<string, unknown>;
      const code = typeof properties['ISO3166-1-Alpha-2'] === 'string'
        ? properties['ISO3166-1-Alpha-2'].trim().toUpperCase()
        : '';
      const name = typeof properties.name === 'string'
        ? properties.name.trim()
        : '';
      if (!code || !name) return null;
      return { code, name };
    } catch {
      return null;
    }
  }

  private loadCountryBoundaries(): void {
    if (!this.maplibreMap || this.countryGeoJsonLoaded) return;
    this.countryGeoJsonLoaded = true;

    getCountriesGeoJson()
      .then((geojson) => {
        if (!this.maplibreMap || !geojson) return;
        (this as any).countriesGeoJsonData = geojson;
        (this as any).conflictZoneGeoJson = null;
        this.maplibreMap.addSource('country-boundaries', {
          type: 'geojson',
          data: geojson,
        });
        this.maplibreMap.addLayer({
          id: 'country-interactive',
          type: 'fill',
          source: 'country-boundaries',
          paint: {
            'fill-color': '#3b82f6',
            'fill-opacity': 0,
          },
        });
        this.maplibreMap.addLayer({
          id: 'country-hover-fill',
          type: 'fill',
          source: 'country-boundaries',
          paint: {
            'fill-color': '#3b82f6',
            'fill-opacity': 0.06,
          },
          filter: ['==', ['get', 'name'], ''],
        });
        this.maplibreMap.addLayer({
          id: 'country-highlight-fill',
          type: 'fill',
          source: 'country-boundaries',
          paint: {
            'fill-color': '#3b82f6',
            'fill-opacity': 0.12,
          },
          filter: ['==', ['get', 'ISO3166-1-Alpha-2'], ''],
        });
        this.maplibreMap.addLayer({
          id: 'country-highlight-border',
          type: 'line',
          source: 'country-boundaries',
          paint: {
            'line-color': '#3b82f6',
            'line-width': 1.5,
            'line-opacity': 0.5,
          },
          filter: ['==', ['get', 'ISO3166-1-Alpha-2'], ''],
        });

        if (!this.countryHoverSetup) this.setupCountryHover();
        const paintProvider = getMapProvider();
        const paintMapTheme = getMapTheme(paintProvider);
        this.updateCountryLayerPaint(isLightMapTheme(paintMapTheme) ? 'light' : 'dark');
        if (this.highlightedCountryCode) this.highlightCountry(this.highlightedCountryCode);
        this.render();
      })
      .catch((err) => console.warn('[DeckGLMap] Failed to load country boundaries:', err));
  }

  private setupCountryHover(): void {
    if (!this.maplibreMap || this.countryHoverSetup) return;
    this.countryHoverSetup = true;
    const map = this.maplibreMap;
    let hoveredName: string | null = null;

    map.on('mousemove', (e: any) => {
      if (!this.onCountryClick) return;
      const features = map.queryRenderedFeatures(e.point, { layers: ['country-interactive'] });
      const name = features?.[0]?.properties?.name as string | undefined;

      try {
        if (name && name !== hoveredName) {
          hoveredName = name;
          map.setFilter('country-hover-fill', ['==', ['get', 'name'], name]);
          map.getCanvas().style.cursor = 'pointer';
        } else if (!name && hoveredName) {
          hoveredName = null;
          map.setFilter('country-hover-fill', ['==', ['get', 'name'], '']);
          map.getCanvas().style.cursor = '';
        }
      } catch { /* style not done loading during theme switch */ }
    });

    map.on('mouseout', () => {
      if (hoveredName) {
        hoveredName = null;
        try {
          map.setFilter('country-hover-fill', ['==', ['get', 'name'], '']);
        } catch { /* style not done loading */ }
        map.getCanvas().style.cursor = '';
      }
    });
  }

  public highlightCountry(code: string): void {
    this.highlightedCountryCode = code;
    if (!this.maplibreMap || !this.countryGeoJsonLoaded) return;
    const filter = ['==', ['get', 'ISO3166-1-Alpha-2'], code] as maplibregl.FilterSpecification;
    try {
      this.maplibreMap.setFilter('country-highlight-fill', filter);
      this.maplibreMap.setFilter('country-highlight-border', filter);
    } catch { /* layer not ready yet */ }
  }

  public clearCountryHighlight(): void {
    this.highlightedCountryCode = null;
    if (!this.maplibreMap) return;
    const noMatch = ['==', ['get', 'ISO3166-1-Alpha-2'], ''] as maplibregl.FilterSpecification;
    try {
      this.maplibreMap.setFilter('country-highlight-fill', noMatch);
      this.maplibreMap.setFilter('country-highlight-border', noMatch);
    } catch { /* layer not ready */ }
  }

  private switchBasemap(): void {
    if (!this.maplibreMap) return;
    const provider = getMapProvider();
    const mapTheme = getMapTheme(provider);
    const style = isHappyVariant
      ? (getCurrentTheme() === 'light' ? HAPPY_LIGHT_STYLE : HAPPY_DARK_STYLE)
      : (this.usedFallbackStyle && provider === 'auto')
        ? (isLightMapTheme(mapTheme) ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE)
        : getStyleForProvider(provider, mapTheme);
    this.maplibreMap.setStyle(style);
    this.countryGeoJsonLoaded = false;
    this.maplibreMap.once('style.load', () => {
      localizeMapLabels(this.maplibreMap);
      this.loadCountryBoundaries();
      const paintTheme = isLightMapTheme(mapTheme) ? 'light' as const : 'dark' as const;
      this.updateCountryLayerPaint(paintTheme);
      this.render();
    });
    if (!isHappyVariant && provider !== 'openfreemap' && !this.usedFallbackStyle) {
      this.monitorTileLoading(mapTheme);
    }
  }

  private monitorTileLoading(mapTheme: string): void {
    if (!this.maplibreMap) return;
    const gen = ++this.tileMonitorGeneration;
    let ok = false;
    let errCount = 0;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const map = this.maplibreMap;

    const cleanup = () => {
      map.off('error', onError);
      map.off('data', onData);
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
    };

    const onError = (e: { error?: Error; message?: string }) => {
      if (gen !== this.tileMonitorGeneration) { cleanup(); return; }
      const msg = e.error?.message ?? e.message ?? '';
      if (msg.includes('Failed to fetch') || msg.includes('AJAXError') || msg.includes('CORS') || msg.includes('NetworkError') || msg.includes('403') || msg.includes('Forbidden')) {
        errCount++;
        if (!ok && errCount >= 2) {
          cleanup();
          this.switchToFallbackStyle(mapTheme);
        }
      }
    };

    const onData = (e: { dataType?: string }) => {
      if (gen !== this.tileMonitorGeneration) { cleanup(); return; }
      if (e.dataType === 'source') { ok = true; cleanup(); }
    };

    map.on('error', onError);
    map.on('data', onData);

    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (gen !== this.tileMonitorGeneration) return;
      cleanup();
      if (!ok) this.switchToFallbackStyle(mapTheme);
    }, 10000);
  }

  private switchToFallbackStyle(mapTheme: string): void {
    if (this.usedFallbackStyle || !this.maplibreMap) return;
    this.usedFallbackStyle = true;
    const fallback = isLightMapTheme(mapTheme) ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE;
    console.warn(`[DeckGLMap] Basemap tiles failed, falling back to OpenFreeMap: ${fallback}`);
    this.maplibreMap.setStyle(fallback);
    this.countryGeoJsonLoaded = false;
    this.maplibreMap.once('style.load', () => {
      localizeMapLabels(this.maplibreMap);
      this.loadCountryBoundaries();
      const paintTheme = isLightMapTheme(mapTheme) ? 'light' as const : 'dark' as const;
      this.updateCountryLayerPaint(paintTheme);
      this.render();
    });
  }

  public reloadBasemap(): void {
    if (!this.maplibreMap) return;
    const provider = getMapProvider();
    if (provider === 'pmtiles' || provider === 'auto') registerPMTilesProtocol();
    this.usedFallbackStyle = false;
    this.switchBasemap();
  }

  private updateCountryLayerPaint(theme: 'dark' | 'light'): void {
    if (!this.maplibreMap || !this.countryGeoJsonLoaded) return;
    const hoverOpacity = theme === 'light' ? 0.10 : 0.06;
    const highlightOpacity = theme === 'light' ? 0.18 : 0.12;
    try {
      this.maplibreMap.setPaintProperty('country-hover-fill', 'fill-opacity', hoverOpacity);
      this.maplibreMap.setPaintProperty('country-highlight-fill', 'fill-opacity', highlightOpacity);
    } catch { /* layers may not be ready */ }
  }

  public destroy(): void {
    window.removeEventListener('theme-changed', this.handleThemeChange);
    window.removeEventListener('map-theme-changed', this.handleMapThemeChange);
    this.debouncedRebuildLayers.cancel();
    this.debouncedFetchAircraft.cancel();
    this.rafUpdateLayers.cancel();

    if (this.renderRafId !== null) {
      cancelAnimationFrame(this.renderRafId);
      this.renderRafId = null;
    }

    if (this.moveTimeoutId) {
      clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = null;
    }

    if (this.styleLoadTimeoutId) {
      clearTimeout(this.styleLoadTimeoutId);
      this.styleLoadTimeoutId = null;
    }
    this.stopPulseAnimation();
    this.stopDayNightTimer();
    if (this.aircraftFetchTimer) {
      clearInterval(this.aircraftFetchTimer);
      this.aircraftFetchTimer = null;
    }


    this.layerCache.clear();

    this.deckOverlay?.finalize();
    this.deckOverlay = null;
    this.maplibreMap?.remove();
    this.maplibreMap = null;

    this.container.innerHTML = '';
  }
}
