import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { DB_PATH } from '../config';

// DB_PATH must point inside /app/data, which the entrypoint enforces is a mountpoint.
// Do not auto-create the parent directory: a missing /app/data means the pendrive failed
// to mount, and silently writing to the container overlay would land on the SD card.
const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');

export const db = drizzle(sqlite, { schema });
