import { SerialPort } from 'serialport';
import { KNOWN_RADIO_DEVICES } from '../config';

export async function findRadioPort(): Promise<string | null> {
  try {
    const ports = await SerialPort.list();
    for (const port of ports) {
      if (port.vendorId && port.productId) {
        const vid = port.vendorId.toUpperCase();
        const pid = port.productId.toUpperCase();
        
        const match = KNOWN_RADIO_DEVICES.find(d => d.vid === vid && d.pid === pid);
        if (match) {
          console.log(`[RADIO] Auto-Discovery found ${match.name} on ${port.path}`);
          return port.path;
        }
      }
    }
    console.warn('[RADIO] Auto-Discovery: No known radio device found.');
    return null;
  } catch (err) {
    console.error('[RADIO] Error discovering serial ports:', err);
    return null;
  }
}
