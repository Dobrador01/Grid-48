// Grid 48 services barrel — apenas re-export do storage (initDB,
// saveSnapshot, cleanOldSnapshots) ainda consumido por App.ts.
//
// Demais services (beacon-client, celesc, i18n, runtime, runtime-config,
// settings-manager, persistent-cache, analytics, data-freshness, etc.)
// importados por path direto.

export * from './storage';
