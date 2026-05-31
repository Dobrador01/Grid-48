import type { AppContext, AppModule } from '@/app/app-context';

// Grid 48 SearchManager — sem busca global (Celesc/Beacon têm UI própria
// nos painéis). Classe vazia mantida pra retro-compat com App.ts
// (`new SearchManager(...)`).

export type SearchManagerCallbacks = Record<string, never>;

export class SearchManager implements AppModule {
  constructor(_ctx: AppContext, _callbacks: SearchManagerCallbacks = {}) {}

  init(): void {
    /* no-op — Grid 48 sem busca global */
  }

  destroy(): void {
    /* no-op */
  }
}
