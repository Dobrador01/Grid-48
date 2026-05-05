import type { AppContext, AppModule } from '@/app/app-context';
import type { MapLayers } from '@/types';

import { LAYER_TO_SOURCE } from '@/config';
import { fetchFlightDelays } from '@/services';
import { consumeServerAnomalies } from '@/services/temporal-baseline';
import { ingestClimateForCII, ingestAviationForCII, calculateCII } from '@/services/country-instability';
import { dataFreshness, type DataSourceId } from '@/services/data-freshness';
import { fetchClimateAnomalies } from '@/services/climate';
import { stopOrefPolling } from '@/services/oref-alerts';

export interface DataLoaderCallbacks {
  refreshOpenCountryBrief: () => void;
}

export class DataLoaderManager implements AppModule {
  private ctx: AppContext;

  public updateSearchIndex: () => void = () => {};

  private boundMarketWatchlistHandler: (() => void) | null = null;
  private satellitePropagationCleanup: (() => void) | null = null;
  private imageryRetryTimer: ReturnType<typeof setTimeout> | null = null;

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

  stopLayerActivity(_layer: keyof MapLayers): void {
    // No satellite or imagery layers in Fat Client scope
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
    // Internet outage data — stubbed until outage service is reconfigured for Fat Client.
  }

  syncDataFreshnessWithLayers(): void {
    for (const [layer, sourceIds] of Object.entries(LAYER_TO_SOURCE)) {
      const enabled = this.ctx.mapLayers[layer as keyof MapLayers] ?? false;
      for (const sourceId of sourceIds!) {
        dataFreshness.setEnabled(sourceId as DataSourceId, enabled);
      }
    }
  }
}
