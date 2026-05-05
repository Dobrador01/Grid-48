import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { db } from '../db';
import { telemetryLocal, configTable } from '../db/schema';
import { desc, eq, gt } from 'drizzle-orm';
import { ENGINE_PORT } from '../config';
import { readBeaconCache } from '../sync/pull';
import { engineEvents, type EngineEvent } from '../events';

export const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    uptime: process.uptime(),
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
      return c.json(JSON.parse(snapshot[0]!.value));
    } catch {
      return c.json({ error: 'Invalid JSON in DB' }, 500);
    }
  }
  return c.json({ timestamp: 0, outages: [] });
});

app.get('/api/beacon-alerts', async (c) => {
  const cache = await readBeaconCache();
  if (!cache) {
    // Pi may have started before the first PULL completed. Return an empty
    // envelope so the client can render gracefully instead of seeing a 404.
    return c.json({ fetchedAt: 0, alertas: [] });
  }
  return c.json(cache);
});

/**
 * WebSocket /ws — push channel for the LOCAL frontend.
 *
 * On connect: emits the current cached state once so a fresh client renders
 * immediately. Then forwards every engine event (telemetry, celesc, beacon).
 * Each frame is `{ type, payload }`. Producers emit on engineEvents from
 * scrapers, listener, and pull workers — see events.ts.
 */
app.get('/ws', upgradeWebSocket(() => {
  let unsubscribers: Array<() => void> = [];

  return {
    async onOpen(_evt, ws) {
      const beacon = await readBeaconCache();
      if (beacon) ws.send(JSON.stringify({ type: 'beacon-update', payload: beacon }));

      const celesc = await db.select().from(configTable).where(eq(configTable.key, 'celesc_snapshot')).limit(1);
      if (celesc.length > 0) {
        try {
          ws.send(JSON.stringify({ type: 'celesc-update', payload: JSON.parse(celesc[0]!.value) }));
        } catch { /* ignore corrupted snapshot */ }
      }

      const types: EngineEvent[] = ['telemetry-update', 'celesc-update', 'beacon-update'];
      for (const t of types) {
        const handler = (payload: unknown) => {
          try { ws.send(JSON.stringify({ type: t, payload })); } catch { /* socket closed */ }
        };
        engineEvents.on(t, handler);
        unsubscribers.push(() => engineEvents.off(t, handler));
      }
    },
    onClose() {
      for (const unsub of unsubscribers) unsub();
      unsubscribers = [];
    },
  };
}));

export function startServer() {
  console.log(`[API] Starting Engine REST + WS on port ${ENGINE_PORT}`);
  const server = serve({
    fetch: app.fetch,
    port: ENGINE_PORT,
  });
  injectWebSocket(server);
}
