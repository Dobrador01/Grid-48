// ═══════════════════════════════════════════════════════════════════════════
// Map — renderer único do mapa Grid 48 (deck.gl + maplibre)
// ═══════════════════════════════════════════════════════════════════════════
//
// Reescrito do zero em 2026-05-24 pra substituir os 13.724 linhas legacy do
// WorldMonitor (Map.ts SVG fallback + DeckGLMap + MapContainer + GlobeMap +
// MapPopup). Tudo que Grid 48 USA está aqui em ~500 linhas.
//
// Renderiza:
//   1. Basemap (PMTiles via maplibre, com fallback OpenFreeMap/CARTO)
//   2. Layer Celesc — polígonos dos municípios SC coloridos por %UCs offline
//   3. Layer Weather Alerts — marcadores de alertas Defesa Civil
//      (centroide do município afetado, tamanho/cor por nivel_risco)
//
// Interage com:
//   - CelescStatusWidget click → window event 'CELESC_CITY_SELECTED'
//     → flyTo + tooltip central com lista de bairros afetados
//   - BeaconStatusWidget click → mesmo event (payload mínimo { codIbge })
//   - Theme dashboard change → 'theme-changed' window event
//     → swap basemap pra dark/light correspondente (auto sync)
//   - Map theme manual change → 'map-theme-changed' window event
//     → reload basemap com novo style
//
// API pública chamada por core:
//   setCelescOutages, setBeaconAlerts, setView, setCenter, setZoom,
//   setLayers, setLayerLoading, setIsResizing, onStateChanged,
//   setOnLayerChange, reloadBasemap, destroy
//
// Stubs no-op pra retro-compat (chamadas remanescentes de data-loader que
// será limpo em fase próxima): setClimateAnomalies, setCIIScores,
// setFlightDelays, setHotspotLevels, setOnAircraftPositionsUpdate,
// initEscalationGetters
// ═══════════════════════════════════════════════════════════════════════════

