import type { Monitor, PanelConfig, MapLayers } from '@/types';
import type { AppContext } from '@/app/app-context';
import {
  DEFAULT_PANELS,
  DEFAULT_MAP_LAYERS,
  MOBILE_DEFAULT_MAP_LAYERS,
  STORAGE_KEYS,
  SITE_VARIANT,
} from '@/config';
import { sanitizeLayersForVariant } from '@/config/map-layer-definitions';
import { initDB, cleanOldSnapshots } from '@/services';

import { subscribeAiFlowChange } from '@/services/ai-flow-settings';

import { loadFromStorage, parseMapUrlState, saveToStorage, isMobileDevice } from '@/utils';
import type { ParsedMapUrlState } from '@/utils';


import { trackEvent } from '@/services/analytics';
import { initI18n } from '@/services/i18n';

import { SearchManager } from '@/app/search-manager';
import { RefreshScheduler } from '@/app/refresh-scheduler';
import { PanelLayoutManager } from '@/app/panel-layout';
import { DataLoaderManager } from '@/app/data-loader';
import { EventHandlerManager } from '@/app/event-handlers';
import { resolveUserRegion, resolvePreciseUserCoordinates, type PreciseCoordinates } from '@/utils/user-location';




export class App {
  private state: AppContext;
  private panelLayout: PanelLayoutManager;
  private dataLoader: DataLoaderManager;
  private eventHandlers: EventHandlerManager;
  private searchManager: SearchManager;
  private refreshScheduler: RefreshScheduler;


