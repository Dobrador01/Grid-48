/**
 * Wire format used over the LoRa serial link in both directions:
 *
 *   [type:u8][protobuf payload]
 *
 * Type discriminator is one byte. Producers (listener for RX, transmitter for
 * TX) and consumers (radio handlers, sync/sitrep proxy) agree on this table.
 *
 * Direction column is informational — the wire itself is symmetric.
 */
export const TYPE_SITREP_REQUEST = 0x01;   // node → engine
export const TYPE_TELEMETRY = 0x02;        // node → engine
export const TYPE_SITREP_RESPONSE = 0x03;  // engine → node

export type FrameType =
  | typeof TYPE_SITREP_REQUEST
  | typeof TYPE_TELEMETRY
  | typeof TYPE_SITREP_RESPONSE;
