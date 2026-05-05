import { IDataProvider, TelemetryData, Disposer, HealthStatus, SitrepRequestResult, SitrepResponse } from './types';
import type { BeaconSnapshot } from '@/services/beacon-client';
import type { CelescMunicipioPayload } from '@/types/celesc';

export class ConvexProvider implements IDataProvider {
  async initCelesc(callback: (outages: CelescMunicipioPayload[]) => void): Promise<Disposer> {
    const { initCelescPoller } = await import('@/services/celesc');
    return initCelescPoller(callback);
  }

  async initBeacon(callback: (snapshot: BeaconSnapshot) => void): Promise<Disposer> {
    const { initBeaconClient } = await import('@/services/beacon-client');
    initBeaconClient(callback);
    // initBeaconClient owns a singleton ConvexClient with no public teardown today.
    // Returning a no-op is honest: tearing down the page-wide subscription on adapter
    // unmount would require exposing a destroy hook in beacon-client.ts.
    return () => {};
  }

  async initTelemetry(_callback: (data: TelemetryData[]) => void): Promise<Disposer> {
    // Convex telemetry stream not implemented in UI yet (Wave 2: subscribeTelemetry).
    console.log('[ConvexProvider] Telemetry stream initialized (placeholder)');
    return () => {};
  }

  async getHealthStatus(): Promise<HealthStatus> {
    return { status: 'cloud-ok' };
  }

  // SITREP needs the Engine to bridge browser ↔ LoRa. In cloud mode there is
  // no such bridge from the user's browser, so stub these out.
  async requestSitrep(_categoria: number, _localidade: number): Promise<SitrepRequestResult | null> {
    return null;
  }

  async getSitrepResponse(requestId: string): Promise<SitrepResponse> {
    return { status: 'unavailable', request_id: requestId };
  }
}
