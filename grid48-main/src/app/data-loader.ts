import type { AppContext, AppModule } from '@/app/app-context';
import type { MapLayers } from '@/types';

import { LAYER_TO_SOURCE } from '@/config';
import { dataFreshness, type DataSourceId } from '@/services/data-freshness';

// Grid 48 DataLoaderManager
//
// Histórico: o WorldMonitor tinha pipelines pra firms (NASA FIRMS fogo),
// flights (aviation delays), outages (Internet outages), climate (anomalias).
// Grid 48 não usa nenhum desses — Celesc + Defesa Civil vêm via DataProvider
// (Convex), não via loaders aqui.
//
// Por enquanto mantemos o shape do manager (init/destroy/loadAllData/
// loadDataForLayer/stopLayerActivity) pra compat com App.ts e
// event-handlers.ts, com implementações no-op.

export interface DataLoaderCallbacks {
  refreshOpenCountryBrief: () => void;
}

export class DataLoaderManager implements AppModule {
  private ctx: AppContext;

  public updateSearchIndex: () => void = () => {};

  constructor(ctx: AppContext, _callbacks: DataLoaderCallbacks) {
    this.ctx = ctx;
  }

  init(): void {
    /* no-op */
  }

  destroy(): void {
    /* no-op */
  }

  async loadAllData(): Promise<void> {
    // Grid 48: dados vêm via DataProvider (Convex) em App.ts. Sem batch loads aqui.
    this.updateSearchIndex();
  }

  async loadDataForLayer(layer: string): Promise<void> {
    if (this.ctx.isDestroyed) return;
    this.ctx.map?.setLayerLoading(layer, true);
    // Layers Grid 48 são populadas pelos DataProviders no App.ts.
    // setLayerLoading reverte automaticamente quando snapshot chega.
    this.ctx.map?.setLayerLoading(layer, false);
  }

  stopLayerActivity(_layer: keyof MapLayers): void {
    /* no-op — sem polling client-side */
  }

  syncDataFreshnessWithLayers(): void {
    for (const [layer, sourceIds] of Object.entries(LAYER_TO_SOURCE) as Array<[string, string[] | undefined]>) {
      const enabled = Boolean((this.ctx.mapLayers as Record<string, boolean>)[layer]);
      if (!sourceIds) continue;
      for (const sourceId of sourceIds) {
        dataFreshness.setEnabled(sourceId as DataSourceId, enabled);
      }
    }
  }
}
