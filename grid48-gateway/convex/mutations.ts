import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const ingestTelemetry = internalMutation({
  args: {
    node_id: v.string(),
    packet_id: v.number(),
    timestamp: v.number(),
    lat: v.number(),
    lon: v.number(),
    bitmask_status: v.number(),
    rssi: v.optional(v.number()),
    battery_level: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Deduplication check
    const existing = await ctx.db
      .query("telemetry")
      .withIndex("by_node_packet", (q) =>
        q.eq("node_id", args.node_id).eq("packet_id", args.packet_id)
      )
      .first();

    if (existing) {
      console.log(`[DUPLICATE] Telemetry packet already exists: ${args.node_id}_${args.packet_id}`);
      return existing._id;
    }

    console.log(`[INGEST] New telemetry packet: ${args.node_id}_${args.packet_id}`);
    return await ctx.db.insert("telemetry", args);
  },
});

export const createSitrepRequest = internalMutation({
  args: {
    request_id: v.string(),
    categoria: v.number(),
    localidade: v.number(),
  },
  handler: async (ctx, args) => {
    // Check if exists
    const existing = await ctx.db
      .query("sitrep_queue")
      .withIndex("by_request_id", (q) => q.eq("request_id", args.request_id))
      .first();

    if (existing) {
      return existing._id;
    }

    console.log(`[SITREP] Created new request: ${args.request_id}`);
    return await ctx.db.insert("sitrep_queue", {
      request_id: args.request_id,
      categoria: args.categoria,
      localidade: args.localidade,
      status: "pending",
      expiresAt: Date.now() + 1000 * 60 * 5, // 5 min TTL
    });
  },
});

export const completeSitrep = internalMutation({
  args: {
    request_id: v.string(),
    resposta_valor: v.number(),
    ttl_seconds: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sitrep_queue")
      .withIndex("by_request_id", (q) => q.eq("request_id", args.request_id))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "ready",
        resposta_valor: args.resposta_valor,
        ttl_seconds: args.ttl_seconds,
      });
      console.log(`[SITREP] Completed request: ${args.request_id}`);
    }
  },
});
