// Services barrel — apenas re-exports ainda em uso pelo Grid 48.
//
// Histórico: era um grande catch-all que re-exportava ~30 services
// WorldMonitor (market, prediction, earthquakes, etc.). Fase 5 da limpeza
// (2026-05) deletou tudo que era worldmonitor-only.
//
// Re-exports atuais cobrem o que App.ts e event-handlers.ts consomem via
// `from '@/services'` (initDB, saveSnapshot, cleanOldSnapshots, etc.).
// Demais services (beacon-client, celesc, i18n, runtime, runtime-config,
// settings-manager, persistent-cache, etc.) são importados por path direto
// pelos seus consumidores — mais explícito e tree-shake friendly.

export * from './storage';

// Services worldmonitor remanescentes (earthquakes, weather, eonet,
// country-instability, etc.) ainda têm callsites em Map.ts/DeckGLMap.ts/
// MapContainer.ts pra layers que NUNCA são renderizadas em Grid 48 (todos
// `false` em FULL_MAP_LAYERS). Continuam re-exportados aqui pra evitar
// quebra ampla até a refatoração de Map/DeckGLMap (Fase 5+, ver
// docs/CLEANUP_PLAN.md).
export * from './earthquakes';
export * from './weather';
export * from './eonet';
export * from './country-instability';
export * from './country-geometry';
export * from './geo-convergence';
export * from './cross-module-integration';
export * from './data-freshness';
export * from './aviation';
export * from './climate';
export * from './economic';
export * from './prediction';
