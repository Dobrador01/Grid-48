import { db } from '../db';
import { telemetryLocal, syncLog } from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { CONVEX_URL, GATEWAY_PSK } from '../config';

export async function runPushSync() {
  try {
    // 1. Get pending items
    const pending = await db.select().from(telemetryLocal).where(eq(telemetryLocal.syncStatus, 'pending')).limit(50);
    
    if (pending.length === 0) {
      return; // Nothing to sync
    }

    console.log(`[SYNC-PUSH] Found ${pending.length} pending telemetry records. Sending to Cloud...`);

    // 2. Send each one (or batch if supported)
    let successCount = 0;
    
    for (const record of pending) {
      const payload = {
        node_id: record.nodeId,
        packet_id: record.packetId,
        timestamp: record.timestamp,
        lat: record.lat,
        lon: record.lon,
        bitmask_status: record.bitmaskStatus,
        rssi: record.rssi,
        battery_level: record.batteryLevel,
      };

      const res = await fetch(`${CONVEX_URL}/gateway`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Grid48-GW-Key': GATEWAY_PSK
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        // Mark as synced
        await db.update(telemetryLocal)
          .set({ syncStatus: 'synced' })
          .where(eq(telemetryLocal.id, record.id));
        successCount++;
      } else {
        console.error(`[SYNC-PUSH] Failed to sync record ${record.id}, HTTP status: ${res.status}`);
      }
    }

    if (successCount > 0) {
      await db.insert(syncLog).values({
        operation: 'PUSH',
        timestamp: Math.floor(Date.now() / 1000),
        status: 'SUCCESS',
        recordsAffected: successCount,
        message: 'Synced telemetry records'
      });
    }

  } catch (err) {
    console.error('[SYNC-PUSH] Error during sync:', err);
    await db.insert(syncLog).values({
      operation: 'PUSH',
      timestamp: Math.floor(Date.now() / 1000),
      status: 'ERROR',
      recordsAffected: 0,
      message: (err as Error).message
    });
  }
}
