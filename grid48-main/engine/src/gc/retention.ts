import { db } from '../db';
import { telemetryLocal } from '../db/schema';
import { lt } from 'drizzle-orm';

export async function runGarbageCollection() {
  try {
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
    
    // Use Drizzle to delete old records
    await db.delete(telemetryLocal).where(lt(telemetryLocal.timestamp, sevenDaysAgo));
    
    console.log(`[GC] Deleted telemetry records older than 7 days.`);
    
    // In a real scenario, we might also execute:
    // sqlite.pragma('incremental_vacuum(100)');
    // if auto_vacuum is INCREMENTAL.
    
  } catch (err) {
    console.error('[GC] Error running garbage collection:', err);
  }
}
