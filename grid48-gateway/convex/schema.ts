import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  telemetry: defineTable({
    node_id: v.string(),
    packet_id: v.number(),
    timestamp: v.number(),
    lat: v.number(),
    lon: v.number(),
    bitmask_status: v.number(),
    rssi: v.optional(v.number()),
    battery_level: v.optional(v.number()),
  })
    .index("by_node_packet", ["node_id", "packet_id"])
    .index("by_timestamp", ["timestamp"]),

  sitrep_queue: defineTable({
    request_id: v.string(),
    categoria: v.number(), // Enum
    localidade: v.number(), // Enum
    status: v.string(), // "pending", "ready", "expired"
    resposta_valor: v.optional(v.number()),
    ttl_seconds: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  })
    .index("by_request_id", ["request_id"])
    .index("by_status", ["status"]),
});
