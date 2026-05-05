import type { BeaconSnapshot } from '@/services/beacon-client';
import type { CelescMunicipioPayload } from '@/types/celesc';

export interface TelemetryData {
  id: number;
  nodeId: string;
  packetId: number;
  timestamp: number;
  lat: number;
  lon: number;
  bitmaskStatus: number;
  rssi?: number;
  batteryLevel?: number;
}

export interface HealthStatus {
  status: string;
  uptime?: number;
  pending_sync?: number;
  last_radio_at?: number | null;
  last_sync_at?: number | null;
  sqlite_size_bytes?: number | null;
  disk_free_bytes?: number | null;
  pendrive_mounted?: boolean | null;
  last_celesc_at?: number | null;
  last_beacon_at?: number | null;
}

/**
 * Data provider abstraction. Two impls:
 *  - ConvexProvider: talks to Convex Cloud (for the Vercel build).
 *  - LocalProvider:  talks to the on-Pi Engine REST (for the Pi build).
 *
 * Each `init*` returns a Promise that resolves to a disposer. Callers store the
 * disposer to clean up intervals/sockets when the App is torn down (variant
 * switch, HMR, desktop window close).
 */
export type Disposer = () => void;

export interface SitrepRequestResult {
  request_id: string;
  status: 'pending';
}

export interface SitrepResponse {
  status: 'ready' | 'pending' | 'unavailable';
  request_id: string;
  categoria?: number;
  localidade?: number;
  resposta_valor?: number;
  ttl_seconds?: number;
  received_at?: number;
}

export interface IDataProvider {
  initCelesc(callback: (outages: CelescMunicipioPayload[]) => void): Promise<Disposer>;
  initBeacon(callback: (snapshot: BeaconSnapshot) => void): Promise<Disposer>;
  initTelemetry(callback: (data: TelemetryData[]) => void): Promise<Disposer>;
  getHealthStatus(): Promise<HealthStatus>;

  // SITREP via radio gateway. Cloud provider stubs as 'unavailable' since
  // there is no Engine path from the browser to the LoRa network in cloud mode.
  requestSitrep(categoria: number, localidade: number): Promise<SitrepRequestResult | null>;
  getSitrepResponse(requestId: string): Promise<SitrepResponse>;
}
