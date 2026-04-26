import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const telemetryLocal = sqliteTable('telemetry_local', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nodeId: text('node_id').notNull(),
  packetId: integer('packet_id').notNull(),
  timestamp: integer('timestamp').notNull(),
  lat: integer('lat').notNull(),
  lon: integer('lon').notNull(),
  bitmaskStatus: integer('bitmask_status').notNull(),
  rssi: integer('rssi'),
  batteryLevel: integer('battery_level'),
  syncStatus: text('sync_status', { enum: ['pending', 'synced'] }).notNull().default('pending'),
});

export const sitrepCache = sqliteTable('sitrep_cache', {
  requestId: text('request_id').primaryKey(),
  categoria: integer('categoria').notNull(),
  localidade: integer('localidade').notNull(),
  respostaValor: integer('resposta_valor').notNull(),
  ttlSeconds: integer('ttl_seconds').notNull(),
  receivedAt: integer('received_at').notNull(),
});

export const syncLog = sqliteTable('sync_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  operation: text('operation', { enum: ['PUSH', 'PULL'] }).notNull(),
  timestamp: integer('timestamp').notNull(),
  status: text('status', { enum: ['SUCCESS', 'ERROR'] }).notNull(),
  recordsAffected: integer('records_affected').notNull(),
  message: text('message'),
});

export const configTable = sqliteTable('config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
