import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { db } from '../db';
import { telemetryLocal, configTable } from '../db/schema';
import { desc, eq, gt } from 'drizzle-orm';
import { ENGINE_PORT } from '../config';

export const app = new Hono();

app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    uptime: process.uptime()
  });
});

app.get('/api/telemetry', async (c) => {
  const sinceStr = c.req.query('since');
  const since = sinceStr ? parseInt(sinceStr, 10) : 0;
  
  const records = await db.select()
    .from(telemetryLocal)
    .where(gt(telemetryLocal.timestamp, since))
    .orderBy(desc(telemetryLocal.timestamp))
    .limit(100);
    
  return c.json(records);
});

app.get('/api/celesc', async (c) => {
  const snapshot = await db.select().from(configTable).where(eq(configTable.key, 'celesc_snapshot')).limit(1);
  if (snapshot.length > 0) {
    try {
      return c.json(JSON.parse(snapshot[0].value));
    } catch (e) {
      return c.json({ error: 'Invalid JSON in DB' }, 500);
    }
  }
  return c.json({ data: [] });
});

export function startServer() {
  console.log(`[API] Starting Engine REST API on port ${ENGINE_PORT}`);
  serve({
    fetch: app.fetch,
    port: ENGINE_PORT
  });
}
