import { SerialPort } from 'serialport';
import { findRadioPort } from './discovery';
import { db } from '../db';
import { telemetryLocal } from '../db/schema';
import { TelemetryPacket } from '../generated/grid48/telemetry_pb';
import { SitrepRequest } from '../generated/grid48/sitrep_pb';
import { proxySitrepRequest } from '../sync/sitrep';
import { engineEvents } from '../events';

let currentPort: SerialPort | null = null;

/**
 * Wire format (one frame per serialport `data` event):
 *   [type:u8][protobuf payload]
 *
 * Type discriminator is a single byte that selects the message schema:
 *   0x01 → SitrepRequest  (proxy to Convex Cloud)
 *   0x02 → TelemetryPacket (persist locally + emit engineEvent)
 *
 * NOTE: real framing (length prefix or delimiter) is the ESP32 firmware's
 * responsibility (Wave 6). For now we trust each `data` event to be one
 * complete frame; the discovery loop runs at 115200 which is fast enough
 * that LoRa-rate frames arrive contiguously in the kernel buffer.
 */
const TYPE_SITREP_REQUEST = 0x01;
const TYPE_TELEMETRY = 0x02;

async function handleTelemetry(payload: Buffer): Promise<void> {
  const packet = TelemetryPacket.fromBinary(payload);

  const row = {
    nodeId: packet.nodeId,
    packetId: packet.packetId,
    timestamp: Number(packet.timestamp),
    lat: packet.lat,
    lon: packet.lon,
    bitmaskStatus: packet.bitmaskStatus,
    rssi: packet.rssi ?? null,
    batteryLevel: packet.batteryLevel ?? null,
    syncStatus: 'pending' as const,
  };

  await db.insert(telemetryLocal).values(row);
  engineEvents.emit('telemetry-update', row);
  console.log(`[RADIO] Telemetry stored: node=${row.nodeId} packet=${row.packetId}`);
}

async function handleSitrepRequest(payload: Buffer): Promise<void> {
  const req = SitrepRequest.fromBinary(payload);
  console.log(`[RADIO] SITREP request: id=${req.requestId} cat=${req.categoria} loc=${req.localidade}`);
  await proxySitrepRequest(req.requestId, req.categoria, req.localidade);
}

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
      if (data.length < 2) {
        console.warn(`[RADIO] Frame too short (${data.length}b), ignoring`);
        return;
      }
      const type = data[0]!;
      const payload = data.subarray(1);

      switch (type) {
        case TYPE_SITREP_REQUEST:
          await handleSitrepRequest(payload);
          break;
        case TYPE_TELEMETRY:
          await handleTelemetry(payload);
          break;
        default:
          console.warn(`[RADIO] Unknown frame type 0x${type.toString(16)}, ignoring`);
      }
    } catch (e) {
      console.error('[RADIO] Failed to decode or save packet:', e);
    }
  });

  currentPort.on('error', (err) => {
    console.error('[RADIO] Port error:', err.message);
  });
}
