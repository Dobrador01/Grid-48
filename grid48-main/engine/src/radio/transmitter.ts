import type { SerialPort } from 'serialport';
import type { FrameType } from './frame';

/**
 * Single shared reference to the open serial port. Both the listener (which
 * owns the lifecycle) and the SITREP proxy (which writes back) need access,
 * but coupling them via direct import would force sync/sitrep.ts to depend on
 * radio/listener.ts and create a cycle. The indirection lives here.
 *
 * If no port is registered (running on dev box without hardware), transmit()
 * warns and drops the frame — callers never need to special-case the absence.
 */
let activePort: SerialPort | null = null;

export function setActivePort(port: SerialPort | null): void {
  activePort = port;
}

export function transmit(type: FrameType, payload: Uint8Array): void {
  if (!activePort) {
    console.warn(`[RADIO-TX] No active port; dropping frame type=0x${type.toString(16)} (${payload.byteLength}B)`);
    return;
  }
  const frame = Buffer.concat([Buffer.from([type]), Buffer.from(payload)]);
  activePort.write(frame, (err) => {
    if (err) console.error('[RADIO-TX] Write failed', err);
    else console.log(`[RADIO-TX] Sent ${frame.length}B (type=0x${type.toString(16)})`);
  });
}
