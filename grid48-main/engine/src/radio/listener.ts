import { SerialPort } from 'serialport';
import { findRadioPort } from './discovery';
import { db } from '../db';
import { telemetryLocal } from '../db/schema';
// This assumes the protobuf files have been compiled into TS
// For now, we stub the import or use a placeholder if not compiled yet.
// import { TelemetryPacket } from '../../../src/generated/client/grid48/telemetry_pb';

let currentPort: SerialPort | null = null;

export async function startRadioListener() {
  const path = await findRadioPort();
  if (!path) {
    console.log('[RADIO] Running without physical radio connected.');
    return;
  }

  currentPort = new SerialPort({ path, baudRate: 115200 }, (err) => {
    if (err) {
      console.error(`[RADIO] Error opening port ${path}:`, err.message);
    }
  });

  currentPort.on('data', async (data: Buffer) => {
    try {
      console.log(`[RADIO] Received ${data.length} bytes from RF`);
      
      // In a real scenario, this buffer would be decoded by Protobuf.
      // e.g., const packet = TelemetryPacket.fromBinary(data);
      // For this implementation plan, we will simulate the decode since
      // we need the compiled TS files from buf.
      
      /*
      await db.insert(telemetryLocal).values({
        nodeId: packet.nodeId,
        packetId: packet.packetId,
        timestamp: Number(packet.timestamp),
        lat: packet.lat,
        lon: packet.lon,
        bitmaskStatus: packet.bitmaskStatus,
        rssi: packet.rssi,
        batteryLevel: packet.batteryLevel,
        syncStatus: 'pending'
      });
      */
      
    } catch (e) {
      console.error('[RADIO] Failed to decode or save packet:', e);
    }
  });
  
  currentPort.on('error', (err) => {
    console.error('[RADIO] Port error:', err.message);
  });
}