  private modules: { destroy(): void }[] = [];
  private unsubAiFlow: (() => void) | null = null;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container ${containerId} not found`);

    const PANEL_ORDER_KEY = 'panel-order';
    const PANEL_SPANS_KEY = 'grid48-panel-spans';

    const isMobile = isMobileDevice();
    const monitors = loadFromStorage<Monitor[]>(STORAGE_KEYS.monitors, []);

    // Use mobile-specific defaults on first load (no saved layers)
    const defaultLayers = isMobile ? MOBILE_DEFAULT_MAP_LAYERS : DEFAULT_MAP_LAYERS;

    let mapLayers: MapLayers;
    let panelSettings: Record<string, PanelConfig>;

    // Check if variant changed - reset all settings to variant defaults
    const storedVariant = localStorage.getItem('grid48-variant');
    const currentVariant = SITE_VARIANT;
    console.log(`[App] Variant check: stored="${storedVariant}", current="${currentVariant}"`);
    if (storedVariant !== currentVariant) {
      // Variant changed - use defaults for new variant, clear old settings
      console.log('[App] Variant changed - resetting to defaults');
      localStorage.setItem('grid48-variant', currentVariant);
      localStorage.removeItem(STORAGE_KEYS.mapLayers);
      localStorage.removeItem(STORAGE_KEYS.panels);
      localStorage.removeItem(PANEL_ORDER_KEY);
      localStorage.removeItem(PANEL_ORDER_KEY + '-bottom');
      localStorage.removeItem(PANEL_ORDER_KEY + '-bottom-set');
      localStorage.removeItem(PANEL_SPANS_KEY);
      mapLayers = sanitizeLayersForVariant({ ...defaultLayers }, 'full');
      panelSettings = { ...DEFAULT_PANELS };
    } else {
      mapLayers = sanitizeLayersForVariant(
        loadFromStorage<MapLayers>(STORAGE_KEYS.mapLayers, defaultLayers),
        'full',
      );
      panelSettings = loadFromStorage<Record<string, PanelConfig>>(
        STORAGE_KEYS.panels,
        DEFAULT_PANELS
      );
      // Merge in any new panels that didn't exist when settings were saved
      for (const [key, config] of Object.entries(DEFAULT_PANELS)) {
        if (!(key in panelSettings)) {
          panelSettings[key] = { ...config };
        }
      }
      console.log('[App] Loaded panel settings from storage:', Object.entries(panelSettings).filter(([_, v]) => !v.enabled).map(([k]) => k));

      // One-time migration: reorder panels for existing users (v1.9 panel layout)
      const PANEL_ORDER_MIGRATION_KEY = 'grid48-panel-order-v1.9';
      if (!localStorage.getItem(PANEL_ORDER_MIGRATION_KEY)) {
        const savedOrder = localStorage.getItem(PANEL_ORDER_KEY);
        if (savedOrder) {
          try {
            const order: string[] = JSON.parse(savedOrder);
            const priorityPanels = ['cii'];
            const filtered = order.filter(k => !priorityPanels.includes(k) && k !== 'live-news');
            const liveNewsIdx = order.indexOf('live-news');
            const newOrder = liveNewsIdx !== -1 ? ['live-news'] : [];
            newOrder.push(...priorityPanels.filter(p => order.includes(p)));
            newOrder.push(...filtered);
            localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify(newOrder));
            console.log('[App] Migrated panel order to v1.9 layout');
          } catch {
            // Invalid saved order, will use defaults
          }
        }
        localStorage.setItem(PANEL_ORDER_MIGRATION_KEY, 'done');
      }
    }

    // One-time migration: prune removed panel keys from stored settings and order
    const PANEL_PRUNE_KEY = 'grid48-panel-prune-v1';
    if (!localStorage.getItem(PANEL_PRUNE_KEY)) {
      const validKeys = new Set(Object.keys(DEFAULT_PANELS));
      let pruned = false;
      for (const key of Object.keys(panelSettings)) {
        if (!validKeys.has(key) && key !== 'runtime-config') {
          delete panelSettings[key];
          pruned = true;
        }
      }
      if (pruned) saveToStorage(STORAGE_KEYS.panels, panelSettings);
      for (const orderKey of [PANEL_ORDER_KEY, PANEL_ORDER_KEY + '-bottom-set', PANEL_ORDER_KEY + '-bottom']) {
        try {
          const raw = localStorage.getItem(orderKey);
          if (!raw) continue;
          const arr = JSON.parse(raw);
          if (!Array.isArray(arr)) continue;
          const filtered = arr.filter((k: string) => validKeys.has(k));
          if (filtered.length !== arr.length) localStorage.setItem(orderKey, JSON.stringify(filtered));
        } catch { localStorage.removeItem(orderKey); }
      }
      localStorage.setItem(PANEL_PRUNE_KEY, 'done');
    }

    // One-time migration: clear stale panel ordering and sizing state
    const LAYOUT_RESET_MIGRATION_KEY = 'grid48-layout-reset-v2.5';
    if (!localStorage.getItem(LAYOUT_RESET_MIGRATION_KEY)) {
      const hadSavedOrder = !!localStorage.getItem(PANEL_ORDER_KEY);
      const hadSavedSpans = !!localStorage.getItem(PANEL_SPANS_KEY);
      if (hadSavedOrder || hadSavedSpans) {
        localStorage.removeItem(PANEL_ORDER_KEY);
        localStorage.removeItem(PANEL_ORDER_KEY + '-bottom');
        localStorage.removeItem(PANEL_ORDER_KEY + '-bottom-set');
        localStorage.removeItem(PANEL_SPANS_KEY);
        console.log('[App] Applied layout reset migration (v2.5): cleared panel order/spans');
      }
      localStorage.setItem(LAYOUT_RESET_MIGRATION_KEY, 'done');
    }

    let initialUrlState: ParsedMapUrlState | null = parseMapUrlState(window.location.search, mapLayers);
    if (initialUrlState.layers) {
      mapLayers = sanitizeLayersForVariant(initialUrlState.layers, 'full');
      initialUrlState.layers = mapLayers;
    }
    let disabledFeedsRaw = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
    if (!Array.isArray(disabledFeedsRaw)) {
      disabledFeedsRaw = [];
    }
    const disabledSources = new Set(disabledFeedsRaw);

    // Build shared state object
    this.state = {
      map: null,
      isMobile,
      container: el,
      panels: {},
      panelSettings,
      mapLayers,
      disabledSources,
      inFlight: new Set(),
      seenGeoAlerts: new Set(),
      monitors,
      unifiedSettings: null,

      isDestroyed: false,
      isPlaybackMode: false,
      isIdle: false,
      initialLoadComplete: false,
      resolvedLocation: 'global',
      initialUrlState,
      PANEL_ORDER_KEY,
      PANEL_SPANS_KEY,
    };

    // Instantiate modules (callbacks wired after all modules exist)
    this.refreshScheduler = new RefreshScheduler(this.state);


    this.dataLoader = new DataLoaderManager(this.state, {
      refreshOpenCountryBrief: () => {},
    });

    this.searchManager = new SearchManager(this.state, {});

    this.panelLayout = new PanelLayoutManager(this.state, {
      openCountryStory: () => {},
      openCountryBrief: () => {},
      loadAllData: () => this.dataLoader.loadAllData(),
    });

    this.eventHandlers = new EventHandlerManager(this.state, {
      updateSearchIndex: () => {}, // Grid 48 sem busca global
      loadAllData: () => this.dataLoader.loadAllData(),
      flushStaleRefreshes: () => this.refreshScheduler.flushStaleRefreshes(),
      setHiddenSince: (ts) => this.refreshScheduler.setHiddenSince(ts),
      loadDataForLayer: (layer) => { void this.dataLoader.loadDataForLayer(layer); },
      ensureCorrectZones: () => this.panelLayout.ensureCorrectZones(),
      refreshOpenCountryBrief: () => {},
      stopLayerActivity: (layer) => this.dataLoader.stopLayerActivity(layer),
    });

    // Track destroy order (reverse of init)
    this.modules = [
      this.panelLayout,
      this.searchManager,
      this.dataLoader,
      this.refreshScheduler,
      this.eventHandlers,
    ];
  }

  public async init(): Promise<void> {
    const initStart = performance.now();
    await initDB();
    await initI18n();


    this.unsubAiFlow = subscribeAiFlowChange((_key) => {
      // AI flow changes (browser ML removed)
    });






    const geoCoordsPromise: Promise<PreciseCoordinates | null> =
      this.state.isMobile && this.state.initialUrlState?.lat === undefined && this.state.initialUrlState?.lon === undefined
        ? resolvePreciseUserCoordinates(5000)
        : Promise.resolve(null);

    const resolvedRegion = await resolveUserRegion();
    this.state.resolvedLocation = resolvedRegion;

    // Phase 1: Layout (creates map + panels — they'll find hydrated data)
    this.panelLayout.init();


    const mobileGeoCoords = await geoCoordsPromise;
    if (mobileGeoCoords && this.state.map) {
      this.state.map.setCenter(mobileGeoCoords.lat, mobileGeoCoords.lon, 6);
    }



    // Phase 2: Shared UI components

    // Phase 3: UI setup methods (Grid 48 — sem PlaybackControl/StatusPanel/
    // Phase 3: UI setup methods do Grid 48)
    this.eventHandlers.startHeaderClock();
    this.eventHandlers.setupUnifiedSettings();

    // Phase 4: SearchManager, MapLayerHandlers
    this.searchManager.init();
    this.eventHandlers.setupMapLayerHandlers();

    // Phase 5: Event listeners + URL sync
    this.eventHandlers.init();
    this.eventHandlers.setupUrlStateSync();



    // Data Provider Adapter (Convex Cloud OR Local Engine).
    // Each init* returns a disposer; we register them as modules so App teardown
    // (variant switch, HMR, desktop close) cleans up intervals/sockets.
    import('@/adapters').then(async ({ getDataProvider }) => {
      const dataProvider = getDataProvider();

      const unsubCelesc = await dataProvider.initCelesc((outages) => {
        if (this.state.map) {
          this.state.map.setCelescOutages(outages);
        }
        const celescPanel = this.state.panels['celesc-status'] as import('@/components/CelescStatusWidget').CelescStatusWidget | undefined;
        if (celescPanel) {
          const lastUpdate = outages.length > 0 ? (outages[0]?.timestampLeitura ?? '') : '';
          celescPanel.setOutages(outages, lastUpdate);
        }
      });
      this.modules.push({ destroy: unsubCelesc });

      const unsubBeacon = await dataProvider.initBeacon((snapshot) => {
        if (this.state.map) {
           this.state.map.setBeaconAlerts(snapshot.alertas);
           // Telemetria LoRa → layer de nós no mapa (mesmo fanout do snapshot).
           this.state.map.setTelemetry(snapshot.telemetria);
           // Histórico → trilha + heatmap por hop.
           this.state.map.setTelemetryTrack(snapshot.telemetriaTrack);
        }
        const setBeaconPanel = () => {
          const beaconPanel = this.state.panels['beacon-status'] as any;
          if (beaconPanel && typeof beaconPanel.setSnapshot === 'function') {
            beaconPanel.setSnapshot(snapshot);
            return true;
          }
          return false;
        };
        if (!setBeaconPanel()) {
           const retry = setInterval(() => { if (setBeaconPanel()) clearInterval(retry); }, 500);
        }
        // Fanout pro DefconWidget — mesmo snapshot, painel diferente. Dynamic
        // import roda async, então o painel pode não estar registrado ainda
        // no primeiro tick; usamos o mesmo padrão de retry do beacon.
        const setDefconPanel = () => {
          const defconPanel = this.state.panels['defcon'] as any;
          if (defconPanel && typeof defconPanel.setSnapshot === 'function') {
            defconPanel.setSnapshot(snapshot);
            return true;
          }
          return false;
        };
        if (!setDefconPanel()) {
           const retryDefcon = setInterval(() => { if (setDefconPanel()) clearInterval(retryDefcon); }, 500);
        }
        // Fanout pro ClimaWidget (snapshot.clima vem populado por
        // clima/queries:getMeteorologiaState via beacon-client). Mesmo
        // pattern de retry porque ClimaWidget é dynamic-imported.
        const setClimaPanel = () => {
          const climaPanel = this.state.panels['clima'] as any;
          if (climaPanel && typeof climaPanel.setSnapshot === 'function') {
            climaPanel.setSnapshot(snapshot);
            return true;
          }
          return false;
        };
        if (!setClimaPanel()) {
           const retryClima = setInterval(() => { if (setClimaPanel()) clearInterval(retryClima); }, 500);
        }
        // Fanout pro TrafegoWidget (snapshot.trafego de trafego/queries:getTrafegoState).
        const setTrafegoPanel = () => {
          const trafegoPanel = this.state.panels['trafego'] as any;
          if (trafegoPanel && typeof trafegoPanel.setSnapshot === 'function') {
            trafegoPanel.setSnapshot(snapshot);
            return true;
          }
          return false;
        };
        if (!setTrafegoPanel()) {
           const retryTrafego = setInterval(() => { if (setTrafegoPanel()) clearInterval(retryTrafego); }, 500);
        }
        // Fanout pro HealthWidget (Comando & Controle) — usa snapshot.telemetria
        // pra renderizar o status dos nós LoRa (sinal/bateria/hops + rótulo).
        const setHealthPanel = () => {
          const healthPanel = this.state.panels['engine-health'] as any;
          if (healthPanel && typeof healthPanel.setSnapshot === 'function') {
            healthPanel.setSnapshot(snapshot);
            return true;
          }
          return false;
        };
        if (!setHealthPanel()) {
           const retryHealth = setInterval(() => { if (setHealthPanel()) clearInterval(retryHealth); }, 500);
        }
      });
      this.modules.push({ destroy: unsubBeacon });

      const unsubTelemetry = await dataProvider.initTelemetry((data) => {
        console.log('[App] Telemetry updated', data.length, 'records');
        // Will be routed to a specific map layer in the future
      });
      this.modules.push({ destroy: unsubTelemetry });
    }).catch((err) => {
      console.error('[App] Adapter initialization failed:', err);
    });


    // Start deep link handling early — its retry loop polls hasSufficientData()
    // independently, so it must not be gated behind loadAllData() which can hang.
    this.handleDeepLinks();

    // Phase 6: Data loading
    await this.dataLoader.loadAllData();






    // Phase 7: Refresh scheduling
    this.setupRefreshIntervals();
    cleanOldSnapshots().catch((e) => console.warn('[Storage] Snapshot cleanup failed:', e));



    // Analytics
    trackEvent('wm_app_loaded', {
      load_time_ms: Math.round(performance.now() - initStart),
      panel_count: Object.keys(this.state.panels).length,
    });
    this.eventHandlers.setupPanelViewTracking();
  }

  public destroy(): void {
    this.state.isDestroyed = true;

    // Destroy all modules in reverse order
    for (let i = this.modules.length - 1; i >= 0; i--) {
      this.modules[i]!.destroy();
    }

    // Clean up subscriptions + map
    this.unsubAiFlow?.();
    this.state.map?.destroy();
  }

  private handleDeepLinks(): void {
    // Legacy country intel links removed
  }

  private setupRefreshIntervals(): void {
    // Grid 48: dados vêm via DataProvider (Convex). Sem refresh intervals
    // client-side (dados vêm via DataProvider/Convex).
    this.refreshScheduler.registerAll([]);
  }
}
