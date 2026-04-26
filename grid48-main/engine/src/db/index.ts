import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { DB_PATH } from '../config';
import fs from 'fs';
import path from 'path';

// Ensure dir exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const sqlite = new Database(DB_PATH);
// WAL mode for better concurrency and resilience
sqlite.pragma('journal_mode = WAL');

export const db = drizzle(sqlite, { schema });
