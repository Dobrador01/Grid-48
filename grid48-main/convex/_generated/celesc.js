/**
 * Celesc Infrastructure Sensor — Convex Backend
 *
 * Server-side polling, parsing, anti-hysteresis buffer, and reactive query
 * for Celesc power grid outage data (Santa Catarina).
 *
 * Architecture:
 *   - pollCelesc (action): fetches mapa.js + tabelas.js, parses, calls upsertOutages
 *   - upsertOutages (mutation): upserts per-municipality data with circular readings buffer
 *   - getOutages (query): reactive subscription for frontend
 */
import { query, internalAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
// ─── Helpers ────────────────────────────────────────────────────────────────
/** Remove diacritics and uppercase a string for normalized comparison */
function normalize(s) {
    return s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .trim();
}
/** Extract municipality data from the ds_informacao HTML string in mapa.js */
function parseMapaInfo(html) {
    // Nome: inside first <th ...>NAME</th>
    const nameMatch = html.match(/<th[^>]*>([^<]+)<\/th>/i);
    // Total UCs & UCs sem energia: first two <b> tags
    const boldMatches = [...html.matchAll(/<b[^>]*>\s*([\d.,]+)\s*<\/b>/gi)];
    if (!nameMatch || boldMatches.length < 2)
        return null;
    const nome = nameMatch[1].trim();
    const totalUcs = parseInt(boldMatches[0][1].replace(/[.,]/g, ""), 10) || 0;
    const ucsSemEnergia = parseInt(boldMatches[1][1].replace(/[.,]/g, ""), 10) || 0;
    return { nome, totalUcs, ucsSemEnergia };
}
/** Compute anti-hysteresis trend from readings buffer */
function computeTendencia(buffer) {
    if (buffer.length < 3)
        return "ESTÁVEL";
    // Compare average of oldest half vs newest half
    const mid = Math.floor(buffer.length / 2);
    const olderSlice = buffer.slice(0, mid);
    const newerSlice = buffer.slice(-mid);
    const olderAvg = olderSlice.reduce((a, b) => a + b, 0) / olderSlice.length;
    const newerAvg = newerSlice.reduce((a, b) => a + b, 0) / newerSlice.length;
    const delta = newerAvg - olderAvg;
    // Threshold: at least 2 UCs difference to avoid noise
    if (delta > 2)
        return "PIORANDO";
    if (delta < -2)
        return "MELHORANDO";
    return "ESTÁVEL";
}
// ─── Action: Fetch & Parse Celesc Data ──────────────────────────────────────
export const pollCelesc = internalAction({
    args: {},
    handler: async (ctx) => {
        console.log("[Celesc] Starting poll cycle...");
        // ── Fetch A: mapa.js ──
        let mapaMunicipios = new Map();
        try {
            const mapaRes = await fetch("https://celgeoweb.celesc.com.br/json/mapa.js");
            const mapaText = await mapaRes.text();
            // Strip prefix "var mapaIndicador = " and trailing ";"
            const mapaJson = mapaText
                .replace(/^var\s+mapaIndicador\s*=\s*/, "")
                .replace(/;\s*$/, "");
            const mapaData = JSON.parse(mapaJson);
            if (mapaData.municipios && Array.isArray(mapaData.municipios)) {
                for (const mun of mapaData.municipios) {
                    const info = parseMapaInfo(mun.ds_informacao || "");
                    if (info) {
                        mapaMunicipios.set(normalize(info.nome), {
                            totalUcs: info.totalUcs,
                            ucsAfetadas: info.ucsSemEnergia,
                        });
                    }
                }
            }
            console.log(`[Celesc] Fetch A: parsed ${mapaMunicipios.size} municípios from mapa.js`);
        }
        catch (err) {
            console.error("[Celesc] Fetch A (mapa.js) failed:", err);
        }
        // ── Fetch B: tabelas.js (bairros cascade) ──
        let timestamp = new Date().toISOString();
        const bairrosByMunicipio = new Map();
        try {
            const tabelasRes = await fetch("https://celgeoweb.celesc.com.br/json/tabelas.js");
            const tabelasText = await tabelasRes.text();
            // Strip prefix "var visaoGeralPublico = " and trailing ";"
            const tabelasJson = tabelasText
                .replace(/^var\s+visaoGeralPublico\s*=\s*/, "")
                .replace(/;\s*$/, "");
            const tabelasData = JSON.parse(tabelasJson);
            // Extract timestamp
            if (tabelasData.DATA) {
                timestamp = String(tabelasData.DATA);
            }
            // Navigate REGIONAIS -> CIDADES -> BAIRROS
            const regionais = tabelasData.REGIONAIS;
            if (Array.isArray(regionais)) {
                for (const regional of regionais) {
                    const cidades = regional.CIDADES;
                    if (!Array.isArray(cidades))
                        continue;
                    for (const cidade of cidades) {
                        const cidadeNome = normalize(cidade.NOME || cidade.CIDADE || "");
                        if (!cidadeNome)
                            continue;
                        const bairros = cidade.BAIRROS;
                        if (!Array.isArray(bairros))
                            continue;
                        const affected = [];
                        for (const bairro of bairros) {
                            const qty = Number(bairro.QUANTIDADE_ACIDENTAL) || 0;
                            if (qty > 0) {
                                affected.push({
                                    nome: String(bairro.NOME || bairro.BAIRRO || ""),
                                    ucs: qty,
                                });
                            }
                        }
                        if (affected.length > 0) {
                            const existing = bairrosByMunicipio.get(cidadeNome) || [];
                            bairrosByMunicipio.set(cidadeNome, [
                                ...existing,
                                ...affected,
                            ]);
                        }
                    }
                }
            }
            console.log(`[Celesc] Fetch B: found ${bairrosByMunicipio.size} municípios with affected bairros`);
        }
        catch (err) {
            console.error("[Celesc] Fetch B (tabelas.js) failed:", err);
        }
        // ── Merge into unified payload ──
        const allMunicipios = new Set([
            ...mapaMunicipios.keys(),
            ...bairrosByMunicipio.keys(),
        ]);
        const payloads = [];
        for (const mun of allMunicipios) {
            const mapaData = mapaMunicipios.get(mun);
            const bairros = bairrosByMunicipio.get(mun) || [];
            const totalUcs = mapaData?.totalUcs ?? 0;
            const ucsAfetadas = mapaData?.ucsAfetadas ??
                bairros.reduce((sum, b) => sum + b.ucs, 0);
            payloads.push({
                municipio: mun,
                totalUcs,
                ucsAfetadas,
                bairrosAfetados: bairros.sort((a, b) => b.ucs - a.ucs),
            });
        }
        // ── Upsert to Convex DB via mutation ──
        if (payloads.length > 0) {
            await ctx.runMutation(internal.celesc.upsertOutages, {
                municipios: payloads.map((p) => ({
                    municipio: p.municipio,
                    totalUcs: p.totalUcs,
                    ucsAfetadas: p.ucsAfetadas,
                    bairrosAfetados: p.bairrosAfetados,
                })),
                timestamp,
            });
            console.log(`[Celesc] Upserted ${payloads.length} municípios. Timestamp: ${timestamp}`);
        }
        else {
            console.log("[Celesc] No data to upsert.");
        }
    },
});
// ─── Mutation: Upsert outage data with anti-hysteresis buffer ───────────────
export const upsertOutages = internalMutation({
    args: {
        municipios: v.array(v.object({
            municipio: v.string(),
            totalUcs: v.number(),
            ucsAfetadas: v.number(),
            bairrosAfetados: v.array(v.object({ nome: v.string(), ucs: v.number() })),
        })),
        timestamp: v.string(),
    },
    handler: async (ctx, args) => {
        const now = Date.now();
        for (const mun of args.municipios) {
            // Look up existing record
            const existing = await ctx.db
                .query("celescOutages")
                .withIndex("by_municipio", (q) => q.eq("municipio", mun.municipio))
                .first();
            // Build circular buffer (max 5 readings)
            const prevBuffer = existing?.readingsBuffer ?? [];
            const newBuffer = [...prevBuffer, mun.ucsAfetadas].slice(-5);
            // Compute tendency
            const tendenciaDelta = computeTendencia(newBuffer);
            // Compute percentage
            const porcentagemAfetada = mun.totalUcs > 0
                ? Math.round((mun.ucsAfetadas / mun.totalUcs) * 10000) / 100
                : 0;
            if (existing) {
                await ctx.db.patch(existing._id, {
                    totalUcs: mun.totalUcs,
                    ucsAfetadas: mun.ucsAfetadas,
                    porcentagemAfetada,
                    tendenciaDelta,
                    bairrosAfetados: mun.bairrosAfetados,
                    readingsBuffer: newBuffer,
                    timestampLeitura: args.timestamp,
                    updatedAt: now,
                });
            }
            else {
                await ctx.db.insert("celescOutages", {
                    municipio: mun.municipio,
                    totalUcs: mun.totalUcs,
                    ucsAfetadas: mun.ucsAfetadas,
                    porcentagemAfetada,
                    tendenciaDelta,
                    bairrosAfetados: mun.bairrosAfetados,
                    readingsBuffer: newBuffer,
                    timestampLeitura: args.timestamp,
                    updatedAt: now,
                });
            }
        }
    },
});
// ─── Query: Reactive subscription for frontend ──────────────────────────────
export const getOutages = query({
    args: {},
    handler: async (ctx) => {
        const outages = await ctx.db.query("celescOutages").collect();
        return outages.map((o) => ({
            municipio: o.municipio,
            totalUcs: o.totalUcs,
            ucsAfetadas: o.ucsAfetadas,
            porcentagemAfetada: o.porcentagemAfetada,
            tendenciaDelta: o.tendenciaDelta,
            bairrosAfetados: o.bairrosAfetados,
            timestampLeitura: o.timestampLeitura,
        }));
    },
});
