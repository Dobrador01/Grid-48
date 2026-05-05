import cron from 'node-cron';
import { startRadioListener } from './radio/listener';
import { runPushSync } from './sync/push';
import { runPullSync } from './sync/pull';
import { scrapeCelesc } from './scrapers/celesc';
import { runGarbageCollection } from './gc/retention';
import { startServer } from './api/server';

console.log('=== Grid 48 Engine Starting ===');

// Start network and hardware listeners
startServer();
startRadioListener();

// Cron mutex: a slow run (e.g. PUSH under high latency) must not overlap with the next tick,
// or two workers race on the same `WHERE sync_status='pending'` rows in SQLite.
function withLock(name: string, fn: () => Promise<void>) {
  let running = false;
  return async () => {
    if (running) {
      console.warn(`[CRON:${name}] previous run still in progress — skipping tick`);
      return;
    }
    running = true;
    try {
      await fn();
    } catch (err) {
      console.error(`[CRON:${name}] unhandled error`, err);
    } finally {
      running = false;
    }
  };
}

// Sync push every minute (Engine → Convex Gateway)
cron.schedule('* * * * *', withLock('push', () => runPushSync()));

// Beacon pull every 2 minutes (Convex Beacon → SQLite cache for offline serving)
cron.schedule('*/2 * * * *', withLock('pull-beacon', () => runPullSync()));

// Celesc scraper every 5 minutes (residential IP bypasses Cloudflare blocks)
cron.schedule('*/5 * * * *', withLock('celesc', async () => { await scrapeCelesc(); }));

// GC at 3 AM every day (TZ is set on the container — see docker-compose.yml)
cron.schedule('0 3 * * *', withLock('gc', async () => { await runGarbageCollection(); }));

// Kick off the first beacon pull immediately so /api/beacon-alerts has data
// before the first cron tick (saves the LOCAL frontend from waiting 2 min).
runPullSync().catch((err) => console.error('[BOOT] initial beacon pull failed', err));

console.log('=== All Engine Components Initialized ===');
