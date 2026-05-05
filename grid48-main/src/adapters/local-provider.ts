import { IDataProvider, TelemetryData, Disposer, HealthStatus } from './types';
import type { BeaconSnapshot } from '@/services/beacon-client';
import type { CelescMunicipioPayload } from '@/types/celesc';

const ENGINE_URL = 'http://localhost:3001';

interface CelescSnapshotEnvelope {
  timestamp: number;
  outages: CelescMunicipioPayload[];
}

export class LocalProvider implements IDataProvider {
  async initCelesc(callback: (outages: CelescMunicipioPayload[]) => void): Promise<Disposer> {
    const fetchCelesc = async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/celesc`);
        if (!res.ok) throw new Error('Engine Celesc failed');
        const data = (await res.json()) as Partial<CelescSnapshotEnvelope>;
        if (data && Array.isArray(data.outages)) {
          callback(data.outages);
        }
      } catch (e) {
        console.warn('[LocalProvider] Celesc fetch error', e);
      }
    };

    fetchCelesc();
    const intervalId = window.setInterval(fetchCelesc, 5 * 60 * 1000);
    return () => clearInterval(intervalId);
  }

  async initBeacon(callback: (snapshot: BeaconSnapshot) => void): Promise<Disposer> {
    // TODO (Wave 2): replace with /api/beacon-alerts polling against the Engine
    // so LOCAL mode does not need internet for Beacon. Today, when offline, this
    // path will never receive snapshots — Engine has no Beacon cache yet.
    try {
      const { initBeaconClient } = await import('@/services/beacon-client');
      initBeaconClient(callback);
    } catch (e) {
      console.warn('[LocalProvider] Beacon client fallback error', e);
    }
    return () => {};
  }

  async initTelemetry(callback: (data: TelemetryData[]) => void): Promise<Disposer> {
    const fetchTelemetry = async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/telemetry`);
        const data = (await res.json()) as TelemetryData[];
        callback(data);
      } catch (e) {
        console.warn('[LocalProvider] Telemetry fetch error', e);
      }
    };

    fetchTelemetry();
    const intervalId = window.setInterval(fetchTelemetry, 10 * 1000);
    return () => clearInterval(intervalId);
  }

  async getHealthStatus(): Promise<HealthStatus> {
    try {
      const res = await fetch(`${ENGINE_URL}/api/health`);
      return (await res.json()) as HealthStatus;
    } catch {
      return { status: 'offline' };
    }
  }
}
