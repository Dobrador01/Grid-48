import type { AppContext, AppModule } from '@/app/app-context';
import type { MapLayers } from '@/types';

// Grid 48 carrega dados via DataProvider (Convex) em App.ts. Este manager
// mantém os hooks de ciclo de vida (loadAllData/loadDataForLayer) que o
// refresh-scheduler e o layer-toggle invocam.

export interface DataLoaderCallbacks {
  refreshOpenCountryBrief: () => void;
}

export class DataLoaderManager implements AppModule {
  private ctx: AppContext;

  public updateSearchIndex: () => void = () => {};

  constructor(ctx: AppContext, _callbacks: DataLoaderCallbacks) {
    this.ctx = ctx;
  }

  init(): void {}

  destroy(): void {}

  async loadAllData(): Promise<void> {
    this.updateSearchIndex();
  }

  async loadDataForLayer(layer: string): Promise<void> {
    if (this.ctx.isDestroyed) return;
    this.ctx.map?.setLayerLoading(layer, true);
    this.ctx.map?.setLayerLoading(layer, false);
  }

  stopLayerActivity(_layer: keyof MapLayers): void {}
}
