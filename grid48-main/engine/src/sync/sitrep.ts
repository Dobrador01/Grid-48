import { db } from '../db';
import { sitrepCache } from '../db/schema';
import { CONVEX_GW_URL, GATEWAY_PSK } from '../config';

export async function proxySitrepRequest(requestId: string, categoria: number, localidade: number) {
  try {
    // 1. Send request to Cloud
    const res = await fetch(`${CONVEX_GW_URL}/sitrep-request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Grid48-GW-Key': GATEWAY_PSK
      },
      body: JSON.stringify({ request_id: requestId, categoria, localidade })
    });

    if (!res.ok) {
      console.error(`[SITREP PROXY] Failed to request cloud, status: ${res.status}`);
      return;
    }
    console.log(`[SITREP PROXY] Sent request ${requestId} to cloud, waiting for processing...`);

    // 2. Poll for response
    let attempts = 0;
    const pollInterval = setInterval(async () => {
      attempts++;
      if (attempts > 12) { // Give up after 2 minutes (10s intervals)
        clearInterval(pollInterval);
        console.warn(`[SITREP PROXY] Timeout waiting for response ${requestId}`);
        return;
      }

      try {
        const checkRes = await fetch(`${CONVEX_GW_URL}/sitrep-response?request_id=${requestId}`, {
          headers: { 'X-Grid48-GW-Key': GATEWAY_PSK }
        });

        if (checkRes.status === 200) {
          const data = (await checkRes.json()) as {
            status: string;
            resposta_valor: number;
            ttl_seconds: number;
          };
          if (data.status === 'ready') {
            clearInterval(pollInterval);
            console.log(`[SITREP PROXY] Response ready for ${requestId}: Valor ${data.resposta_valor}`);
            
            // Save to local cache
            await db.insert(sitrepCache).values({
              requestId: requestId,
              categoria: categoria,
              localidade: localidade,
              respostaValor: data.resposta_valor,
              ttlSeconds: data.ttl_seconds,
              receivedAt: Math.floor(Date.now() / 1000)
            });

            // If we had the radio transmitter connected via serial, 
            // we would transmit the response back here:
            // e.g. currentPort.write(SitrepResponse.toBinary({ ... }))
          }
        }
      } catch (e) {
        console.error(`[SITREP PROXY] Polling error:`, e);
      }
    }, 10000);

  } catch (err) {
    console.error('[SITREP PROXY] Request failed:', err);
  }
}
