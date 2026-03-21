import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({
    alerts: defineTable({
        title: v.string(),
        description: v.string(),
        source: v.string(),
        category: v.string(),
        severity: v.string(),
        coordinates: v.object({ lat: v.number(), lng: v.number() }),
        timestamp: v.number(),
    }),
    registrations: defineTable({
        email: v.string(),
        normalizedEmail: v.string(),
        registeredAt: v.number(),
        source: v.optional(v.string()),
        appVersion: v.optional(v.string()),
        referralCode: v.optional(v.string()),
        referredBy: v.optional(v.string()),
        referralCount: v.optional(v.number()),
    })
        .index("by_normalized_email", ["normalizedEmail"])
        .index("by_referral_code", ["referralCode"]),
    contactMessages: defineTable({
        name: v.string(),
        email: v.string(),
        organization: v.optional(v.string()),
        phone: v.optional(v.string()),
        message: v.optional(v.string()),
        source: v.string(),
        receivedAt: v.number(),
    }),
    counters: defineTable({
        name: v.string(),
        value: v.number(),
    }).index("by_name", ["name"]),
    celescOutages: defineTable({
        municipio: v.string(),
        totalUcs: v.number(),
        ucsAfetadas: v.number(),
        porcentagemAfetada: v.number(),
        tendenciaDelta: v.string(), // "ESTÁVEL" | "PIORANDO" | "MELHORANDO"
        bairrosAfetados: v.array(v.object({ nome: v.string(), ucs: v.number() })),
        // Circular buffer: last 5 readings of ucsAfetadas for anti-hysteresis
        readingsBuffer: v.array(v.number()),
        timestampLeitura: v.string(), // ISO timestamp from Celesc data
        updatedAt: v.number(),
    }).index("by_municipio", ["municipio"]),
});
