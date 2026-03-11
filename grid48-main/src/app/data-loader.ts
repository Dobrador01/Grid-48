import type { AppContext, AppModule } from '@/app/app-context';
import { enqueuePanelCall } from '@/app/pending-panel-data';
import type { NewsItem, MapLayers, SocialUnrestEvent } from '@/types';

import type { TimeRange } from '@/components';
import {
  FEEDS,
  INTEL_SOURCES,
  LAYER_TO_SOURCE,
  SITE_VARIANT,
} from '@/config';
import { INTEL_HOTSPOTS, CONFLICT_ZONES } from '@/config/geo';
import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';
import {
  fetchCategoryFeeds,
  getFeedFailures,
  fetchFredData,
  fetchInternetOutages,
  isOutagesConfigured,
  fetchAisSignals,
  getAisStatus,
  isAisConfigured,
  fetchCableActivity,
  fetchCableHealth,
  fetchProtestEvents,
  getProtestStatus,
  fetchFlightDelays,
  fetchMilitaryFlights,
  fetchMilitaryVessels,
  initMilitaryVesselStream,
  isMilitaryVesselTrackingConfigured,
  fetchUSNIFleetReport,
  updateBaseline,
  calculateDeviation,
  addToSignalHistory,
  analysisWorker,
  fetchCyberThreats,
  drainTrendingSignals,
} from '@/services';
import { checkBatchForBreakingAlerts, dispatchOrefBreakingAlert } from '@/services/breaking-news-alerts';
import { mlWorker } from '@/services/ml-worker';
import { clusterNewsHybrid } from '@/services/clustering';
import { signalAggregator } from '@/services/signal-aggregator';
import { updateAndCheck, consumeServerAnomalies } from '@/services/temporal-baseline';
import { analyzeFlightsForSurge, surgeAlertToSignal, detectForeignMilitaryPresence, foreignPresenceToSignal, type TheaterPostureSummary } from '@/services/military-surge';
import { fetchCachedTheaterPosture } from '@/services/cached-theater-posture';
import { ingestMilitaryForCII, ingestNewsForCII, ingestOutagesForCII, ingestConflictsForCII, ingestHapiForCII, ingestDisplacementForCII, ingestClimateForCII, ingestStrikesForCII, ingestAviationForCII, ingestGpsJammingForCII, ingestAisDisruptionsForCII, ingestCyberThreatsForCII, ingestTemporalAnomaliesForCII, isInLearningMode, resetHotspotActivity, setIntelligenceSignalsLoaded, hasAnyIntelligenceData, calculateCII } from '@/services/country-instability';
import { fetchGpsInterference } from '@/services/gps-interference';
import { fetchSatelliteTLEs, initSatRecs, propagatePositions, startPropagationLoop } from '@/services/satellites';
import type { SatRecEntry } from '@/services/satellites';
import { dataFreshness, type DataSourceId } from '@/services/data-freshness';
import { fetchConflictEvents, fetchHapiSummary, fetchIranEvents } from '@/services/conflict';
import { fetchUnhcrPopulation } from '@/services/displacement';
import { fetchClimateAnomalies } from '@/services/climate';
import { fetchOrefAlerts, startOrefPolling, stopOrefPolling, onOrefAlertsUpdate } from '@/services/oref-alerts';
import { enrichEventsWithExposure } from '@/services/population-exposure';
import { debounce } from '@/utils';
import { isFeatureAvailable, isFeatureEnabled } from '@/services/runtime-config';
import { isDesktopRuntime } from '@/services/runtime';
import { getAiFlowSettings } from '@/services/ai-flow-settings';
import { t, getCurrentLanguage } from '@/services/i18n';
import { canQueueAiClassification, AI_CLASSIFY_MAX_PER_FEED } from '@/services/ai-classify-queue';
import { classifyWithAI } from '@/services/threat-classifier';
import { ingestHeadlines } from '@/services/trending-keywords';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import { mountCommunityWidget } from '@/components/CommunityWidget';
import type { ThreatLevel as ClientThreatLevel } from '@/services/threat-classifier';
import type { NewsItem as ProtoNewsItem, ThreatLevel as ProtoThreatLevel } from '@/generated/client/worldmonitor/news/v1/service_client';

const PROTO_TO_CLIENT_LEVEL: Record<ProtoThreatLevel, ClientThreatLevel> = {
  THREAT_LEVEL_UNSPECIFIED: 'info',
  THREAT_LEVEL_LOW: 'low',
  THREAT_LEVEL_MEDIUM: 'medium',
  THREAT_LEVEL_HIGH: 'high',
  THREAT_LEVEL_CRITICAL: 'critical',
};

function protoItemToNewsItem(p: ProtoNewsItem): NewsItem {
  const level = PROTO_TO_CLIENT_LEVEL[p.threat?.level ?? 'THREAT_LEVEL_UNSPECIFIED'];
  return {
    source: p.source,
    title: p.title,
    link: p.link,
    pubDate: new Date(p.publishedAt),
    isAlert: p.isAlert,
    threat: p.threat ? {
      level,
      category: p.threat.category as import('@/services/threat-classifier').EventCategory,
      confidence: p.threat.confidence,
      source: (p.threat.source || 'keyword') as 'keyword' | 'ml' | 'llm',
    } : undefined,
    ...(p.locationName && { locationName: p.locationName }),
    ...(p.location && { lat: p.location.latitude, lon: p.location.longitude }),
  };
}

const CYBER_LAYER_ENABLED = import.meta.env.VITE_ENABLE_CYBER_LAYER === 'true';

export interface DataLoaderCallbacks {
  renderCriticalBanner: (postures: TheaterPostureSummary[]) => void;
  refreshOpenCountryBrief: () => void;
}

export class DataLoaderManager implements AppModule {
  private ctx: AppContext;
  private callbacks: DataLoaderCallbacks;

  private mapFlashCache: Map<string, number> = new Map();
  private readonly MAP_FLASH_COOLDOWN_MS = 10 * 60 * 1000;
  private readonly applyTimeRangeFilterToNewsPanelsDebounced = debounce(() => {
    this.applyTimeRangeFilterToNewsPanels();
  }, 120);

  public updateSearchIndex: () => void = () => {};

  private callPanel(key: string, method: string, ...args: unknown[]): void {
    const panel = this.ctx.panels[key];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = panel as any;
    if (obj && typeof obj[method] === 'function') {
      obj[method](...args);
      return;
    }
    enqueuePanelCall(key, method, args);
  }

  private boundMarketWatchlistHandler: (() => void) | null = null;
  private satellitePropagationCleanup: (() => void) | null = null;
  private cachedSatRecs: SatRecEntry[] | null = null;

  private digestBreaker = { state: 'closed' as 'closed' | 'open' | 'half-open', failures: 0, cooldownUntil: 0 };
  private readonly digestRequestTimeoutMs = 8000;
  private readonly digestBreakerCooldownMs = 5 * 60 * 1000;
  private readonly perFeedFallbackCategoryFeedLimit = 3;
  private readonly perFeedFallbackIntelFeedLimit = 6;
  private readonly perFeedFallbackBatchSize = 2;
  private lastGoodDigest: ListFeedDigestResponse | null = null;

  constructor(ctx: AppContext, callbacks: DataLoaderCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
  }

  init(): void {
    this.boundMarketWatchlistHandler = () => {};
    window.addEventListener('wm-market-watchlist-changed', this.boundMarketWatchlistHandler as EventListener);
  }

