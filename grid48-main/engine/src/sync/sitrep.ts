import { db } from '../db';
import { sitrepCache } from '../db/schema';
import { CONVEX_URL, GATEWAY_PSK } from '../config';
import { SitrepResponse } from '../generated/grid48/sitrep_pb';
import { transmit } from '../radio/transmitter';
import { TYPE_SITREP_RESPONSE } from '../radio/frame';

const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 12; // 12 × 10s = 2 min, mirrors the UI timeout

/**
 * Proxies a SITREP request that arrived over the radio to Convex Cloud,
 * polls for the AI-generated answer, persists the result locally, and
 * transmits the response back over the radio so the requesting node sees it.
 *
 * The local SQLite cache (`sitrep_cache`) is what /api/sitrep-response/:id
 * reads from when the UI polls — same source of truth for both paths.
 */
export async function proxySitrepRequest(
  requestId: string,
  categoria: number,
  localidade: number,
): Promise<void> {
  try {
    const res = await fetch(`${CONVEX_URL}/sitrep-request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Grid48-GW-Key': GATEWAY_PSK,
      },
      body: JSON.stringify({ request_id: requestId, categoria, localidade }),
    });

    if (!res.ok) {
      console.error(`[SITREP PROXY] Cloud rejected request ${requestId} (HTTP ${res.status})`);
      return;
    }
    console.log(`[SITREP PROXY] Forwarded ${requestId} to cloud, polling for answer...`);

    let attempts = 0;
    const pollInterval = setInterval(async () => {
      attempts++;
      if (attempts > MAX_POLL_ATTEMPTS) {
        clearInterval(pollInterval);
        console.warn(`[SITREP PROXY] Timeout (${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s) waiting for ${requestId}`);
        return;
      }

      try {
        const checkRes = await fetch(`${CONVEX_URL}/sitrep-response?request_id=${requestId}`, {
          headers: { 'X-Grid48-GW-Key': GATEWAY_PSK },
        });

        if (checkRes.status !== 200) return;

        const data = (await checkRes.json()) as {
          status: string;
          resposta_valor: number;
          ttl_seconds: number;
        };
        if (data.status !== 'ready') return;

        clearInterval(pollInterval);
        console.log(`[SITREP PROXY] Answer for ${requestId}: valor=${data.resposta_valor} ttl=${data.ttl_seconds}s`);

        // 1) Persist locally — UI polling endpoint reads from this same table.
        await db.insert(sitrepCache).values({
          requestId,
          categoria,
          localidade,
          respostaValor: data.resposta_valor,
          ttlSeconds: data.ttl_seconds,
          receivedAt: Math.floor(Date.now() / 1000),
        });

        // 2) Transmit back over the radio so the requesting node hears it.
        //    Encoded as SitrepResponse protobuf; receiver matches by request_id.
        const response = new SitrepResponse({
          requestId,
          categoria,
          localidade,
          valor: data.resposta_valor,
          ttlSeconds: data.ttl_seconds,
        });
        transmit(TYPE_SITREP_RESPONSE, response.toBinary());
      } catch (e) {
        console.error('[SITREP PROXY] Poll error:', e);
      }
    }, POLL_INTERVAL_MS);
  } catch (err) {
    console.error('[SITREP PROXY] Request failed:', err);
  }
}
