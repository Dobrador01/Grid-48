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

export interface IDataProvider {
  initCelesc(callback: (outages: any[]) => void): void;
  initBeacon(callback: (alerts: any[]) => void): void;
  initTelemetry(callback: (data: TelemetryData[]) => void): void;
  getHealthStatus(): Promise<{ status: string; uptime?: number; pending_sync?: number }>;
}
