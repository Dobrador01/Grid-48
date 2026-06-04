// ═══════════════════════════════════════════════════════════════════════════
// meshtastic-bridge — Chrome Web Serial → Meshtastic → Convex
// ═══════════════════════════════════════════════════════════════════════════
//
// A aba do dashboard vira o "gateway": conecta na base RAK (USB) via Web Serial,
// decodifica os pacotes Meshtastic (@meshtastic/core) e empurra posição/telemetria
// pro Convex (mutation pública ingestTelemetryPublic). O mapa renderiza pela
// subscription reativa normal (queries:getLatestTelemetry).
//
// Carregado via dynamic import SÓ no clique de "Conectar rádio" (HealthWidget) —
// mantém o bundle principal magro E preserva o user gesture que o
// navigator.serial.requestPort() exige (chamado dentro de TransportWebSerial.create).
//
// Constraints (aceitas): Chromium-only, HTTPS/localhost, só com a aba aberta.
// ═══════════════════════════════════════════════════════════════════════════

import { MeshDevice } from '@meshtastic/core';
import { TransportWebSerial } from '@meshtastic/transport-web-serial';
import { getOrCreateConvexClient } from './beacon-client';

export type RadioStatus = 'connecting' | 'connected' | 'error' | 'disconnected';

export interface RadioHandle {
  disconnect: () => Promise<void>;
}

interface ActiveRadio {
  device: MeshDevice;
  transport: TransportWebSerial;
}

let active: ActiveRadio | null = null;

// Buffers por node num (campo `from` do pacote). Posição, bateria, RSSI/SNR e
// hops chegam em pacotes separados — acumulamos os últimos por nó pra enriquecer
// o push (que é disparado pelo pacote de posição).
const batteryByNode = new Map<number, number>();
const rssiByNode = new Map<number, number>();
const snrByNode = new Map<number, number>();
const hopsByNode = new Map<number, number>();

// Convenção Meshtastic: node id textual = "!" + num em hex de 8 dígitos.
function nodeIdHex(num: number): string {
  return '!' + (num >>> 0).toString(16).padStart(8, '0');
}

interface TelemetryPushInput {
  node_id: string;
  packet_id: number;
  timestamp: number;
  lat: number;
  lon: number;
  rssi?: number;
  battery_level?: number;
  snr?: number;
  hops_away?: number;
}

// Monta o payload OMITINDO rssi/battery_level quando ausentes — Convex
// v.optional(v.number()) rejeita null (pegadinha conhecida do projeto).
async function pushTelemetry(input: TelemetryPushInput): Promise<void> {
  const client = getOrCreateConvexClient();
  if (!client) {
    console.warn('[meshtastic] ConvexClient indisponível — pacote descartado.');
    return;
  }
  const payload: Record<string, number | string> = {
    node_id: input.node_id,
    packet_id: input.packet_id,
    timestamp: input.timestamp,
    lat: input.lat,
    lon: input.lon,
    bitmask_status: 0, // sem semântica definida no milestone 1
  };
  if (Number.isFinite(input.rssi)) payload.rssi = input.rssi as number;
  if (Number.isFinite(input.battery_level)) payload.battery_level = input.battery_level as number;
  if (Number.isFinite(input.snr)) payload.snr = input.snr as number;
  if (Number.isFinite(input.hops_away)) payload.hops_away = input.hops_away as number;

  try {
    // String FunctionReference — mesmo padrão de services/celesc.ts (sem codegen
    // do backend no frontend). ingestTelemetryPublic mora em convex/mutations.ts.
    await (client as unknown as {
      mutation: (name: string, args: unknown) => Promise<unknown>;
    }).mutation('mutations:ingestTelemetryPublic', payload);
  } catch (e) {
    console.warn('[meshtastic] push falhou:', e);
  }
}

/**
 * Conecta na base RAK via Web Serial e começa a empurrar telemetria pro Convex.
 * DEVE ser chamado de dentro de um handler de clique (user gesture) — o
 * requestPort() nativo do Chrome depende disso.
 */
