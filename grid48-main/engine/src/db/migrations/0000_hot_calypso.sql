CREATE TABLE `config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sitrep_cache` (
	`request_id` text PRIMARY KEY NOT NULL,
	`categoria` integer NOT NULL,
	`localidade` integer NOT NULL,
	`resposta_valor` integer NOT NULL,
	`ttl_seconds` integer NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operation` text NOT NULL,
	`timestamp` integer NOT NULL,
	`status` text NOT NULL,
	`records_affected` integer NOT NULL,
	`message` text
);
--> statement-breakpoint
CREATE TABLE `telemetry_local` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` text NOT NULL,
	`packet_id` integer NOT NULL,
	`timestamp` integer NOT NULL,
	`lat` integer NOT NULL,
	`lon` integer NOT NULL,
	`bitmask_status` integer NOT NULL,
	`rssi` integer,
	`battery_level` integer,
	`sync_status` text DEFAULT 'pending' NOT NULL
);
