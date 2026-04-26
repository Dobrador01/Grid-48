import cron from 'node-cron';
import { startRadioListener } from './radio/listener';
import { runPushSync } from './sync/push';
import { scrapeCelesc } from './scrapers/celesc';
import { runGarbageCollection } from './gc/retention';
import { startServer } from './api/server';

console.log('=== Grid 48 Engine Starting ===');

// Start network and hardware listeners
startServer();
startRadioListener();

// Schedule Background Crons
// Sync push every minute
cron.schedule('* * * * *', () => {
  runPushSync();
});

// Celesc scraper every 5 minutes
cron.schedule('*/5 * * * *', () => {
  scrapeCelesc();
});

// GC at 3 AM every day
cron.schedule('0 3 * * *', () => {
  runGarbageCollection();
});

console.log('=== All Engine Components Initialized ===');
