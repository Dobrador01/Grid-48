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

import type { BeaconSnapshot } from '@/services/beacon-client';

export interface IDataProvider {
  initCelesc(callback: (outages: any[]) => void): void;
  initBeacon(callback: (snapshot: BeaconSnapshot) => void): void;
  initTelemetry(callback: (data: TelemetryData[]) => void): void;
  getHealthStatus(): Promise<{ status: string; uptime?: number; pending_sync?: number }>;
}
