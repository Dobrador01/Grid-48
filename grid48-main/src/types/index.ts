export interface Monitor {
  id: string;
  keywords: string[];
  color: string;
  name?: string;
  lat?: number;
  lon?: number;
}

export interface PanelConfig {
  name: string;
  enabled: boolean;
  priority?: number;
}

/**
 * Toggles de layers do mapa Grid 48 — as duas layers efetivamente
 * renderizadas:
 *   - celescOutages: polígonos municipais coloridos por %UCs offline
 *   - weatherAlerts: marcadores Defesa Civil (eventos meteorológicos)
 *
 * `weatherAlerts` é o rename do antigo `weather: true`. App.ts migra a
 * chave automaticamente no load do localStorage.
 */

export interface MapLayers {
  celescOutages: boolean;
  weatherAlerts: boolean;
  // Index signature pra compat com callers que iteram dinamicamente
  // (event-handlers, data-loader) — sempre boolean pra layers Grid 48.
  [key: string]: boolean;
}
