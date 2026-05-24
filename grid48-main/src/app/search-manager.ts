import type { AppContext, AppModule } from '@/app/app-context';

// Grid 48 SearchManager
//
// Histórico: WorldMonitor tinha busca global por hotspots, datacenters,
// pipelines, irradiators, tech-companies, finance-geo, etc. (485 linhas).
// Grid 48 não usa nada disso — Celesc/Beacon têm UI própria nos painéis
// laterais.
//
// Mantemos a classe vazia pra retro-compat com App.ts (`new SearchManager(...)`).
// Pode ser deletada por completo numa fase próxima junto com o arquivo
// `search-manager.ts` e a referência em App.ts/app/index.ts.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SearchManagerCallbacks {}

export class SearchManager implements AppModule {
  constructor(_ctx: AppContext, _callbacks: SearchManagerCallbacks = {}) {}

  init(): void {
    /* no-op — Grid 48 sem busca global */
  }

  destroy(): void {
    /* no-op */
  }
}
