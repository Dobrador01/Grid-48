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
  last_radio_at?: number;
  last_sync_at?: number;
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

export interface IDataProvider {
  initCelesc(callback: (outages: CelescMunicipioPayload[]) => void): Promise<Disposer>;
  initBeacon(callback: (snapshot: BeaconSnapshot) => void): Promise<Disposer>;
  initTelemetry(callback: (data: TelemetryData[]) => void): Promise<Disposer>;
  getHealthStatus(): Promise<HealthStatus>;
}
