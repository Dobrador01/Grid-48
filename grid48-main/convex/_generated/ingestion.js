import { mutation, action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
async function hashText(text) {
    const msgUint8 = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const saveAlert = mutation({
    args: {
        title: v.string(),
        summary: v.string(), // Resumo vindo do gemini -> description na tabela
        source: v.string(),
        category: v.string(),
        severity: v.string(),
        coordinates: v.object({ lat: v.number(), lng: v.number() }),
    },
    handler: async (ctx, args) => {
        const alertId = await ctx.db.insert("alerts", {
            title: args.title,
            description: args.summary,
            source: args.source,
            category: args.category,
            severity: args.severity,
            coordinates: args.coordinates,
            timestamp: Date.now(),
        });
        return alertId;
    },
});
export const ingestRawAlert = action({
    args: {
        text: v.string(),
        source: v.string(),
    },
    handler: async (ctx, args) => {
        const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
        const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
        if (!redisUrl || !redisToken) {
            throw new Error("Missing Upstash Redis environment variables.");
        }
        // Identificador único para a ocorrência
        const hash = await hashText(args.text);
        const key = `grid48:alert:${hash}`;
        // Tenta gravar no Upstash com Expiração de 12 horas (43200 segundos)
        // O modificador NX garante que só grava se não existir
        const res = await fetch(`${redisUrl}/set/${key}/1/EX/43200/NX`, {
            headers: { Authorization: `Bearer ${redisToken}` },
        });
        const data = (await res.json());
        if (data.result !== "OK") {
            // Se não retornou OK, é porque a chave já existia (registro duplicado recente)
            console.log(`Alert already processed recently. Hash: ${hash}`);
            return { status: "skipped", reason: "duplicate_in_cache" };
        }
        // Caso não exista, chama o Gemini para processar
        const geminiResult = await ctx.runAction(api.gemini.processAlert, {
            text: args.text,
        });
        // Salva o alerta estruturado no banco de dados
        const alertId = await ctx.runMutation(api.ingestion.saveAlert, {
            title: geminiResult.title,
            summary: geminiResult.summary,
            source: args.source,
            category: geminiResult.category,
            severity: geminiResult.severity,
            coordinates: geminiResult.coordinates,
        });
        return { status: "success", alertId };
    },
});
