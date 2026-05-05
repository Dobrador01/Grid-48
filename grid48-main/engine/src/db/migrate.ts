import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { DB_PATH } from '../config';

// Resolved against process.cwd() so it works the same in dev (npm run from engine/)
// and in the Docker runner (WORKDIR=/app).
const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'db', 'migrations');

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
const db = drizzle(sqlite);

console.log(`[MIGRATE] Applying migrations from ${MIGRATIONS_DIR} to ${DB_PATH}`);
migrate(db, { migrationsFolder: MIGRATIONS_DIR });
console.log('[MIGRATE] Done.');

sqlite.close();
