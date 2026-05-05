import { ConvexHttpClient } from 'convex/browser';
import { db } from '../db';
import { configTable, syncLog } from '../db/schema';
import { eq } from 'drizzle-orm';
import { CONVEX_BEACON_URL } from '../config';
import { engineEvents } from '../events';

const BEACON_CACHE_KEY = 'beacon_alerts_snapshot';

interface BeaconAlertRow {
  _id: string;
  guid: string;
  titulo: string;
  nivel_risco: 'Baixo' | 'Medio' | 'Alto';
  cidades_afetadas_ibge: number[];
  expiresAt: number;
  firstSeenAt?: number;
}

interface BeaconCacheEnvelope {
  fetchedAt: number;
  alertas: BeaconAlertRow[];
}

let client: ConvexHttpClient | null = null;

function getClient(): ConvexHttpClient | null {
  if (!CONVEX_BEACON_URL) {
    console.warn('[PULL] CONVEX_BEACON_URL not set — Beacon pull disabled.');
    return null;
  }
  if (!client) client = new ConvexHttpClient(CONVEX_BEACON_URL);
  return client;
}

/**
 * Pulls active Beacon alerts from Convex and writes them to the local cache so
 * that /api/beacon-alerts can serve them while the Pi is offline. Uses string
 * FunctionReference (same pattern as the frontend's beacon-client.ts) since the
 * Engine has no Convex codegen.
 */
export async function runPullSync(): Promise<void> {
  const c = getClient();
  if (!c) return;

  let alertas: BeaconAlertRow[];
  try {
    alertas = (await c.query('queries:listarAlertasAtivos' as any, {})) as BeaconAlertRow[];
    if (!Array.isArray(alertas)) {
      console.warn('[PULL] Beacon returned non-array — keeping last cache.');
      return;
    }
  } catch (err) {
    console.warn('[PULL] Beacon query failed — keeping last cache.', (err as Error).message);
    await db.insert(syncLog).values({
      operation: 'PULL',
      timestamp: Math.floor(Date.now() / 1000),
      status: 'ERROR',
      recordsAffected: 0,
      message: (err as Error).message,
    });
    return;
  }

  const envelope: BeaconCacheEnvelope = { fetchedAt: Date.now(), alertas };
  const json = JSON.stringify(envelope);

  const existing = await db.select().from(configTable).where(eq(configTable.key, BEACON_CACHE_KEY));
  if (existing.length > 0) {
    await db.update(configTable).set({ value: json }).where(eq(configTable.key, BEACON_CACHE_KEY));
  } else {
    await db.insert(configTable).values({ key: BEACON_CACHE_KEY, value: json });
  }

  await db.insert(syncLog).values({
    operation: 'PULL',
    timestamp: Math.floor(Date.now() / 1000),
    status: 'SUCCESS',
    recordsAffected: alertas.length,
    message: `Beacon snapshot refreshed (${alertas.length} alerts)`,
  });

  engineEvents.emit('beacon-update', envelope);
  console.log(`[PULL] Beacon cache refreshed: ${alertas.length} alerts.`);
}

export async function readBeaconCache(): Promise<BeaconCacheEnvelope | null> {
  const row = await db.select().from(configTable).where(eq(configTable.key, BEACON_CACHE_KEY));
  if (row.length === 0) return null;
  try {
    return JSON.parse(row[0]!.value) as BeaconCacheEnvelope;
  } catch {
    return null;
  }
}