  destroy(): void {
    this.stopSatellitePropagation();
    if (this.imageryRetryTimer) { clearTimeout(this.imageryRetryTimer); this.imageryRetryTimer = null; }
    this.applyTimeRangeFilterToNewsPanelsDebounced.cancel();
    stopOrefPolling();
    if (this.boundMarketWatchlistHandler) {
      window.removeEventListener('wm-market-watchlist-changed', this.boundMarketWatchlistHandler as EventListener);
      this.boundMarketWatchlistHandler = null;
    }
  }

  private refreshCiiAndBrief(): void {
    this.callbacks.refreshOpenCountryBrief();
    const scores = calculateCII();
    this.ctx.map?.setCIIScores(scores.map(s => ({ code: s.code, score: s.score, level: s.level })));
    this.ctx.map?.setLayerReady('ciiChoropleth', scores.length > 0);
  }

  private async tryFetchDigest(): Promise<ListFeedDigestResponse | null> {
    const now = Date.now();

    if (this.digestBreaker.state === 'open') {
      if (now < this.digestBreaker.cooldownUntil) {
        return this.lastGoodDigest ?? await this.loadPersistedDigest();
      }
      this.digestBreaker.state = 'half-open';
    }

    try {
      const resp = await fetch(
        `/api/news/v1/list-feed-digest?variant=${SITE_VARIANT}&lang=${getCurrentLanguage()}`,
        { signal: AbortSignal.timeout(this.digestRequestTimeoutMs) },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as ListFeedDigestResponse;
      const catCount = Object.keys(data.categories ?? {}).length;
      console.info(`[News] Digest fetched: ${catCount} categories`);
      this.lastGoodDigest = data;
      this.persistDigest();
      this.digestBreaker = { state: 'closed', failures: 0, cooldownUntil: 0 };
      return data;
    } catch (e) {
      console.warn('[News] Digest fetch failed, using fallback:', e);
      this.digestBreaker.failures++;
      if (this.digestBreaker.failures >= 2) {
        this.digestBreaker.state = 'open';
        this.digestBreaker.cooldownUntil = now + this.digestBreakerCooldownMs;
      }
      return this.lastGoodDigest ?? await this.loadPersistedDigest();
    }
  }

  private persistDigest(): void {
  }

  private async loadPersistedDigest(): Promise<ListFeedDigestResponse | null> {
    return null;
  }

  private isPerFeedFallbackEnabled(): boolean {
    return isFeatureEnabled('newsPerFeedFallback');
  }

  private getStaleNewsItems(category: string): NewsItem[] {
    const staleItems = this.ctx.newsByCategory[category];
    if (!Array.isArray(staleItems) || staleItems.length === 0) return [];
    return [...staleItems].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  }

  private selectLimitedFeeds<T>(feeds: T[], maxFeeds: number): T[] {
    if (feeds.length <= maxFeeds) return feeds;
    return feeds.slice(0, maxFeeds);
  }

  private shouldShowIntelligenceNotifications(): boolean {
    return !this.ctx.isMobile && !!this.ctx.findingsBadge?.isPopupEnabled();
  }

  async loadAllData(): Promise<void> {
    const runGuarded = async (name: string, fn: () => Promise<void>): Promise<void> => {
      if (this.ctx.isDestroyed || this.ctx.inFlight.has(name)) return;
      this.ctx.inFlight.add(name);
      try {
        await fn();
      } catch (e) {
        if (!this.ctx.isDestroyed) console.error(`[App] ${name} failed:`, e);
      } finally {
        this.ctx.inFlight.delete(name);
      }
    };

    const tasks: Array<{ name: string; task: Promise<void> }> = [
      { name: 'news', task: runGuarded('news', () => this.loadNews()) },
    ];

    // Happy variant only loads news data -- skip all geopolitical/financial/military data
    if (SITE_VARIANT !== 'happy') {
      tasks.push({ name: 'fred', task: runGuarded('fred', () => this.loadFredData()) });
    }

    if (SITE_VARIANT === 'full') {
      tasks.push({ name: 'intelligence', task: runGuarded('intelligence', () => this.loadIntelligenceSignals()) });
    }

    if (SITE_VARIANT === 'full') tasks.push({ name: 'firms', task: runGuarded('firms', () => this.loadFirmsData()) });
    if (SITE_VARIANT !== 'happy' && !isDesktopRuntime() && this.ctx.mapLayers.ais) tasks.push({ name: 'ais', task: runGuarded('ais', () => this.loadAisSignals()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.cables) tasks.push({ name: 'cables', task: runGuarded('cables', () => this.loadCableActivity()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.cables) tasks.push({ name: 'cableHealth', task: runGuarded('cableHealth', () => this.loadCableHealth()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.flights) tasks.push({ name: 'flights', task: runGuarded('flights', () => this.loadFlightDelays()) });
    if (SITE_VARIANT !== 'happy' && CYBER_LAYER_ENABLED && this.ctx.mapLayers.cyberThreats) tasks.push({ name: 'cyberThreats', task: runGuarded('cyberThreats', () => this.loadCyberThreats()) });
    if (SITE_VARIANT !== 'happy' && !isDesktopRuntime()) tasks.push({ name: 'iranAttacks', task: runGuarded('iranAttacks', () => this.loadIranEvents()) });
    if (SITE_VARIANT !== 'happy' && this.ctx.mapLayers.satellites && this.ctx.map?.isGlobeMode?.()) tasks.push({ name: 'satellites', task: runGuarded('satellites', () => this.loadSatellites()) });

    // Stagger startup: run tasks in small batches to avoid hammering upstreams
    const BATCH_SIZE = 4;
    const BATCH_DELAY_MS = 300;
    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      const batch = tasks.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(t => t.task));
      results.forEach((result, idx) => {
        if (result.status === 'rejected') {
          console.error(`[App] ${batch[idx]?.name} load failed:`, result.reason);
        }
      });
      if (i + BATCH_SIZE < tasks.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    this.updateSearchIndex();



    const bootstrapTemporal = consumeServerAnomalies();
    if (bootstrapTemporal.anomalies.length > 0 || bootstrapTemporal.trackedTypes.length > 0) {
    } else {
    }
  }

  async refreshTemporalBaseline(): Promise<void> {
  }

  async loadDataForLayer(layer: keyof MapLayers): Promise<void> {
    if (this.ctx.isDestroyed || this.ctx.inFlight.has(layer)) return;
    this.ctx.inFlight.add(layer);
    this.ctx.map?.setLayerLoading(layer, true);
    try {
      switch (layer) {
        case 'fires':
          await this.loadFirmsData();
          break;
        case 'outages':
          await this.loadOutages();
          break;
        case 'cyberThreats':
          await this.loadCyberThreats();
          break;
        case 'ais':
          await this.loadAisSignals();
          break;
        case 'cables':
          await Promise.all([this.loadCableActivity(), this.loadCableHealth()]);
          break;
        case 'protests':
          await this.loadProtests();
          break;
        case 'flights':
          await this.loadFlightDelays();
          break;

        case 'iranAttacks':
          await this.loadIranEvents();
          break;
        case 'satellites': {
          await this.loadSatellites();
          this.loadImageryFootprints();
          break;
        }
        case 'displacement':
        case 'climate':
        case 'gpsJamming':
          await this.loadIntelligenceSignals();
          break;
      }
    } finally {
      this.ctx.inFlight.delete(layer);
      this.ctx.map?.setLayerLoading(layer, false);
    }
  }

  async loadSatellites(): Promise<void> {
    this.stopSatellitePropagation();
    const data = await fetchSatelliteTLEs();
    if (!data || data.length === 0) return;
    this.cachedSatRecs = initSatRecs(data);
    const positions = propagatePositions(this.cachedSatRecs);
    this.ctx.map?.setSatellites(positions);
    this.satellitePropagationCleanup = startPropagationLoop(this.cachedSatRecs, (pos) => {
      this.ctx.map?.setSatellites(pos);
    }, 3000);
  }

  private stopSatellitePropagation(): void {
    this.satellitePropagationCleanup?.();
    this.satellitePropagationCleanup = null;
  }

  private imageryRetryTimer: ReturnType<typeof setTimeout> | null = null;

  private loadImageryFootprints(retries = 2): void {
    if (!this.ctx.mapLayers.satellites) return;
    if (this.ctx.map?.isGlobeMode()) return;
    const bbox = this.ctx.map?.getBbox();
    if (!bbox) {
      if (retries > 0) {
        this.imageryRetryTimer = setTimeout(() => this.loadImageryFootprints(retries - 1), 1500);
      }
      return;
    }
    void import('@/services/imagery').then(async ({ fetchImageryScenes }) => {
      try {
        const scenes = await fetchImageryScenes({ bbox, limit: 20 });
        if (!this.ctx.mapLayers.satellites) return;
        if (this.ctx.map?.isGlobeMode()) return;
        this.ctx.map?.setImageryScenes(scenes);
      } catch { /* imagery is best-effort */ }
    });
  }

  stopLayerActivity(layer: keyof MapLayers): void {
    if (layer === 'satellites') {
      this.stopSatellitePropagation();
      if (this.imageryRetryTimer) { clearTimeout(this.imageryRetryTimer); this.imageryRetryTimer = null; }
    }
  }

  private findFlashLocation(title: string): { lat: number; lon: number } | null {
    const tokens = tokenizeForMatch(title);
    let bestMatch: { lat: number; lon: number; matches: number } | null = null;

    const countKeywordMatches = (keywords: string[] | undefined): number => {
      if (!keywords) return 0;
      let matches = 0;
      for (const keyword of keywords) {
        const cleaned = keyword.trim().toLowerCase();
        if (cleaned.length >= 3 && matchKeyword(tokens, cleaned)) {
          matches++;
        }
      }
      return matches;
    };

    for (const hotspot of INTEL_HOTSPOTS) {
      const matches = countKeywordMatches(hotspot.keywords);
      if (matches > 0 && (!bestMatch || matches > bestMatch.matches)) {
        bestMatch = { lat: hotspot.lat, lon: hotspot.lon, matches };
      }
    }

    for (const conflict of CONFLICT_ZONES) {
      const matches = countKeywordMatches(conflict.keywords);
      if (matches > 0 && (!bestMatch || matches > bestMatch.matches)) {
        bestMatch = { lat: conflict.center[1], lon: conflict.center[0], matches };
      }
    }

    return bestMatch;
  }

  private flashMapForNews(items: NewsItem[]): void {
    if (!this.ctx.map || !this.ctx.initialLoadComplete) return;
    if (!getAiFlowSettings().mapNewsFlash) return;
    const now = Date.now();

    for (const [key, timestamp] of this.mapFlashCache.entries()) {
      if (now - timestamp > this.MAP_FLASH_COOLDOWN_MS) {
        this.mapFlashCache.delete(key);
      }
    }

    for (const item of items) {
      const cacheKey = `${item.source}|${item.link || item.title}`;
      const lastSeen = this.mapFlashCache.get(cacheKey);
      if (lastSeen && now - lastSeen < this.MAP_FLASH_COOLDOWN_MS) {
        continue;
      }

      const location = this.findFlashLocation(item.title);
      if (!location) continue;

      this.ctx.map.flashLocation(location.lat, location.lon);
      this.mapFlashCache.set(cacheKey, now);
    }
  }

  getTimeRangeWindowMs(range: TimeRange): number {
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

  filterItemsByTimeRange(items: NewsItem[], range: TimeRange = this.ctx.currentTimeRange): NewsItem[] {
    if (range === 'all') return items;
    const cutoff = Date.now() - this.getTimeRangeWindowMs(range);
    return items.filter((item) => {
      const ts = item.pubDate instanceof Date ? item.pubDate.getTime() : new Date(item.pubDate).getTime();
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });
  }

  getTimeRangeLabel(range: TimeRange = this.ctx.currentTimeRange): string {
    const labels: Record<TimeRange, string> = {
      '1h': 'the last hour',
      '6h': 'the last 6 hours',
      '24h': 'the last 24 hours',
      '48h': 'the last 48 hours',
      '7d': 'the last 7 days',
      'all': 'all time',
    };
    return labels[range];
  }

  renderNewsForCategory(category: string, items: NewsItem[]): void {
    this.ctx.newsByCategory[category] = items;
    const panel = this.ctx.newsPanels[category];
    if (!panel) return;
    const filteredItems = this.filterItemsByTimeRange(items);
    if (filteredItems.length === 0 && items.length > 0) {
      panel.renderFilteredEmpty(`No items in ${this.getTimeRangeLabel()}`);
      return;
    }
    panel.renderNews(filteredItems);
  }

  applyTimeRangeFilterToNewsPanels(): void {
    Object.entries(this.ctx.newsByCategory).forEach(([category, items]) => {
      this.renderNewsForCategory(category, items);
    });
  }

  applyTimeRangeFilterDebounced(): void {
    this.applyTimeRangeFilterToNewsPanelsDebounced();
  }

  private async loadNewsCategory(category: string, feeds: typeof FEEDS.politics, digest?: ListFeedDigestResponse | null): Promise<NewsItem[]> {
    try {
      const panel = this.ctx.newsPanels[category];

      const enabledFeeds = (feeds ?? []).filter(f => !this.ctx.disabledSources.has(f.name));
      if (enabledFeeds.length === 0) {
        delete this.ctx.newsByCategory[category];
        if (panel) panel.showError(t('common.allSourcesDisabled'));
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: 0,
        });
        return [];
      }
      const enabledNames = new Set(enabledFeeds.map(f => f.name));

      // Digest branch: server already aggregated feeds — map proto items to client types
      if (digest?.categories && category in digest.categories) {
        let items = (digest.categories[category]?.items ?? [])
          .map(protoItemToNewsItem)
          .filter(i => enabledNames.has(i.source));

        ingestHeadlines(items.map(i => ({ title: i.title, pubDate: i.pubDate, source: i.source, link: i.link })));

        const aiCandidates = items
          .filter(i => i.threat?.source === 'keyword')
          .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
          .slice(0, AI_CLASSIFY_MAX_PER_FEED);
        for (const item of aiCandidates) {
          if (!canQueueAiClassification(item.title)) continue;
          classifyWithAI(item.title, SITE_VARIANT).then(ai => {
            if (ai && item.threat && ai.confidence > item.threat.confidence) {
              item.threat = ai;
              item.isAlert = ai.level === 'critical' || ai.level === 'high';
            }
          }).catch(() => {});
        }

        checkBatchForBreakingAlerts(items);
        this.flashMapForNews(items);
        this.renderNewsForCategory(category, items);

        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: items.length,
        });

        if (panel) {
          try {
            const baseline = await updateBaseline(`news:${category}`, items.length);
            const deviation = calculateDeviation(items.length, baseline);
            panel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
          } catch (e) { console.warn(`[Baseline] news:${category} write failed:`, e); }
        }

        return items;
      }

      // Per-feed fallback: fetch each feed individually (first load or digest unavailable)
      const renderIntervalMs = 100;
      let lastRenderTime = 0;
      let renderTimeout: ReturnType<typeof setTimeout> | null = null;
      let pendingItems: NewsItem[] | null = null;

      const flushPendingRender = () => {
        if (!pendingItems) return;
        this.renderNewsForCategory(category, pendingItems);
        pendingItems = null;
        lastRenderTime = Date.now();
      };

      const scheduleRender = (partialItems: NewsItem[]) => {
        if (!panel) return;
        pendingItems = partialItems;
        const elapsed = Date.now() - lastRenderTime;
        if (elapsed >= renderIntervalMs) {
          if (renderTimeout) {
            clearTimeout(renderTimeout);
            renderTimeout = null;
          }
          flushPendingRender();
          return;
        }

        if (!renderTimeout) {
          renderTimeout = setTimeout(() => {
            renderTimeout = null;
            flushPendingRender();
          }, renderIntervalMs - elapsed);
        }
      };

      const staleItems = this.getStaleNewsItems(category).filter(i => enabledNames.has(i.source));
      if (staleItems.length > 0) {
        console.warn(`[News] Digest missing for "${category}", serving stale headlines (${staleItems.length})`);
        this.renderNewsForCategory(category, staleItems);
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: staleItems.length,
        });
        return staleItems;
      }

      if (!this.isPerFeedFallbackEnabled()) {
        console.warn(`[News] Digest missing for "${category}", limited per-feed fallback disabled`);
        this.renderNewsForCategory(category, []);
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'error',
          errorMessage: 'Digest unavailable',
        });
        return [];
      }

      const fallbackFeeds = this.selectLimitedFeeds(enabledFeeds, this.perFeedFallbackCategoryFeedLimit);
      if (fallbackFeeds.length < enabledFeeds.length) {
        console.warn(`[News] Digest missing for "${category}", using limited per-feed fallback (${fallbackFeeds.length}/${enabledFeeds.length} feeds)`);
      } else {
        console.warn(`[News] Digest missing for "${category}", using per-feed fallback (${fallbackFeeds.length} feeds)`);
      }

      const items = await fetchCategoryFeeds(fallbackFeeds, {
        batchSize: this.perFeedFallbackBatchSize,
        onBatch: (partialItems) => {
          scheduleRender(partialItems);
          this.flashMapForNews(partialItems);
          checkBatchForBreakingAlerts(partialItems);
        },
      });

      this.renderNewsForCategory(category, items);
      if (panel) {
        if (renderTimeout) {
          clearTimeout(renderTimeout);
          renderTimeout = null;
          pendingItems = null;
        }

        if (items.length === 0) {
          const failures = getFeedFailures();
          const failedFeeds = fallbackFeeds.filter(f => failures.has(f.name));
          if (failedFeeds.length > 0) {
            const names = failedFeeds.map(f => f.name).join(', ');
            panel.showError(`${t('common.noNewsAvailable')} (${names} failed)`);
          }
        }

        try {
          const baseline = await updateBaseline(`news:${category}`, items.length);
          const deviation = calculateDeviation(items.length, baseline);
          panel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
        } catch (e) { console.warn(`[Baseline] news:${category} write failed:`, e); }
      }

      this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
        status: 'ok',
        itemCount: items.length,
      });
      this.ctx.statusPanel?.updateApi('RSS2JSON', { status: 'ok' });

