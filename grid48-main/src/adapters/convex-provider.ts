import { IDataProvider, TelemetryData } from './types';
import type { BeaconSnapshot } from '@/services/beacon-client';

export class ConvexProvider implements IDataProvider {
  async initCelesc(callback: (outages: any[]) => void) {
    const { initCelescPoller } = await import('@/services/celesc');
    initCelescPoller(callback);
  }

  async initBeacon(callback: (snapshot: BeaconSnapshot) => void) {
    const { initBeaconClient } = await import('@/services/beacon-client');
    initBeaconClient(callback);
  }

  async initTelemetry(_callback: (data: TelemetryData[]) => void) {
    // Convex telemetry stream not implemented in UI yet
    console.log('[ConvexProvider] Telemetry stream initialized (placeholder)');
  }

  async getHealthStatus() {
    return { status: 'cloud-ok' };
  }
}