export async function connectRadio(onStatus?: (s: RadioStatus) => void): Promise<RadioHandle> {
  if (active) return { disconnect: disconnectRadio };

  onStatus?.('connecting');
  try {
    // Abre o seletor de porta nativo do Chrome (user gesture).
    const transport = await TransportWebSerial.create();
    const device = new MeshDevice(transport);
    active = { device, transport };

    // Silencia o logger interno (tslog, runtime Node bundizado): ele faz
    // deep-clone/mask dos valores logados chamando Buffer/process/util a cada
    // log — caro e cheio de node-isms no browser. minLevel alto pula tudo ANTES
    // do mask; sub-loggers criados depois herdam o nível. Best-effort.
    try {
      (device.log as unknown as { settings: { minLevel: number } }).settings.minLevel = 7;
    } catch { /* sem logger acessível — o polyfill de Buffer cobre o resto */ }

    // RSSI/SNR e hops só existem no MeshPacket cru (não no PacketMetadata).
    // Buffer por `from`. Obs: rxRssi/rxSnr refletem o ÚLTIMO salto (relay→base)
    // quando hops_away>0 — não o link tag→base. O heatmap por hop filtra por
    // hops_away pra isolar a cobertura direta (0-hop); aqui só guardamos o cru.
    device.events.onMeshPacket.subscribe((pkt: unknown) => {
      const p = pkt as {
        from?: number;
        rxRssi?: number;
        rxSnr?: number;
        hopStart?: number;
        hopLimit?: number;
      };
      if (typeof p.from !== 'number') return;
      if (typeof p.rxRssi === 'number' && p.rxRssi !== 0) rssiByNode.set(p.from, p.rxRssi);
      if (typeof p.rxSnr === 'number' && p.rxSnr !== 0) snrByNode.set(p.from, p.rxSnr);
      // hops_away = hopStart - hopLimit. Ambos presentes a partir do firmware
      // que popula hopStart; 0 = comunicação direta tag↔base.
      if (typeof p.hopStart === 'number' && typeof p.hopLimit === 'number') {
        hopsByNode.set(p.from, Math.max(0, p.hopStart - p.hopLimit));
      }
    });

    // Device metrics (bateria/voltagem) — protobuf-es representa o oneof como
    // { case, value }. Buffer da bateria por nó.
    device.events.onTelemetryPacket.subscribe((meta: unknown) => {
      const m = meta as {
        from?: number;
        data?: { variant?: { case?: string; value?: { batteryLevel?: number } } };
      };
      if (typeof m.from !== 'number') return;
      const variant = m.data?.variant;
      if (variant?.case === 'deviceMetrics' && typeof variant.value?.batteryLevel === 'number') {
        batteryByNode.set(m.from, variant.value.batteryLevel);
      }
    });

    // Posição é o GATILHO do push (bateria/RSSI entram como enriquecimento).
    device.events.onPositionPacket.subscribe((meta: unknown) => {
      const m = meta as {
        id?: number;
        from?: number;
        data?: { latitudeI?: number; longitudeI?: number };
      };
      const from = m.from;
      const pos = m.data;
      if (typeof from !== 'number' || !pos) return;
      if (typeof pos.latitudeI !== 'number' || typeof pos.longitudeI !== 'number') return;
      if (pos.latitudeI === 0 && pos.longitudeI === 0) return; // sem GPS fix

      void pushTelemetry({
        node_id: nodeIdHex(from),
        packet_id: typeof m.id === 'number' && m.id !== 0 ? m.id : Date.now(),
        timestamp: Date.now(),
        lat: pos.latitudeI * 1e-7,
        lon: pos.longitudeI * 1e-7,
        rssi: rssiByNode.get(from),
        battery_level: batteryByNode.get(from),
        snr: snrByNode.get(from),
        hops_away: hopsByNode.get(from),
      });
    });

    // Handshake: dispara o dump de config + node DB. Sem isso os eventos não fluem.
    await device.configure();
    onStatus?.('connected');
    console.log('[meshtastic] rádio conectado e configurado.');
    return { disconnect: disconnectRadio };
  } catch (e) {
    console.error('[meshtastic] falha ao conectar:', e);
    active = null;
    onStatus?.('error');
    throw e;
  }
}

export async function disconnectRadio(): Promise<void> {
  if (!active) return;
  try {
    await active.transport.disconnect();
  } catch (e) {
    console.warn('[meshtastic] erro ao desconectar:', e);
  }
  active = null;
  batteryByNode.clear();
  rssiByNode.clear();
  snrByNode.clear();
  hopsByNode.clear();
}

export function isRadioConnected(): boolean {
  return active !== null;
}