import maplibregl from 'maplibre-gl';
import { GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import {
  registerPMTilesProtocol,
  getMapProvider,
  getStyleForProvider,
  isLightMapTheme,
  setMapTheme,
  FALLBACK_DARK_STYLE,
  FALLBACK_LIGHT_STYLE,
  type MapProvider,
} from '@/config/basemap';
import { getCurrentTheme } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import type { CelescMunicipioPayload } from '@/types/celesc';
import type { MapLayers } from '@/types';
import type { BeaconAlert } from '@/services/beacon-client';

// Centro de Florianópolis / São José
const SJF_CENTER: [number, number] = [-48.5495, -27.5969];
const SJF_ZOOM = 12;

// URL da malha IBGE-SC (290 municípios). Hosted no GitHub público —
// poderíamos self-host em public/data/ no futuro pra eliminar dependência.
const IBGE_SC_GEOJSON_URL =
  'https://raw.githubusercontent.com/tbrugz/geodata-br/master/geojson/geojs-42-mun.json';

export type MapView = 'sjf' | 'global';

// Re-export pra retro-compat com callers (ex.: search-manager) que
// importavam MapLayers de '@/components/Map' antes do cleanup.
export type { MapLayers };

export interface MapContainerState {
  zoom: number;
  pan: { x: number; y: number };
  view: MapView;
  layers: MapLayers;
}

export type LayerChangeSource = 'user' | 'programmatic';
export type LayerChangeHandler = (
  layer: keyof MapLayers,
  enabled: boolean,
  source: LayerChangeSource,
) => void;
export type StateChangeHandler = (state: MapContainerState) => void;

interface BeaconMarker {
  position: [number, number];
  titulo: string;
  risco: string;
}

// ── Stub legacy types (callers ainda existem em data-loader/event-handlers,
//    serão removidos em fase próxima) ──
type ClimateAnomaly = unknown;
type AirportDelayAlert = unknown;
type CIIScoreLite = unknown;
type HotspotLevels = unknown;
type AircraftPositionHandler = (positions: unknown) => void;
type CountryClickPayload = unknown;
type CountryClickHandler = (payload: CountryClickPayload) => void;
type HotspotClickHandler = (payload: unknown) => void;

export class MapComponent {
  private map: maplibregl.Map;
  private overlay: MapboxOverlay;
  private container: HTMLElement;
  private scGeojson: GeoJSON.FeatureCollection | null = null;
  private celescLookup = new Map<string, CelescMunicipioPayload>();
  private beaconAlerts: BeaconAlert[] = [];
  private state: MapContainerState;
  private isResizing = false;
  private layerLoading = new Set<string>();

  private stateChangeCb: StateChangeHandler | null = null;
  // Reservado pra setOnLayerChange — Grid 48 ainda não emite layer change
  // events do próprio Map (toggle vem da UI). Mantido pra retro-compat com
  // event-handlers.setupMapLayerHandlers que registra um callback.
  private layerChangeCb: LayerChangeHandler | null = null;
  private renderPaused = false;

  private boundThemeHandler: () => void;
  private boundMapThemeHandler: () => void;
  private boundCelescFocusHandler: (e: Event) => void;

  constructor(container: HTMLElement, initialState: MapContainerState) {
    this.container = container;
    this.state = initialState;

    registerPMTilesProtocol();

    const provider = getMapProvider();
    const theme = this.themeMatchingDashboard(provider);
    const style = getStyleForProvider(provider, theme);

    this.map = new maplibregl.Map({
      container,
      style: typeof style === 'string' ? style : (style as maplibregl.StyleSpecification),
      center: SJF_CENTER,
      zoom: SJF_ZOOM,
      attributionControl: { compact: true },
    });

    // Controles standard
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    // Overlay deck.gl
    this.overlay = new MapboxOverlay({ layers: [] });
    this.map.addControl(this.overlay as unknown as maplibregl.IControl);

    // Eventos de viewport (state sync com URL)
    this.map.on('moveend', () => this.emitStateChange());
    this.map.on('zoomend', () => this.emitStateChange());

    // Tema dashboard ↔ map: quando dashboard troca dark/light, troca theme
    // do map pra preservar consistência visual. Override manual (settings UI)
    // continua respeitado via 'map-theme-changed'.
    this.boundThemeHandler = () => this.syncThemeWithDashboard();
    window.addEventListener('theme-changed', this.boundThemeHandler);

    this.boundMapThemeHandler = () => this.reloadBasemap();
    window.addEventListener('map-theme-changed', this.boundMapThemeHandler);

    // Celesc/Beacon widget click → flyTo + tooltip central
    this.boundCelescFocusHandler = (e: Event) => this.handleCityFocus(e);
    window.addEventListener('CELESC_CITY_SELECTED', this.boundCelescFocusHandler);

    // Carrega malha IBGE-SC assincronamente
    this.loadScGeojson();

    // Bootstrap layers
    this.map.on('load', () => this.rebuildLayers());

    // UI overlay: toggles de layers (CSS vem do main.css legacy
    // `.deckgl-layer-toggles`).
    this.createLayerTogglesPanel();

    // Resize observer pra ResizeObserver de container
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (this.isResizing) return;
        this.map.resize();
      });
      ro.observe(container);
    }
  }

  // ── Public API consumido por App / event-handlers / data-loader ─────────

  public setCelescOutages(data: CelescMunicipioPayload[]): void {
    this.celescLookup = new Map(data.map((c) => [String((c as { codIbge: number | string }).codIbge), c]));
    // Cache global usado por algumas integrações que ainda fazem
    // `window.__CELESC_GLOBAL_DATA__` lookup
    (window as unknown as Record<string, unknown>).__CELESC_GLOBAL_DATA__ = data;
    this.rebuildLayers();
  }

  public setBeaconAlerts(alertas: BeaconAlert[]): void {
    this.beaconAlerts = alertas ?? [];
    this.rebuildLayers();
  }

  public setView(view: MapView): void {
    this.state.view = view;
    if (view === 'sjf') {
      this.map.flyTo({ center: SJF_CENTER, zoom: SJF_ZOOM, essential: true });
    } else if (view === 'global') {
      this.map.flyTo({ center: [0, 0], zoom: 1.5, essential: true });
    }
  }

  public getState(): MapContainerState {
    return {
      zoom: this.map.getZoom(),
      pan: { x: this.map.getCenter().lng, y: this.map.getCenter().lat },
      view: this.state.view,
      layers: this.state.layers,
    };
  }

  public getCenter(): { lat: number; lon: number } {
    const c = this.map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  public setCenter(lat: number, lon: number, zoom?: number): void {
    this.map.flyTo({
      center: [lon, lat],
      zoom: zoom ?? this.map.getZoom(),
      essential: true,
    });
  }

  public setZoom(zoom: number): void {
    this.map.zoomTo(zoom);
  }

  public setLayers(layers: MapLayers): void {
    this.state.layers = layers;
    this.rebuildLayers();
  }

  public setLayerLoading(layer: string, loading: boolean): void {
    if (loading) this.layerLoading.add(layer);
    else this.layerLoading.delete(layer);
    // Hook visual futuro — por enquanto só rastreia state
  }

  public setIsResizing(b: boolean): void {
    this.isResizing = b;
    if (!b) this.map.resize();
  }

  public resize(): void {
    this.map.resize();
  }

  public onStateChanged(cb: StateChangeHandler): void {
    this.stateChangeCb = cb;
  }

  public setOnLayerChange(cb: LayerChangeHandler): void {
    this.layerChangeCb = cb;
  }

  public reloadBasemap(): void {
    const provider = getMapProvider();
    const theme = this.themeMatchingDashboard(provider);
    const style = getStyleForProvider(provider, theme);
    if (typeof style === 'string') {
      this.map.setStyle(style);
    } else {
      this.map.setStyle(style as maplibregl.StyleSpecification);
    }
    // Após setStyle, layers customizadas são limpas — rebuild após reload
    this.map.once('styledata', () => this.rebuildLayers());
  }

  public destroy(): void {
    window.removeEventListener('theme-changed', this.boundThemeHandler);
    window.removeEventListener('map-theme-changed', this.boundMapThemeHandler);
    window.removeEventListener('CELESC_CITY_SELECTED', this.boundCelescFocusHandler);
    this.clearSelectedTooltip();
    this.map.remove();
  }

  public render(): void {
    this.rebuildLayers();
  }

  public setRenderPaused(paused: boolean): void {
    this.renderPaused = paused;
  }

  // ── Stubs no-op (callers worldmonitor remanescentes) ───────────────────
  // Esses métodos eram da MapContainer legacy. Mantemos como no-ops pra
  // não quebrar callers (data-loader, event-handlers) durante a migração.
  // Próxima fase limpa esses callers e remove os stubs.

  public setClimateAnomalies(_anomalies: ClimateAnomaly[]): void { /* no-op */ }
  public setCIIScores(_scores: CIIScoreLite[]): void { /* no-op */ }
  public setFlightDelays(_delays: AirportDelayAlert[]): void { /* no-op */ }
  public setHotspotLevels(_levels: HotspotLevels): void { /* no-op */ }
  public setOnAircraftPositionsUpdate(_cb: AircraftPositionHandler): void { /* no-op */ }
  public initEscalationGetters(): void { /* no-op */ }
  public onCountryClicked(_cb: CountryClickHandler): void { /* no-op */ }
  public onHotspotClicked(_cb: HotspotClickHandler): void { /* no-op */ }

  // ── UI overlay: toggles de layers ───────────────────────────────────────


  /**
   * Caixa flutuante (top-right do mapa) com checkboxes pras 2 layers Grid 48.
   * Click no checkbox → atualiza state.layers + rebuildLayers + emite
   * layerChangeCb (consumido por event-handlers pra persistir em localStorage
   * e sync URL).
   */
  private createLayerTogglesPanel(): void {
    const panel = document.createElement('div');
    panel.className = 'layer-toggles deckgl-layer-toggles grid48-layer-toggles';
    panel.innerHTML = `
      <div class="toggle-header">
        <span>Camadas</span>
        <button class="toggle-collapse" type="button" aria-label="Recolher">▼</button>
      </div>
      <div class="toggle-list">
        <label class="layer-toggle" data-layer="celescOutages">
          <input type="checkbox" ${this.state.layers.celescOutages ? 'checked' : ''}>
          <span class="toggle-icon">⚡</span>
          <span class="toggle-label">Celesc (Rede Elétrica)</span>
        </label>
        <label class="layer-toggle" data-layer="weatherAlerts">
          <input type="checkbox" ${this.state.layers.weatherAlerts ? 'checked' : ''}>
          <span class="toggle-icon">⛈</span>
          <span class="toggle-label">Alertas Meteorológicos</span>
        </label>
      </div>
    `;
    this.container.appendChild(panel);

    panel.querySelectorAll<HTMLInputElement>('.layer-toggle input').forEach((input) => {
      input.addEventListener('change', () => {
        const layerEl = input.closest<HTMLElement>('.layer-toggle');
        const key = layerEl?.dataset.layer as keyof MapLayers | undefined;
        if (!key) return;
        const enabled = input.checked;
        this.state.layers[key] = enabled;
        this.rebuildLayers();
        if (this.layerChangeCb) this.layerChangeCb(key, enabled, 'user');
      });
    });

    // Wheel scroll dentro do panel sem zoom no map
    panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    // Collapse toggle
    const collapseBtn = panel.querySelector<HTMLButtonElement>('.toggle-collapse');
    const list = panel.querySelector<HTMLElement>('.toggle-list');
    collapseBtn?.addEventListener('click', () => {
      if (!list) return;
      const collapsed = list.classList.toggle('collapsed');
      if (collapseBtn) collapseBtn.textContent = collapsed ? '▶' : '▼';
    });
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  /**
   * Tema do mapa = dashboard. Se dashboard tá dark → mapa dark; light → light.
   * Override manual da settings UI tem prioridade quando o user já escolheu
   * algo explicitamente (gravado em localStorage via setMapTheme).
   */
  private themeMatchingDashboard(provider: MapProvider): string {
    const stored = localStorage.getItem(`wm-map-theme:${provider}`);
    if (stored) return stored; // user override

    const dashboardDark = getCurrentTheme() === 'dark';
    // Mapeamento dashboard→map theme por provider
    if (provider === 'pmtiles' || provider === 'auto') return dashboardDark ? 'dark' : 'light';
    if (provider === 'openfreemap') return dashboardDark ? 'dark' : 'positron';
    if (provider === 'carto') return dashboardDark ? 'dark-matter' : 'positron';
    return dashboardDark ? 'dark' : 'light';
  }

  /**
   * Disparado quando dashboard troca tema (header toggle ou settings).
   * Só troca o map theme se NÃO houver override manual setado pelo user.
   */
  private syncThemeWithDashboard(): void {
    const provider = getMapProvider();
    const dashboardDark = getCurrentTheme() === 'dark';
    const target =
      provider === 'pmtiles' || provider === 'auto'
        ? (dashboardDark ? 'dark' : 'light')
        : provider === 'openfreemap'
        ? (dashboardDark ? 'dark' : 'positron')
        : (dashboardDark ? 'dark-matter' : 'positron');

    // Force-set o tema (overwrite override). Decisão de produto:
    // sync com dashboard sempre vence — settings UI continua existindo
    // mas vira mais "override temporário" do que persistência.
    setMapTheme(provider, target);
    this.reloadBasemap();
  }

  private async loadScGeojson(): Promise<void> {
    try {
      const res = await fetch(IBGE_SC_GEOJSON_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.scGeojson = (await res.json()) as GeoJSON.FeatureCollection;
      this.rebuildLayers();
    } catch (e) {
      console.warn('[Map] Falha carregando malha IBGE-SC:', e);
    }
  }

  private rebuildLayers(): void {
    if (this.renderPaused) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layers: any[] = [];
    // Suprime warning de layerChangeCb não lido — fica reservado pra futuras
    // emissões (toggle de layer dentro do próprio Map em vez de UI externa).
    void this.layerChangeCb;

    // Layer Celesc
    if (this.scGeojson && this.state.layers.celescOutages) {
      layers.push(
        new GeoJsonLayer({
          id: 'sc-municipios',
          data: this.scGeojson,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 80] as [number, number, number, number],
          getFillColor: (feature: unknown) => this.celescColorForFeature(feature),
          getLineColor: [255, 255, 255, 40] as [number, number, number, number],
          lineWidthMinPixels: 0.5,
          updateTriggers: { getFillColor: [this.celescLookup.size, Date.now()] },
        }),
      );
    }

    // Layer Weather Alerts (Beacon Defesa Civil) — centroide do município afetado
    if (
      this.scGeojson &&
      this.state.layers.weatherAlerts &&
      this.beaconAlerts.length > 0
    ) {
      const pts = this.computeBeaconMarkers();
      if (pts.length > 0) {
        layers.push(
          new ScatterplotLayer({
            id: 'weather-alerts',
            data: pts,
            getPosition: (d: BeaconMarker) => d.position,
            getRadius: (d: BeaconMarker) =>
              d.risco === 'Alto' ? 12000 : d.risco === 'Medio' ? 8000 : 5000,
            getFillColor: (d: BeaconMarker) =>
              d.risco === 'Alto'
                ? [255, 0, 0, 200]
                : d.risco === 'Medio'
                ? [255, 165, 0, 180]
                : [255, 255, 0, 180],
            stroked: true,
            getLineColor: [255, 255, 255] as [number, number, number],
            lineWidthMinPixels: 2,
            opacity: 0.85,
            pickable: true,
            onHover: (info: { object?: BeaconMarker; x: number; y: number }) =>
              this.handleBeaconHover(info),
            updateTriggers: { getFillColor: [pts.length] },
          }),
        );
      }
    }

    this.overlay.setProps({ layers });
  }

  /**
   * Cor de preenchimento do polígono municipal Celesc por % UCs offline.
   * Preserva escala exata do legacy.
   */
  private celescColorForFeature(feature: unknown): [number, number, number, number] {
    const props = (feature as { properties?: { id?: string | number } }).properties;
    if (!props?.id) return [60, 60, 60, 40];
    const cidade = this.celescLookup.get(String(props.id));
    if (!cidade || typeof cidade.pct !== 'number' || cidade.pct === 0) return [60, 60, 60, 40];
    if (cidade.pct >= 50) return [255, 0, 0, 200];
    if (cidade.pct >= 20) return [255, 140, 0, 200];
    if (cidade.pct >= 5) return [255, 204, 0, 200];
    return [0, 200, 0, 150];
  }

  /**
   * Calcula centroides dos municípios afetados pra cada alerta beacon.
   * 1 alerta cobrindo N cidades = N markers, todos com mesmo titulo/risco.
   */
  private computeBeaconMarkers(): BeaconMarker[] {
    if (!this.scGeojson) return [];
    const features = (this.scGeojson.features ?? []) as GeoJSON.Feature[];
    const out: BeaconMarker[] = [];
    for (const al of this.beaconAlerts) {
      for (const ibge of al.cidades_afetadas_ibge) {
        const f = features.find(
          (feat) => String((feat.properties as { id?: number | string } | null)?.id) === String(ibge),
        );
        if (!f?.geometry) continue;
        const centroid = this.featureCentroid(f);
        if (!centroid) continue;
        out.push({ position: centroid, titulo: al.titulo, risco: al.nivel_risco });
      }
    }
    return out;
  }

  private featureCentroid(feature: GeoJSON.Feature): [number, number] | null {
    const geom = feature.geometry as { coordinates?: number[][][] | number[][][][] };
    if (!geom?.coordinates) return null;
    const flat = (geom.coordinates as unknown[]).flat(Infinity) as number[];
    if (flat.length < 4) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i]!;
      const y = flat[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return [(minX + maxX) / 2, (minY + maxY) / 2];
  }

  /**
   * Click num widget Celesc/Beacon → flyTo município + tooltip central
   * com lista de bairros. Payload pode ser CelescMunicipioPayload completo
   * (CelescStatusWidget) ou só { codIbge } (BeaconStatusWidget — nesse caso
   * faz lookup no celescLookup pra enriquecer).
   */
  private handleCityFocus(event: Event): void {
    const detail = (event as CustomEvent).detail;
    let cidade: CelescMunicipioPayload | null = null;
    try {
      cidade = typeof detail === 'string' ? JSON.parse(detail) : detail;
    } catch (e) {
      console.warn('[Map] handleCityFocus: detail malformado:', e);
      return;
    }
    if (!cidade || !(cidade as { codIbge?: number | string }).codIbge) return;

    const features = this.scGeojson?.features ?? [];
    const feature = features.find(
      (f) => String((f.properties as { id?: number | string } | null)?.id) === String(cidade!.codIbge),
    );
    if (!feature?.geometry) {
      console.warn('[Map] Geometria IBGE não encontrada para', (cidade as { codIbge: number | string }).codIbge);
      return;
    }

    const centroid = this.featureCentroid(feature);
    if (!centroid) return;

    this.map.flyTo({ center: centroid, zoom: 11.5, speed: 1.2, essential: true });

    // Enriquece se payload veio só com codIbge (do BeaconWidget)
    const enriched = (cidade as { bairros?: unknown[] }).bairros
      ? cidade
      : this.celescLookup.get(String((cidade as { codIbge: number | string }).codIbge)) ?? cidade;

    this.setSelectedTooltip(enriched);
  }

  private handleBeaconHover(info: { object?: BeaconMarker; x: number; y: number }): void {
    const tt = this.getOrCreateHoverTooltip();
    if (!info.object) {
      this.hideHoverTooltip();
      return;
    }
    const { titulo, risco } = info.object;
    const color = risco === 'Alto' ? '#ef4444' : risco === 'Medio' ? '#f97316' : '#eab308';
    tt.style.left = `${info.x}px`;
    tt.style.top = `${info.y}px`;
    tt.style.display = 'block';
    tt.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;background-color:${color};color:white;padding:2px 6px;border-radius:4px;font-weight:bold;margin-bottom:8px;font-size:0.65rem;">${escapeHtml(risco)}</div>
      <div style="font-size:0.8rem;font-weight:600;">${escapeHtml(titulo)}</div>
    `;
  }

  private getOrCreateHoverTooltip(): HTMLElement {
    let tt = document.getElementById('grid48-map-hover-tooltip');
    if (!tt) {
      tt = document.createElement('div');
      tt.id = 'grid48-map-hover-tooltip';
      tt.style.cssText =
        'position:absolute;background-color:rgba(0,0,0,0.9);border:1px solid #374151;padding:0.5rem 0.75rem;border-radius:0.25rem;color:#fff;font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.75rem;z-index:50;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);pointer-events:none;min-width:200px;transform:translate(-50%,-100%) translateY(-20px);display:none;';
      this.container.appendChild(tt);
    }
    return tt;
  }

  private hideHoverTooltip(): void {
    const tt = document.getElementById('grid48-map-hover-tooltip');
    if (tt) tt.style.display = 'none';
  }

  /**
   * Tooltip central forçado com nome cidade + % + lista de bairros.
   * Permanece até user clicar em outra cidade ou setSelectedTooltip(null).
   */
  private setSelectedTooltip(cidade: CelescMunicipioPayload | null): void {
    if (!cidade) {
      this.clearSelectedTooltip();
      return;
    }
    let tt = document.getElementById('grid48-map-selected-tooltip');
    if (!tt) {
      tt = document.createElement('div');
      tt.id = 'grid48-map-selected-tooltip';
      tt.style.cssText =
        'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background-color:rgba(0,0,0,0.9);border:1px solid #374151;padding:1rem;border-radius:0.5rem;color:#fff;font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.75rem;z-index:50;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);pointer-events:auto;min-width:250px;max-width:320px;';
      this.container.appendChild(tt);

      // Click no tooltip fecha
      tt.addEventListener('click', () => this.clearSelectedTooltip());
    }

    const c = cidade as {
      nome?: string;
      pct?: number;
      ucsAfetadas?: number;
      bairros?: Array<{ nome: string; ucsAfetadas: number }>;
    };
    const pctFmt =
      typeof c.pct === 'number'
        ? (c.pct % 1 === 0 ? String(c.pct) : c.pct.toFixed(2))
        : '?';
    const bairrosHtml =
      c.bairros && c.bairros.length > 0
        ? c.bairros
            .map(
              (b) => `
              <div style="display:flex;justify-content:space-between;border-bottom:1px solid #1f2937;padding:0.25rem 0;">
                <span style="color:#9ca3af;">${escapeHtml(b.nome)}</span>
                <span style="color:#fca5a5;margin-left:1rem;">${b.ucsAfetadas}</span>
              </div>`,
            )
            .join('')
        : '<div style="color:#9ca3af;padding:0.25rem 0;">Sem UCs afetadas por bairro</div>';

    tt.innerHTML = `
      <h3 style="color:#f87171;font-weight:700;margin:0 0 0.5rem 0;font-size:1rem;">${escapeHtml(c.nome ?? '?')} — ${pctFmt}% OFF</h3>
      <p style="margin:0 0 0.5rem 0;font-size:0.875rem;">Total: ${c.ucsAfetadas ?? 0} UCs Offline</p>
      <div style="max-height:8rem;overflow-y:auto;padding-right:0.25rem;margin-top:0.5rem;">
        ${bairrosHtml}
      </div>
      <div style="font-size:0.6rem;color:#9ca3af;margin-top:0.5rem;text-align:right;">clique pra fechar</div>
    `;
  }

  private clearSelectedTooltip(): void {
    const tt = document.getElementById('grid48-map-selected-tooltip');
    if (tt && tt.parentNode) tt.parentNode.removeChild(tt);
  }

  private emitStateChange(): void {
    if (!this.stateChangeCb) return;
    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    this.stateChangeCb({
      zoom,
      pan: { x: center.lng, y: center.lat },
      view: this.state.view,
      layers: this.state.layers,
    });
  }
}

// Fallback exports pra compatibilidade com referências antigas ao tipo
// MapContainer / MapView / MapContainerState que ainda podem existir
// em outros arquivos durante a migração.
export { MapComponent as MapContainer };

// Helpers para callers que ainda usam FALLBACK_DARK_STYLE/LIGHT_STYLE via
// re-export — não mais necessário aqui, mantido pra retro-compat.
export { isLightMapTheme, FALLBACK_DARK_STYLE, FALLBACK_LIGHT_STYLE };
