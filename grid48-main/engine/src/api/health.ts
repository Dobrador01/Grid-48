import { promises as fs } from 'node:fs';
import { db } from '../db';
import { telemetryLocal, syncLog } from '../db/schema';
import { eq, sql, and, desc } from 'drizzle-orm';
import { DB_PATH } from '../config';

export interface EngineHealth {
  status: 'ok' | 'degraded';
  uptime: number;

  // Sync state
  pending_sync: number;
  last_sync_at: number | null;        // epoch seconds, last successful PUSH
  last_radio_at: number | null;       // epoch seconds, latest telemetry timestamp seen

  // Storage
  sqlite_size_bytes: number | null;
  disk_free_bytes: number | null;
  pendrive_mounted: boolean | null;   // null on non-linux

  // Snapshot freshness
  last_celesc_at: number | null;      // epoch ms, parsed from envelope
  last_beacon_at: number | null;      // epoch ms, parsed from envelope
}

async function readPendriveMounted(): Promise<boolean | null> {
  try {
    const mounts = await fs.readFile('/proc/mounts', 'utf8');
    return / \/app\/data /.test(mounts);
  } catch {
    return null;
  }
}

async function readSqliteSize(): Promise<number | null> {
  try {
    const stat = await fs.stat(DB_PATH);
    return stat.size;
  } catch {
    return null;
  }
}

async function readDiskFree(): Promise<number | null> {
  try {
    // fs.statfs is Node 18.15+; engine runs Node 20.
    const statfs = (fs as unknown as { statfs?: (p: string) => Promise<{ bavail: bigint; bsize: bigint }> }).statfs;
    if (!statfs) return null;
    const s = await statfs('/app/data');
    return Number(s.bavail * s.bsize);
  } catch {
    return null;
  }
}

async function readSnapshotTimestamp(key: string, field: 'timestamp' | 'fetchedAt'): Promise<number | null> {
  // Snapshots in configTable are JSON envelopes — parse cheaply, ignore corruption.
  const { configTable } = await import('../db/schema');
  const row = await db.select().from(configTable).where(eq(configTable.key, key)).limit(1);
  if (row.length === 0) return null;
  try {
    const parsed = JSON.parse(row[0]!.value) as Record<string, unknown>;
    const v = parsed[field];
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

export async function computeHealth(): Promise<EngineHealth> {
  const [pendingRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(telemetryLocal)
    .where(eq(telemetryLocal.syncStatus, 'pending'));

  const [lastRadioRow] = await db
    .select({ ts: sql<number>`max(${telemetryLocal.timestamp})` })
    .from(telemetryLocal);

  const [lastPushRow] = await db
    .select({ ts: syncLog.timestamp })
    .from(syncLog)
    .where(and(eq(syncLog.operation, 'PUSH'), eq(syncLog.status, 'SUCCESS')))
    .orderBy(desc(syncLog.timestamp))
    .limit(1);

  const [
    pendriveMounted,
    sqliteSize,
    diskFree,
    lastCelescAt,
    lastBeaconAt,
  ] = await Promise.all([
    readPendriveMounted(),
    readSqliteSize(),
    readDiskFree(),
    readSnapshotTimestamp('celesc_snapshot', 'timestamp'),
    readSnapshotTimestamp('beacon_alerts_snapshot', 'fetchedAt'),
  ]);

  const pending = pendingRow?.count ?? 0;
  // 'degraded' is a soft signal for the widget — backlog growing or pendrive
  // missing. Hard failures bubble up via thrown errors / non-200 responses.
  const status: 'ok' | 'degraded' = pending > 100 || pendriveMounted === false ? 'degraded' : 'ok';

  return {
    status,
    uptime: process.uptime(),
    pending_sync: pending,
    last_sync_at: lastPushRow?.ts ?? null,
    last_radio_at: lastRadioRow?.ts ?? null,
    sqlite_size_bytes: sqliteSize,
    disk_free_bytes: diskFree,
    pendrive_mounted: pendriveMounted,
    last_celesc_at: lastCelescAt,
    last_beacon_at: lastBeaconAt,
  };
}
