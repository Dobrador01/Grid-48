import { EventEmitter } from 'node:events';

/**
 * Process-wide event bus. Producers (radio listener, scrapers, sync workers)
 * emit; the WebSocket server subscribes and fans out to connected clients.
 *
 * Keeping this as a singleton avoids passing the bus through every constructor
 * and lets us decouple producers from the WS adapter.
 */
export type EngineEvent =
  | 'telemetry-update'
  | 'celesc-update'
  | 'beacon-update';

class EngineEventBus extends EventEmitter {}

export const engineEvents = new EngineEventBus();

// Cron + listener traffic can produce many listeners; bump the default 10 to
// avoid spurious "MaxListenersExceededWarning" once we wire WS broadcasting.
engineEvents.setMaxListeners(50);