      return items;
    } catch (error) {
      this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
        status: 'error',
        errorMessage: String(error),
      });
      this.ctx.statusPanel?.updateApi('RSS2JSON', { status: 'error' });
      delete this.ctx.newsByCategory[category];
      return [];
    }
  }

  async loadNews(): Promise<void> {
    // Reset happy variant accumulator for fresh pipeline run
    if (SITE_VARIANT === 'happy') {
      this.ctx.happyAllItems = [];
    }

    // Fire digest fetch early (non-blocking) — await before category loop
    const digestPromise = this.tryFetchDigest();

    const categories = Object.entries(FEEDS)
      .filter((entry): entry is [string, typeof FEEDS[keyof typeof FEEDS]] => Array.isArray(entry[1]) && entry[1].length > 0)
      .map(([key, feeds]) => ({ key, feeds }));

    const digest = await digestPromise;

    const maxCategoryConcurrency = SITE_VARIANT === 'tech' ? 4 : 5;
    const categoryConcurrency = Math.max(1, Math.min(maxCategoryConcurrency, categories.length));
    const categoryResults: PromiseSettledResult<NewsItem[]>[] = [];
    for (let i = 0; i < categories.length; i += categoryConcurrency) {
      const chunk = categories.slice(i, i + categoryConcurrency);
      const chunkResults = await Promise.allSettled(
        chunk.map(({ key, feeds }) => this.loadNewsCategory(key, feeds, digest))
      );
      categoryResults.push(...chunkResults);
    }

    const collectedNews: NewsItem[] = [];
    categoryResults.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        const items = result.value;
        // Tag items with content categories for happy variant
        if (SITE_VARIANT === 'happy') {
          this.ctx.happyAllItems = this.ctx.happyAllItems.concat(items);
        }
        collectedNews.push(...items);
      } else {
        console.error(`[App] News category ${categories[idx]?.key} failed:`, result.reason);
      }
    });

    if (SITE_VARIANT === 'full') {
      const enabledIntelSources = INTEL_SOURCES.filter(f => !this.ctx.disabledSources.has(f.name));
      const enabledIntelNames = new Set(enabledIntelSources.map(f => f.name));
      const intelPanel = this.ctx.newsPanels['intel'];
      if (enabledIntelSources.length === 0) {
        delete this.ctx.newsByCategory['intel'];
        if (intelPanel) intelPanel.showError(t('common.allIntelSourcesDisabled'));
        this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: 0 });
      } else if (digest?.categories && 'intel' in digest.categories) {
        // Digest branch for intel
        const intel = (digest.categories['intel']?.items ?? [])
          .map(protoItemToNewsItem)
          .filter(i => enabledIntelNames.has(i.source));
        checkBatchForBreakingAlerts(intel);
        this.renderNewsForCategory('intel', intel);
        if (intelPanel) {
          try {
            const baseline = await updateBaseline('news:intel', intel.length);
            const deviation = calculateDeviation(intel.length, baseline);
            intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
          } catch (e) { console.warn('[Baseline] news:intel write failed:', e); }
        }
        this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: intel.length });
        collectedNews.push(...intel);
        this.flashMapForNews(intel);
      } else {
        const staleIntel = this.getStaleNewsItems('intel').filter(i => enabledIntelNames.has(i.source));
        if (staleIntel.length > 0) {
          console.warn(`[News] Intel digest missing, serving stale headlines (${staleIntel.length})`);
          this.renderNewsForCategory('intel', staleIntel);
          if (intelPanel) {
            try {
              const baseline = await updateBaseline('news:intel', staleIntel.length);
              const deviation = calculateDeviation(staleIntel.length, baseline);
              intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
            } catch (e) { console.warn('[Baseline] news:intel write failed:', e); }
          }
          this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: staleIntel.length });
          collectedNews.push(...staleIntel);
        } else if (!this.isPerFeedFallbackEnabled()) {
          console.warn('[News] Intel digest missing, limited per-feed fallback disabled');
          delete this.ctx.newsByCategory['intel'];
          this.ctx.statusPanel?.updateFeed('Intel', { status: 'error', errorMessage: 'Digest unavailable' });
        } else {
          const fallbackIntelFeeds = this.selectLimitedFeeds(enabledIntelSources, this.perFeedFallbackIntelFeedLimit);
          if (fallbackIntelFeeds.length < enabledIntelSources.length) {
            console.warn(`[News] Intel digest missing, using limited per-feed fallback (${fallbackIntelFeeds.length}/${enabledIntelSources.length} feeds)`);
          }

          const intelResult = await Promise.allSettled([
            fetchCategoryFeeds(fallbackIntelFeeds, { batchSize: this.perFeedFallbackBatchSize }),
          ]);
          if (intelResult[0]?.status === 'fulfilled') {
            const intel = intelResult[0].value;
            checkBatchForBreakingAlerts(intel);
            this.renderNewsForCategory('intel', intel);
            if (intelPanel) {
              try {
                const baseline = await updateBaseline('news:intel', intel.length);
                const deviation = calculateDeviation(intel.length, baseline);
                intelPanel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
              } catch (e) { console.warn('[Baseline] news:intel write failed:', e); }
            }
            this.ctx.statusPanel?.updateFeed('Intel', { status: 'ok', itemCount: intel.length });
            collectedNews.push(...intel);
            this.flashMapForNews(intel);
          } else {
            delete this.ctx.newsByCategory['intel'];
            console.error('[App] Intel feed failed:', intelResult[0]?.reason);
          }
        }
      }
    }

    this.ctx.allNews = collectedNews;
    this.ctx.initialLoadComplete = true;
    mountCommunityWidget();

    this.ctx.map?.updateHotspotActivity(this.ctx.allNews);

    this.updateMonitorResults();

    try {
      this.ctx.latestClusters = mlWorker.isAvailable
        ? await clusterNewsHybrid(this.ctx.allNews)
        : await analysisWorker.clusterNews(this.ctx.allNews);


      const geoLocated = this.ctx.latestClusters
        .filter((c): c is typeof c & { lat: number; lon: number } => c.lat != null && c.lon != null)
        .map(c => ({
          lat: c.lat,
          lon: c.lon,
          title: c.primaryTitle,
          threatLevel: c.threat?.level ?? 'info',
          timestamp: c.lastUpdated,
        }));
      if (geoLocated.length > 0) {
        this.ctx.map?.setNewsLocations(geoLocated);
      }
    } catch (error) {
      console.error('[App] Clustering failed, clusters unchanged:', error);
    }
  }











  async loadIntelligenceSignals(): Promise<void> {
    resetHotspotActivity();
    const tasks: Promise<void>[] = [];

    const protestsTask = (async (): Promise<SocialUnrestEvent[]> => {
      try {
        const protestData = await fetchProtestEvents();
        this.ctx.intelligenceCache.protests = protestData;
        const protestCount = protestData.sources.acled + protestData.sources.gdelt;
        if (protestCount > 0) dataFreshness.recordUpdate('acled', protestCount);
        if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt', protestData.sources.gdelt);
        if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt_doc', protestData.sources.gdelt);
        if (this.ctx.mapLayers.protests) {
          this.ctx.map?.setProtests(protestData.events);
          this.ctx.map?.setLayerReady('protests', protestData.events.length > 0);
          const status = getProtestStatus();
          this.ctx.statusPanel?.updateFeed('Protests', {
            status: 'ok',
            itemCount: protestData.events.length,
            errorMessage: status.acledConfigured === false ? 'ACLED not configured - using GDELT only' : undefined,
          });
        }
        return protestData.events;
      } catch (error) {
        console.error('[Intelligence] Protests fetch failed:', error);
        dataFreshness.recordError('acled', String(error));
        return [];
      }
    })();
    tasks.push(protestsTask.then(() => undefined));

    tasks.push((async () => {
      try {
        const conflictData = await fetchConflictEvents();
        ingestConflictsForCII(conflictData.events);
        if (conflictData.count > 0) dataFreshness.recordUpdate('acled_conflict', conflictData.count);
      } catch (error) {
        console.error('[Intelligence] Conflict events fetch failed:', error);
        dataFreshness.recordError('acled_conflict', String(error));
      }

    })());

    tasks.push((async () => {
      try {
        const summaries = await fetchHapiSummary();
        ingestHapiForCII(summaries);
        if (summaries.size > 0) dataFreshness.recordUpdate('hapi', summaries.size);
      } catch (error) {
        console.error('[Intelligence] HAPI fetch failed:', error);
        dataFreshness.recordError('hapi', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        if (isMilitaryVesselTrackingConfigured()) {
          initMilitaryVesselStream();
        }
        const [flightData, vesselData] = await Promise.all([
          fetchMilitaryFlights(),
          fetchMilitaryVessels(),
        ]);
      this.ctx.intelligenceCache.military = {
        flights: flightData.flights,
        flightClusters: flightData.clusters,
        vessels: vesselData.vessels,
        vesselClusters: vesselData.clusters,
      };
      
      this.ctx.map?.setMilitaryFlights(flightData.flights, flightData.clusters);
      this.ctx.map?.setMilitaryVessels(vesselData.vessels, vesselData.clusters);
      
      signalAggregator.ingestFlights(flightData.flights);
      signalAggregator.ingestVessels(vesselData.vessels);
        dataFreshness.recordUpdate('opensky', flightData.flights.length);
        updateAndCheck([
          { type: 'military_flights', region: 'global', count: flightData.flights.length },
          { type: 'vessels', region: 'global', count: vesselData.vessels.length },
        ]).then(anomalies => {
          if (anomalies.length > 0) {
            signalAggregator.ingestTemporalAnomalies(anomalies);
            ingestTemporalAnomaliesForCII(anomalies);
            this.refreshCiiAndBrief();
          }
        }).catch(() => { });
        if (this.ctx.mapLayers.military) {
          this.ctx.map?.setMilitaryFlights(flightData.flights, flightData.clusters);
          this.ctx.map?.setMilitaryVessels(vesselData.vessels, vesselData.clusters);
          this.ctx.map?.updateMilitaryForEscalation(flightData.flights, vesselData.vessels);
          const militaryCount = flightData.flights.length + vesselData.vessels.length;
          this.ctx.statusPanel?.updateFeed('Military', {
            status: militaryCount > 0 ? 'ok' : 'warning',
            itemCount: militaryCount,
          });
        }
        if (!isInLearningMode()) {
          const surgeAlerts = analyzeFlightsForSurge(flightData.flights);
          if (surgeAlerts.length > 0) {
            const surgeSignals = surgeAlerts.map(surgeAlertToSignal);
            addToSignalHistory(surgeSignals);
            if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(surgeSignals);
          }
          const foreignAlerts = detectForeignMilitaryPresence(flightData.flights);
          if (foreignAlerts.length > 0) {
            const foreignSignals = foreignAlerts.map(foreignPresenceToSignal);
            addToSignalHistory(foreignSignals);
            if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(foreignSignals);
          }
        }
      } catch (error) {
        console.error('[Intelligence] Military fetch failed:', error);
        dataFreshness.recordError('opensky', String(error));
      }
    })());



    tasks.push((async () => {
      try {
        const unhcrResult = await fetchUnhcrPopulation();
        if (!unhcrResult.ok) {
          dataFreshness.recordError('unhcr', 'UNHCR displacement unavailable (retaining prior displacement state)');
          return;
        }
        const data = unhcrResult.data;
        this.callPanel('displacement', 'setData', data);
        ingestDisplacementForCII(data.countries);
        if (this.ctx.mapLayers.displacement && data.topFlows) {
          this.ctx.map?.setDisplacementFlows(data.topFlows);
        }
        if (data.countries.length > 0) dataFreshness.recordUpdate('unhcr', data.countries.length);
      } catch (error) {
        console.error('[Intelligence] UNHCR displacement fetch failed:', error);
        dataFreshness.recordError('unhcr', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const climateResult = await fetchClimateAnomalies();
        if (!climateResult.ok) {
          dataFreshness.recordError('climate', 'Climate anomalies unavailable (retaining prior climate state)');
          return;
        }
        const anomalies = climateResult.anomalies;
        this.callPanel('climate', 'setAnomalies', anomalies);
        ingestClimateForCII(anomalies);
        if (this.ctx.mapLayers.climate) {
          this.ctx.map?.setClimateAnomalies(anomalies);
        }
        if (anomalies.length > 0) dataFreshness.recordUpdate('climate', anomalies.length);
      } catch (error) {
        console.error('[Intelligence] Climate anomalies fetch failed:', error);
        dataFreshness.recordError('climate', String(error));
      }
    })());



    // OREF sirens
    tasks.push((async () => {
      try {
        const data = await fetchOrefAlerts();
        this.callPanel('oref-sirens', 'setData', data);
        const alertCount = data.alerts?.length ?? 0;
        const historyCount24h = data.historyCount24h ?? 0;
        this.ctx.intelligenceCache.orefAlerts = { alertCount, historyCount24h };
        if (data.alerts?.length) dispatchOrefBreakingAlert(data.alerts);
        onOrefAlertsUpdate((update) => {
          this.callPanel('oref-sirens', 'setData', update);
          const updAlerts = update.alerts?.length ?? 0;
          const updHistory = update.historyCount24h ?? 0;
          this.ctx.intelligenceCache.orefAlerts = { alertCount: updAlerts, historyCount24h: updHistory };
          if (update.alerts?.length) dispatchOrefBreakingAlert(update.alerts);
        });
        startOrefPolling();
      } catch (error) {
        console.error('[Intelligence] OREF alerts fetch failed:', error);
      }
    })());

    // GPS/GNSS jamming (cloud-only — seeded by Wingbits API via fetch-gpsjam.mjs)
    if (!isDesktopRuntime()) {
      tasks.push((async () => {
        try {
          const data = await fetchGpsInterference();
          if (!data) {
            ingestGpsJammingForCII([]);
            this.ctx.map?.setLayerReady('gpsJamming', false);
            return;
          }
          ingestGpsJammingForCII(data.hexes);
          if (this.ctx.mapLayers.gpsJamming) {
            this.ctx.map?.setGpsJamming(data.hexes);
            this.ctx.map?.setLayerReady('gpsJamming', data.hexes.length > 0);
          }
          this.ctx.statusPanel?.updateFeed('GPS Jam', { status: 'ok', itemCount: data.hexes.length });
          dataFreshness.recordUpdate('gpsjam', data.hexes.length);
        } catch (error) {
          this.ctx.map?.setLayerReady('gpsJamming', false);
          this.ctx.statusPanel?.updateFeed('GPS Jam', { status: 'error' });
          dataFreshness.recordError('gpsjam', String(error));
        }
      })());
    }

    await Promise.allSettled(tasks);

    try {
      const events = [
        ...(this.ctx.intelligenceCache.protests?.events || []).slice(0, 10).map(e => ({
          id: e.id, lat: e.lat, lon: e.lon, type: 'conflict' as const, name: e.title || 'Protest',
        })),
      ];
      if (events.length > 0) {
        const exposures = await enrichEventsWithExposure(events);
        this.callPanel('population-exposure', 'setExposures', exposures);
        if (exposures.length > 0) dataFreshness.recordUpdate('worldpop', exposures.length);
      } else {
        this.callPanel('population-exposure', 'setExposures', []);
      }
    } catch (error) {
      console.error('[Intelligence] Population exposure fetch failed:', error);
      dataFreshness.recordError('worldpop', String(error));
    }

    if (hasAnyIntelligenceData()) {
      setIntelligenceSignalsLoaded();
    }
    this.refreshCiiAndBrief();
    console.log('[Intelligence] All signals loaded for CII calculation');
  }

  async loadOutages(): Promise<void> {
    if (this.ctx.intelligenceCache.outages) {
      const outages = this.ctx.intelligenceCache.outages;
      this.ctx.map?.setOutages(outages);
      this.ctx.map?.setLayerReady('outages', outages.length > 0);
      this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
      return;
    }
    try {
      const outages = await fetchInternetOutages();
      this.ctx.intelligenceCache.outages = outages;
      this.ctx.map?.setOutages(outages);
      this.ctx.map?.setLayerReady('outages', outages.length > 0);
      ingestOutagesForCII(outages);
      signalAggregator.ingestOutages(outages);
      this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
      dataFreshness.recordUpdate('outages', outages.length);
    } catch (error) {
      this.ctx.map?.setLayerReady('outages', false);
      this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'error' });
      dataFreshness.recordError('outages', String(error));
    }
  }

  async loadCyberThreats(): Promise<void> {
    if (!CYBER_LAYER_ENABLED) {
      this.ctx.mapLayers.cyberThreats = false;
      this.ctx.map?.setLayerReady('cyberThreats', false);
      return;
    }

    if (this.ctx.cyberThreatsCache) {
      this.ctx.map?.setCyberThreats(this.ctx.cyberThreatsCache);
      this.ctx.map?.setLayerReady('cyberThreats', this.ctx.cyberThreatsCache.length > 0);
      ingestCyberThreatsForCII(this.ctx.cyberThreatsCache);
      this.refreshCiiAndBrief();
      this.ctx.statusPanel?.updateFeed('Cyber Threats', { status: 'ok', itemCount: this.ctx.cyberThreatsCache.length });
      return;
    }

    try {
      const threats = await fetchCyberThreats({ limit: 500, days: 14 });
      this.ctx.cyberThreatsCache = threats;
      this.ctx.map?.setCyberThreats(threats);
      this.ctx.map?.setLayerReady('cyberThreats', threats.length > 0);
      ingestCyberThreatsForCII(threats);
      this.refreshCiiAndBrief();
      this.ctx.statusPanel?.updateFeed('Cyber Threats', { status: 'ok', itemCount: threats.length });
      this.ctx.statusPanel?.updateApi('Cyber Threats API', { status: 'ok' });
      dataFreshness.recordUpdate('cyber_threats', threats.length);
    } catch (error) {
      this.ctx.map?.setLayerReady('cyberThreats', false);
      this.ctx.statusPanel?.updateFeed('Cyber Threats', { status: 'error', errorMessage: String(error) });
      this.ctx.statusPanel?.updateApi('Cyber Threats API', { status: 'error' });
      dataFreshness.recordError('cyber_threats', String(error));
    }
  }

  async loadIranEvents(): Promise<void> {
    try {
      const events = await fetchIranEvents();
      this.ctx.intelligenceCache.iranEvents = events;
      this.ctx.map?.setIranEvents(events);
      this.ctx.map?.setLayerReady('iranAttacks', events.length > 0);
      const coerced = events.map(e => ({ ...e, timestamp: Number(e.timestamp) || 0 }));
      signalAggregator.ingestConflictEvents(coerced);
      ingestStrikesForCII(coerced);
      this.refreshCiiAndBrief();
    } catch {
      this.ctx.map?.setLayerReady('iranAttacks', false);
    }
  }

  async loadAisSignals(): Promise<void> {
    try {
      const { disruptions, density } = await fetchAisSignals();
      const aisStatus = getAisStatus();
      console.log('[Ships] Events:', { disruptions: disruptions.length, density: density.length, vessels: aisStatus.vessels });
      this.ctx.map?.setAisData(disruptions, density);
      signalAggregator.ingestAisDisruptions(disruptions);
      ingestAisDisruptionsForCII(disruptions);
      this.refreshCiiAndBrief();
      updateAndCheck([
        { type: 'ais_gaps', region: 'global', count: disruptions.length },
      ]).then(anomalies => {
        if (anomalies.length > 0) {
          signalAggregator.ingestTemporalAnomalies(anomalies);
          ingestTemporalAnomaliesForCII(anomalies);
          this.refreshCiiAndBrief();
        }
      }).catch(() => { });

      const hasData = disruptions.length > 0 || density.length > 0;
      this.ctx.map?.setLayerReady('ais', hasData);

      const shippingCount = disruptions.length + density.length;
      const shippingStatus = shippingCount > 0 ? 'ok' : (aisStatus.connected ? 'warning' : 'error');
      this.ctx.statusPanel?.updateFeed('Shipping', {
        status: shippingStatus,
        itemCount: shippingCount,
        errorMessage: !aisStatus.connected && shippingCount === 0 ? 'AIS snapshot unavailable' : undefined,
      });
      this.ctx.statusPanel?.updateApi('AISStream', {
        status: aisStatus.connected ? 'ok' : 'warning',
      });
      if (hasData) {
        dataFreshness.recordUpdate('ais', shippingCount);
      }
    } catch (error) {
      this.ctx.map?.setLayerReady('ais', false);
      this.ctx.statusPanel?.updateFeed('Shipping', { status: 'error', errorMessage: String(error) });
      this.ctx.statusPanel?.updateApi('AISStream', { status: 'error' });
      dataFreshness.recordError('ais', String(error));
    }
  }

  waitForAisData(): void {
    const maxAttempts = 30;
    let attempts = 0;

    const checkData = () => {
      if (this.ctx.isDestroyed) return;
      attempts++;
      const status = getAisStatus();

      if (status.vessels > 0 || status.connected) {
        this.loadAisSignals();
        this.ctx.map?.setLayerLoading('ais', false);
        return;
      }

      if (attempts >= maxAttempts) {
        this.ctx.map?.setLayerLoading('ais', false);
        this.ctx.map?.setLayerReady('ais', false);
        this.ctx.statusPanel?.updateFeed('Shipping', {
          status: 'error',
          errorMessage: 'Connection timeout'
        });
        return;
      }

      setTimeout(checkData, 1000);
    };

    checkData();
  }

  async loadCableActivity(): Promise<void> {
    try {
      const activity = await fetchCableActivity();
      this.ctx.map?.setCableActivity(activity.advisories, activity.repairShips);
      const itemCount = activity.advisories.length + activity.repairShips.length;
      this.ctx.statusPanel?.updateFeed('CableOps', { status: 'ok', itemCount });
    } catch {
      this.ctx.statusPanel?.updateFeed('CableOps', { status: 'error' });
    }
  }

  async loadCableHealth(): Promise<void> {
    try {
      const healthData = await fetchCableHealth();
      this.ctx.map?.setCableHealth(healthData.cables);
      const cableIds = Object.keys(healthData.cables);
      const faultCount = cableIds.filter((id) => healthData.cables[id]?.status === 'fault').length;
      const degradedCount = cableIds.filter((id) => healthData.cables[id]?.status === 'degraded').length;
      this.ctx.statusPanel?.updateFeed('CableHealth', { status: 'ok', itemCount: faultCount + degradedCount });
    } catch {
      this.ctx.statusPanel?.updateFeed('CableHealth', { status: 'error' });
    }
  }

  async loadProtests(): Promise<void> {
    if (this.ctx.intelligenceCache.protests) {
      const protestData = this.ctx.intelligenceCache.protests;
      this.ctx.map?.setProtests(protestData.events);
      this.ctx.map?.setLayerReady('protests', protestData.events.length > 0);
      const status = getProtestStatus();
      this.ctx.statusPanel?.updateFeed('Protests', {
        status: 'ok',
        itemCount: protestData.events.length,
        errorMessage: status.acledConfigured === false ? 'ACLED not configured - using GDELT only' : undefined,
      });
      if (status.acledConfigured === true) {
        this.ctx.statusPanel?.updateApi('ACLED', { status: 'ok' });
      } else if (status.acledConfigured === null) {
        this.ctx.statusPanel?.updateApi('ACLED', { status: 'warning' });
      }
      this.ctx.statusPanel?.updateApi('GDELT Doc', { status: 'ok' });
      if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt_doc', protestData.sources.gdelt);
      return;
    }
    try {
      const protestData = await fetchProtestEvents();
      this.ctx.intelligenceCache.protests = protestData;
      this.ctx.map?.setProtests(protestData.events);
      this.ctx.map?.setLayerReady('protests', protestData.events.length > 0);
      signalAggregator.ingestProtests(protestData.events);
      const protestCount = protestData.sources.acled + protestData.sources.gdelt;
      if (protestCount > 0) dataFreshness.recordUpdate('acled', protestCount);
      if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt', protestData.sources.gdelt);
      if (protestData.sources.gdelt > 0) dataFreshness.recordUpdate('gdelt_doc', protestData.sources.gdelt);
      this.refreshCiiAndBrief();
      const status = getProtestStatus();
      this.ctx.statusPanel?.updateFeed('Protests', {
        status: 'ok',
        itemCount: protestData.events.length,
        errorMessage: status.acledConfigured === false ? 'ACLED not configured - using GDELT only' : undefined,
      });
      if (status.acledConfigured === true) {
        this.ctx.statusPanel?.updateApi('ACLED', { status: 'ok' });
      } else if (status.acledConfigured === null) {
        this.ctx.statusPanel?.updateApi('ACLED', { status: 'warning' });
      }
      this.ctx.statusPanel?.updateApi('GDELT Doc', { status: 'ok' });
    } catch (error) {
      this.ctx.map?.setLayerReady('protests', false);
      this.ctx.statusPanel?.updateFeed('Protests', { status: 'error', errorMessage: String(error) });
      this.ctx.statusPanel?.updateApi('ACLED', { status: 'error' });
      this.ctx.statusPanel?.updateApi('GDELT Doc', { status: 'error' });
      dataFreshness.recordError('gdelt_doc', String(error));
    }
  }

  async loadFlightDelays(): Promise<void> {
    try {
      const delays = await fetchFlightDelays();
      this.ctx.map?.setFlightDelays(delays);
      this.ctx.map?.setLayerReady('flights', delays.length > 0);
      this.ctx.intelligenceCache.flightDelays = delays;
      const severe = delays.filter(d => d.severity === 'major' || d.severity === 'severe' || d.delayType === 'closure');
      if (severe.length > 0) ingestAviationForCII(severe);
      this.ctx.statusPanel?.updateFeed('Flights', {
        status: 'ok',
        itemCount: delays.length,
      });
      this.ctx.statusPanel?.updateApi('FAA', { status: 'ok' });
    } catch (error) {
      this.ctx.map?.setLayerReady('flights', false);
      this.ctx.statusPanel?.updateFeed('Flights', { status: 'error', errorMessage: String(error) });
      this.ctx.statusPanel?.updateApi('FAA', { status: 'error' });
    }
  }

  async loadMilitary(): Promise<void> {
    if (this.ctx.intelligenceCache.military) {
      const { flights, flightClusters, vessels, vesselClusters } = this.ctx.intelligenceCache.military;
      this.ctx.map?.setMilitaryFlights(flights, flightClusters);
      this.ctx.map?.setMilitaryVessels(vessels, vesselClusters);
      this.ctx.map?.updateMilitaryForEscalation(flights, vessels);
      this.loadCachedPosturesForBanner();
      const hasData = flights.length > 0 || vessels.length > 0;
      this.ctx.map?.setLayerReady('military', hasData);
      const militaryCount = flights.length + vessels.length;
      this.ctx.statusPanel?.updateFeed('Military', {
        status: militaryCount > 0 ? 'ok' : 'warning',
        itemCount: militaryCount,
        errorMessage: militaryCount === 0 ? 'No military activity in view' : undefined,
      });
      this.ctx.statusPanel?.updateApi('OpenSky', { status: 'ok' });
      return;
    }
    try {
      if (isMilitaryVesselTrackingConfigured()) {
        initMilitaryVesselStream();
      }
      const [flightData, vesselData] = await Promise.all([
        fetchMilitaryFlights(),
        fetchMilitaryVessels(),
      ]);
      this.ctx.intelligenceCache.military = {
        flights: flightData.flights,
        flightClusters: flightData.clusters,
        vessels: vesselData.vessels,
        vesselClusters: vesselData.clusters,
      };
      fetchUSNIFleetReport().then((report) => {
        if (report) this.ctx.intelligenceCache.usniFleet = report;
      }).catch(() => {});
      this.ctx.map?.setMilitaryFlights(flightData.flights, flightData.clusters);
      this.ctx.map?.setMilitaryVessels(vesselData.vessels, vesselData.clusters);
      ingestMilitaryForCII(flightData.flights, vesselData.vessels);
      signalAggregator.ingestFlights(flightData.flights);
      signalAggregator.ingestVessels(vesselData.vessels);
      updateAndCheck([
        { type: 'military_flights', region: 'global', count: flightData.flights.length },
        { type: 'vessels', region: 'global', count: vesselData.vessels.length },
      ]).then(anomalies => {
        if (anomalies.length > 0) {
          signalAggregator.ingestTemporalAnomalies(anomalies);
          ingestTemporalAnomaliesForCII(anomalies);
          this.refreshCiiAndBrief();
        }
      }).catch(() => { });
      this.ctx.map?.updateMilitaryForEscalation(flightData.flights, vesselData.vessels);
      this.refreshCiiAndBrief();
      if (!isInLearningMode()) {
        const surgeAlerts = analyzeFlightsForSurge(flightData.flights);
        if (surgeAlerts.length > 0) {
          const surgeSignals = surgeAlerts.map(surgeAlertToSignal);
          addToSignalHistory(surgeSignals);
          if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(surgeSignals);
        }
        const foreignAlerts = detectForeignMilitaryPresence(flightData.flights);
        if (foreignAlerts.length > 0) {
          const foreignSignals = foreignAlerts.map(foreignPresenceToSignal);
          addToSignalHistory(foreignSignals);
          if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(foreignSignals);
        }
      }

      this.loadCachedPosturesForBanner();

      const hasData = flightData.flights.length > 0 || vesselData.vessels.length > 0;
      this.ctx.map?.setLayerReady('military', hasData);
      const militaryCount = flightData.flights.length + vesselData.vessels.length;
      this.ctx.statusPanel?.updateFeed('Military', {
        status: militaryCount > 0 ? 'ok' : 'warning',
        itemCount: militaryCount,
        errorMessage: militaryCount === 0 ? 'No military activity in view' : undefined,
      });
      this.ctx.statusPanel?.updateApi('OpenSky', { status: 'ok' });
      dataFreshness.recordUpdate('opensky', flightData.flights.length);
    } catch (error) {
      this.ctx.map?.setLayerReady('military', false);
      this.ctx.statusPanel?.updateFeed('Military', { status: 'error', errorMessage: String(error) });
      this.ctx.statusPanel?.updateApi('OpenSky', { status: 'error' });
      dataFreshness.recordError('opensky', String(error));
    }
  }

  private async loadCachedPosturesForBanner(): Promise<void> {
    try {
      const data = await fetchCachedTheaterPosture();
      if (data && data.postures.length > 0) {
        this.callbacks.renderCriticalBanner(data.postures);
      }
    } catch (error) {
      console.warn('[App] Failed to load cached postures for banner:', error);
    }
  }

  async loadFredData(): Promise<void> {

    try {
      const data = await fetchFredData();

      if (data.length === 0) {
        if (!isFeatureAvailable('economicFred')) {
          this.ctx.statusPanel?.updateApi('FRED', { status: 'error' });
          return;
        }
        await new Promise(r => setTimeout(r, 20_000));
        const retryData = await fetchFredData();
        if (retryData.length === 0) {
          this.ctx.statusPanel?.updateApi('FRED', { status: 'error' });
          return;
        }
        this.ctx.statusPanel?.updateApi('FRED', { status: 'ok' });
        dataFreshness.recordUpdate('economic', retryData.length);
        return;
      }

      this.ctx.statusPanel?.updateApi('FRED', { status: 'ok' });
      dataFreshness.recordUpdate('economic', data.length);
    } catch {
      if (isFeatureAvailable('economicFred')) {
        try {
          await new Promise(r => setTimeout(r, 20_000));
          const retryData = await fetchFredData();
          if (retryData.length > 0) {
            this.ctx.statusPanel?.updateApi('FRED', { status: 'ok' });
            dataFreshness.recordUpdate('economic', retryData.length);
            return;
          }
        } catch { /* fall through */ }
      }
      this.ctx.statusPanel?.updateApi('FRED', { status: 'error' });
    }
  }

  async loadOilAnalytics(): Promise<void> {
    try {
      this.ctx.statusPanel?.updateApi('EIA', { status: 'ok' });
    } catch (e) {
      console.error('[App] Oil analytics failed:', e);
      this.ctx.statusPanel?.updateApi('EIA', { status: 'error' });
      dataFreshness.recordError('oil', String(e));
    }
  }


  updateMonitorResults(): void {
  }

  async runCorrelationAnalysis(): Promise<void> {
    try {
      if (this.ctx.latestClusters.length === 0 && this.ctx.allNews.length > 0) {
        this.ctx.latestClusters = mlWorker.isAvailable
          ? await clusterNewsHybrid(this.ctx.allNews)
          : await analysisWorker.clusterNews(this.ctx.allNews);
      }

      if (this.ctx.latestClusters.length > 0) {
        ingestNewsForCII(this.ctx.latestClusters);
        dataFreshness.recordUpdate('gdelt', this.ctx.latestClusters.length);
        this.refreshCiiAndBrief();
      }

      const signals = await analysisWorker.analyzeCorrelations(
        this.ctx.latestClusters,
        this.ctx.latestPredictions,
        this.ctx.latestMarkets
      );

      const keywordSpikeSignals = drainTrendingSignals();
      const allSignals = [...signals, ...keywordSpikeSignals];
      if (allSignals.length > 0) {
        addToSignalHistory(allSignals);
        if (this.shouldShowIntelligenceNotifications()) this.ctx.signalModal?.show(allSignals);
      }
    } catch (error) {
      console.error('[App] Correlation analysis failed:', error);
    }
  }

  async loadFirmsData(): Promise<void> {
    try {
      this.ctx.statusPanel?.updateApi('FIRMS', { status: 'ok' });
    } catch (e) {
      console.warn('[App] FIRMS load failed:', e);
      this.ctx.statusPanel?.updateApi('FIRMS', { status: 'error' });
      dataFreshness.recordError('firms', String(e));
    }
  }

  syncDataFreshnessWithLayers(): void {
    for (const [layer, sourceIds] of Object.entries(LAYER_TO_SOURCE)) {
      const enabled = this.ctx.mapLayers[layer as keyof MapLayers] ?? false;
      for (const sourceId of sourceIds) {
        dataFreshness.setEnabled(sourceId as DataSourceId, enabled);
      }
    }

    if (!isAisConfigured()) {
      dataFreshness.setEnabled('ais', false);
    }
    if (isOutagesConfigured() === false) {
      dataFreshness.setEnabled('outages', false);
    }
  }

}
