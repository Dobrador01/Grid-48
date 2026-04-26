import { IDataProvider, TelemetryData } from './types';

const ENGINE_URL = 'http://localhost:3001';

export class LocalProvider implements IDataProvider {
  async initCelesc(callback: (outages: any[]) => void) {
    const fetchCelesc = async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/celesc`);
        if (!res.ok) throw new Error('Engine Celesc failed');
        const data = await res.json();
        if (data && data.outages) {
          callback(data.outages);
        }
      } catch (e) {
        console.warn('[LocalProvider] Celesc fetch error', e);
      }
    };
    
    fetchCelesc();
    setInterval(fetchCelesc, 5 * 60 * 1000);
  }

  async initBeacon(callback: (alerts: any[]) => void) {
    try {
      const { initBeaconClient } = await import('@/services/beacon-client');
      initBeaconClient(callback);
    } catch (e) {
      console.warn('[LocalProvider] Beacon client fallback error', e);
    }
  }

  async initTelemetry(callback: (data: TelemetryData[]) => void) {
    const fetchTelemetry = async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/telemetry`);
        const data = await res.json();
        callback(data);
      } catch (e) {
        console.warn('[LocalProvider] Telemetry fetch error', e);
      }
    };

    fetchTelemetry();
    setInterval(fetchTelemetry, 10 * 1000);
  }

  async getHealthStatus() {
    try {
      const res = await fetch(`${ENGINE_URL}/api/health`);
      return await res.json();
    } catch (e) {
      return { status: 'offline' };
    }
  }
}
