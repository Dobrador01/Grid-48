import type { AppContext, AppModule } from '@/app/app-context';
import type { NewsItem, MapLayers } from '@/types';

import type { TimeRange } from '@/components';
import { LAYER_TO_SOURCE, SITE_VARIANT } from '@/config';
import { INTEL_HOTSPOTS } from '@/config/geo';
import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';
import {
  fetchFlightDelays,
  updateBaseline,
  calculateDeviation,
  analysisWorker,
} from '@/services';
import { mlWorker } from '@/services/ml-worker';
import { clusterNewsHybrid } from '@/services/clustering';
import { consumeServerAnomalies } from '@/services/temporal-baseline';
import { ingestClimateForCII, ingestAviationForCII, calculateCII } from '@/services/country-instability';
import { dataFreshness, type DataSourceId } from '@/services/data-freshness';
import { fetchClimateAnomalies } from '@/services/climate';
import { stopOrefPolling } from '@/services/oref-alerts';
import { debounce } from '@/utils';
import { isFeatureEnabled } from '@/services/runtime-config';
import { getAiFlowSettings } from '@/services/ai-flow-settings';
import { t, getCurrentLanguage } from '@/services/i18n';
import { canQueueAiClassification, AI_CLASSIFY_MAX_PER_FEED } from '@/services/ai-classify-queue';
import { classifyWithAI } from '@/services/threat-classifier';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
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


export interface DataLoaderCallbacks {
  refreshOpenCountryBrief: () => void;
}

export class DataLoaderManager implements AppModule {
  private ctx: AppContext;

  private mapFlashCache: Map<string, number> = new Map();
  private readonly MAP_FLASH_COOLDOWN_MS = 10 * 60 * 1000;
  
  public updateSearchIndex: () => void = () => {};

  private boundMarketWatchlistHandler: (() => void) | null = null;
  private satellitePropagationCleanup: (() => void) | null = null;

  private digestBreaker = { state: 'closed' as 'closed' | 'open' | 'half-open', failures: 0, cooldownUntil: 0 };
  private readonly digestRequestTimeoutMs = 8000;
  private readonly digestBreakerCooldownMs = 5 * 60 * 1000;
  private readonly perFeedFallbackCategoryFeedLimit = 3;
  private readonly perFeedFallbackIntelFeedLimit = 6;
  private lastGoodDigest: ListFeedDigestResponse | null = null;

  constructor(ctx: AppContext, _callbacks: DataLoaderCallbacks) {
    this.ctx = ctx;
  }

  init(): void {
    this.boundMarketWatchlistHandler = () => {};
    window.addEventListener('wm-market-watchlist-changed', this.boundMarketWatchlistHandler as EventListener);
  }

  destroy(): void {
    this.stopSatellitePropagation();
    if (this.imageryRetryTimer) { clearTimeout(this.imageryRetryTimer); this.imageryRetryTimer = null; }
        stopOrefPolling();
    if (this.boundMarketWatchlistHandler) {
      window.removeEventListener('wm-market-watchlist-changed', this.boundMarketWatchlistHandler as EventListener);
      this.boundMarketWatchlistHandler = null;
    }
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

    const tasks: Array<{ name: string; task: Promise<void> }> = [];

    tasks.push({ name: 'firms', task: runGuarded('firms', () => this.loadFirmsData()) });
    if (this.ctx.mapLayers.flights) tasks.push({ name: 'flights', task: runGuarded('flights', () => this.loadFlightDelays()) });

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

    consumeServerAnomalies();
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
        case 'flights':
          await this.loadFlightDelays();
          break;
        case 'climate':
          await this.loadClimateAnomalies();
          break;
      }
    } finally {
      this.ctx.inFlight.delete(layer);
      this.ctx.map?.setLayerLoading(layer, false);
    }
  }


  private stopSatellitePropagation(): void {
    this.satellitePropagationCleanup?.();
    this.satellitePropagationCleanup = null;
  }

  private imageryRetryTimer: ReturnType<typeof setTimeout> | null = null;

  stopLayerActivity(_layer: keyof MapLayers): void {
    // No satellite or imagery layers in Fat Client scope
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

  
  
  async loadNews(): Promise<void> {
    this.ctx.allNews = [];
    this.ctx.initialLoadComplete = true;
    if (this.ctx.map) this.ctx.map.updateHotspotActivity(this.ctx.allNews);
  }

  async loadIntelligenceSignals(): Promise<void> {
    // Removed: military/conflict/displacement/GPS jamming. Keeping: climate anomalies only.
    await this.loadClimateAnomalies();
  }

  async loadClimateAnomalies(): Promise<void> {
    try {
      const result = await fetchClimateAnomalies();
      const anomalies = result.anomalies;
      this.ctx.map?.setClimateAnomalies(anomalies);
      ingestClimateForCII(anomalies);
      const ciiScores = calculateCII();
      this.ctx.map?.setCIIScores(ciiScores.map(s => ({ code: s.code, score: s.score, level: s.level })));
    } catch (e) {
      console.warn('[App] Climate anomalies load failed:', e);
    }
  }

  async loadFlightDelays(): Promise<void> {
    try {
      const delays = await fetchFlightDelays();
      this.ctx.map?.setFlightDelays(delays);
      ingestAviationForCII(delays);
    } catch (e) {
      console.warn('[App] Flight delays load failed:', e);
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

  async loadOutages(): Promise<void> {
    // Internet outage data Ã¢â‚¬â€ stubbed until outage service is reconfigured for Fat Client.
  }

  async loadOilAnalytics(): Promise<void> { /* removed */ }
  async loadFredData(): Promise<void> { /* removed */ }
  async loadAisSignals(): Promise<void> { /* removed */ }
  async loadCableActivity(): Promise<void> { /* removed */ }
  async loadCableHealth(): Promise<void> { /* removed */ }
  async loadProtests(): Promise<void> { /* removed */ }
  async loadCyberThreats(): Promise<void> { /* removed */ }
  async loadIranEvents(): Promise<void> { /* removed */ }

  syncDataFreshnessWithLayers(): void {
    for (const [layer, sourceIds] of Object.entries(LAYER_TO_SOURCE)) {
      const enabled = this.ctx.mapLayers[layer as keyof MapLayers] ?? false;
      for (const sourceId of sourceIds!) {
        dataFreshness.setEnabled(sourceId as DataSourceId, enabled);
      }
    }
  }

}

