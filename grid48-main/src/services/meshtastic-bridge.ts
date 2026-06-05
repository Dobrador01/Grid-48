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

import { MeshDevice, Protobuf } from '@meshtastic/core';
import { TransportWebSerial } from '@meshtastic/transport-web-serial';
import { create } from '@bufbuild/protobuf';
import { getOrCreateConvexClient } from './beacon-client';

// Os tipos de `@meshtastic/protobufs` vêm BUNDLED no core (re-exportados como
// `Protobuf`) mas o pacote não está instalado como módulo separado, então o tsc
// não resolve `Protobuf.Config.Config` etc. Seguindo o padrão da ponte (casts
// pontuais), tratamos o namespace e o `create` de forma frouxa SÓ na montagem
// das mensagens de config. Runtime é 100% válido (paths verificados no bundle).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P = Protobuf as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mk = create as unknown as (schema: unknown, init: unknown) => any;

export type RadioStatus = 'connecting' | 'connected' | 'error' | 'disconnected';

export interface RadioHandle {
  disconnect: () => Promise<void>;
}

interface ActiveRadio {
  device: MeshDevice;
  transport: TransportWebSerial;
}

let active: ActiveRadio | null = null;
// Callback de status do widget — guardado pra poder sinalizar desconexão
// assíncrona (USB removido) fora do fluxo do connectRadio.
let statusCb: ((s: RadioStatus) => void) | null = null;
// Listener global de remoção física da porta serial (registrado 1x).
let serialDisconnectWired = false;

// DeviceStatusEnum do @meshtastic/core: 2 = DeviceDisconnected.
const DEVICE_DISCONNECTED = 2;

// Trata a queda da conexão (USB removido, porta fechada). Idempotente.
function handleRadioLost(): void {
  if (!active) return;
  console.log('[meshtastic] conexão perdida — limpando estado.');
  active = null;
  batteryByNode.clear();
  rssiByNode.clear();
  snrByNode.clear();
  hopsByNode.clear();
  posByNode.clear();
  lastPushByNode.clear();
  meshNodes.clear();
  configSnapshot = {};
  localMetrics = {};
  const cb = statusCb;
  statusCb = null;
  cb?.('disconnected');
}


// Buffers por node num (campo `from` do pacote). Posição, bateria, RSSI/SNR e
// hops chegam em pacotes separados — acumulamos os últimos por nó pra enriquecer
// o push (que é disparado pelo pacote de posição).
const batteryByNode = new Map<number, number>();
const rssiByNode = new Map<number, number>();
const snrByNode = new Map<number, number>();
const hopsByNode = new Map<number, number>();
// Última posição conhecida por nó (lat/lon graus). Bug fix: o push pra Convex
// era disparado SÓ por pacote de posição — uma tag parada quase não emite
// posição, então o dado congelava (só destravava ao reconectar, quando o
// configure() força o re-anúncio). Guardamos a posição pra poder dar um
// "refresh de liveness" quando QUALQUER pacote chega (mesh/telemetry), com
// throttle por nó pra não inflar a tabela append-only nem o recompute DEFCON.
const posByNode = new Map<number, { lat: number; lon: number }>();
const lastPushByNode = new Map<number, number>();
const LIVENESS_THROTTLE_MS = 60_000;

// ── Snapshot de config do device (Fase D) ──────────────────────────────────
// Capturado durante o handshake `configure()` (que despeja config + node DB).
// Serve pra PRÉ-PREENCHER o formulário da aba "Rádio" — o user edita em cima
// do estado real do device, não de um form vazio.
export interface RadioConfigSnapshot {
  myNodeNum?: number;
  ownerLongName?: string;
  ownerShortName?: string;
  region?: number;          // Config.LoRaConfig.RegionCode
  modemPreset?: number;     // Config.LoRaConfig.ModemPreset
  hopLimit?: number;        // Config.LoRaConfig.hopLimit (saltos máximos, 1..7)
  fixedPosition?: boolean;
  positionBroadcastSecs?: number;
  gpsUpdateInterval?: number;     // s entre fixes do GPS
  gpsMode?: number;               // PositionConfig.GpsMode (0=disabled,1=enabled,2=not_present)
  smartBroadcast?: boolean;       // position_broadcast_smart_enabled (move→frequente, parado→throttle)
  smartMinDist?: number;          // broadcast_smart_minimum_distance (m)
  smartMinIntervalSecs?: number;  // broadcast_smart_minimum_interval_secs
  telemetryIntervalSecs?: number; // s entre broadcasts de device metrics
  buzzerEnabled?: boolean;        // módulo de notificação externa (buzzer/LED)
  channelName?: string;
  channelPskB64?: string;   // PSK do canal 0 em base64 (bytes crus na wire)
  publicChannelActive?: boolean; // canal 1 = LongFast público (SECONDARY) configurado?
}
let configSnapshot: RadioConfigSnapshot = {};

// Métricas do próprio RAK (vêm no deviceMetrics da telemetria periódica dele).
export interface LocalRadioMetrics {
  airUtilTx?: number;         // % do tempo que ESTE nó passou transmitindo (inclui relay)
  channelUtilization?: number; // % do tempo que o canal esteve ocupado
  voltage?: number;
  uptimeSeconds?: number;
  updatedAt?: number;
}
let localMetrics: LocalRadioMetrics = {};

export function getLocalRadioMetrics(): LocalRadioMetrics {
  return { ...localMetrics };
}

export function getRadioConfigSnapshot(): RadioConfigSnapshot {
  return { ...configSnapshot };
}

// PSK trafega como bytes crus; a UI lida com base64. Helpers de conversão.
export function pskToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function pskFromB64(b64: string): Uint8Array {
  const s = atob(b64.trim());
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Convenção Meshtastic: node id textual = "!" + num em hex de 8 dígitos.
function nodeIdHex(num: number): string {
  return '!' + (num >>> 0).toString(16).padStart(8, '0');
}

// ── Vizinhança / censo da malha (eco) ───────────────────────────────────────
// Registro de TODOS os nós ouvidos no ar (não só os que mandam GPS pro Convex).
// Alimentado passivamente por onNodeInfoPacket/onMeshPacket e enriquecido pelo
// eco (traceroute → onTraceRoutePacket). Vive só em memória — é sondagem
// efêmera da malha, não vai pro backend.
export interface MeshNode {
  num: number;
  id: string;              // !hex
  longName?: string;
  shortName?: string;
  hopsAway?: number;
  snr?: number;            // SNR do último pacote ouvido
  viaMqtt?: boolean;       // ouvido pela ponte de internet (MQTT), não por RF
  lastHeard: number;       // ms epoch
  route?: number[];        // último traceroute: caminho de ida (node nums)
  snrTowards?: number[];   // SNR por salto na ida
  routeBack?: number[];
  snrBack?: number[];
  routeAt?: number;        // quando o traceroute voltou
}
const meshNodes = new Map<number, MeshNode>();

// Upsert que só sobrescreve campos definidos (não apaga o que já tinha).
function touchNode(num: number, patch: Partial<MeshNode>): void {
  const e = meshNodes.get(num) ?? { num, id: nodeIdHex(num), lastHeard: 0 };
  const rec = e as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) rec[k] = v;
  }
  meshNodes.set(num, e);
}

export function getMeshNodes(): MeshNode[] {
  // Exclui o PRÓPRIO nó (o device conectado) — não faz sentido listar a si mesmo.
  const self = configSnapshot.myNodeNum;
  return [...meshNodes.values()]
    .filter((n) => n.num !== self)
    .sort((a, b) => b.lastHeard - a.lastHeard);
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
    console.warn('[meshtastic] push de telemetria falhou:', e);
  }
}

// ── Chat: persistência das mensagens no Convex (RX + TX) ─────────────────────
interface ChatPushInput {
  channel_index: number;
  from_node: string;
  to_node?: string;
  text: string;
  timestamp: number;
  packet_id: number;
  direction: 'rx' | 'tx';
}
async function pushChatMessage(input: ChatPushInput): Promise<void> {
  const client = getOrCreateConvexClient();
  if (!client) return;
  const payload: Record<string, number | string> = {
    channel_index: input.channel_index,
    from_node: input.from_node,
    text: input.text,
    timestamp: input.timestamp,
    packet_id: input.packet_id,
    direction: input.direction,
  };
  if (input.to_node) payload.to_node = input.to_node;
  try {
    await (client as unknown as {
      mutation: (name: string, args: unknown) => Promise<unknown>;
    }).mutation('mutations:ingestLoraMessage', payload);
  } catch (e) {
    console.warn('[meshtastic] push de mensagem falhou:', e);
  }
}

/**
 * Empurra a telemetria de um nó usando a ÚLTIMA posição conhecida + os buffers
 * de enriquecimento (rssi/snr/bateria/hops). Dois caminhos:
 *   - `force: true` (pacote de posição novo) → push imediato, packet_id real.
 *   - liveness (mesh/telemetry packet) → throttled por nó; packet_id = now
 *     (row nova, sem dedup) pra "visto há X" e bateria atualizarem mesmo com a
 *     tag parada.
 * Sem posição conhecida ainda → não há o que mapear, ignora.
 */
function pushNode(from: number, opts: { packetId?: number; force?: boolean }): void {
  const pos = posByNode.get(from);
  if (!pos) return;
  // Descarta SÓ nós que vieram exclusivamente via MQTT (ponte de internet,
  // espalhados pelo Brasil). NUNCA filtra:
  //  - o próprio device conectado (from === myNodeNum) — ex: o tag plugado no
  //    Grid 48 reporta a própria posição (sem recepção RF de si mesmo);
  //  - nós ouvidos por RF (rssi/snr ≠0 registrado) — mesmo que o MQTT também
  //    os tenha ecoado de volta (viaMqtt=true).
  const isSelf = from === configSnapshot.myNodeNum;
  const heardByRf = rssiByNode.has(from) || snrByNode.has(from);
  if (!isSelf && meshNodes.get(from)?.viaMqtt && !heardByRf) return;
  const now = Date.now();
  if (!opts.force) {
    const last = lastPushByNode.get(from) ?? 0;
    if (now - last < LIVENESS_THROTTLE_MS) return;
  }
  lastPushByNode.set(from, now);
  void pushTelemetry({
    node_id: nodeIdHex(from),
    packet_id: opts.packetId ?? now,
    timestamp: now,
    lat: pos.lat,
    lon: pos.lon,
    rssi: rssiByNode.get(from),
    battery_level: batteryByNode.get(from),
    snr: snrByNode.get(from),
    hops_away: hopsByNode.get(from),
  });
}

/**
 * Conecta na base RAK via Web Serial e começa a empurrar telemetria pro Convex.
 * DEVE ser chamado de dentro de um handler de clique (user gesture) — o
 * requestPort() nativo do Chrome depende disso.
 */
export async function connectRadio(onStatus?: (s: RadioStatus) => void, existingPort?: unknown): Promise<RadioHandle> {
  if (active) return { disconnect: disconnectRadio };

  statusCb = onStatus ?? null;
  onStatus?.('connecting');

  // Remoção física da porta (USB arrancado) → navigator.serial dispara
  // 'disconnect'. Registrado uma vez; handleRadioLost é idempotente.
  // Web Serial não está no lib.dom padrão — cast pontual.
  const serial = (navigator as unknown as {
    serial?: { addEventListener: (type: string, cb: () => void) => void };
  }).serial;
  if (!serialDisconnectWired && serial) {
    serialDisconnectWired = true;
    serial.addEventListener('disconnect', () => handleRadioLost());
  }

  try {
    // Com porta já autorizada (auto-reconexão) → reusa sem seletor/gesture.
    // Senão, abre o seletor de porta nativo do Chrome (exige user gesture).
    const transport = existingPort
      ? await TransportWebSerial.createFromPort(existingPort as Parameters<typeof TransportWebSerial.createFromPort>[0])
      : await TransportWebSerial.create();
    const device = new MeshDevice(transport);
    active = { device, transport };

    // Queda lógica da conexão (stream fechado, timeout) → DeviceStatusEnum.
    device.events.onDeviceStatus.subscribe((s: unknown) => {
      if (s === DEVICE_DISCONNECTED) handleRadioLost();
    });

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

      // Censo: todo pacote prova que o nó está vivo. Atualiza vizinhança.
      touchNode(p.from, {
        lastHeard: Date.now(),
        snr: snrByNode.get(p.from),
        hopsAway: hopsByNode.get(p.from),
      });

      // Liveness: qualquer pacote prova que o nó está vivo agora. Refresca o
      // "visto há X" / bateria mesmo sem posição nova (throttled por nó).
      pushNode(p.from, {});
    });

    // Device metrics (bateria/voltagem) — protobuf-es representa o oneof como
    // { case, value }. Buffer da bateria por nó.
    device.events.onTelemetryPacket.subscribe((meta: unknown) => {
      const m = meta as {
        from?: number;
        data?: { variant?: { case?: string; value?: {
          batteryLevel?: number; voltage?: number;
          channelUtilization?: number; airUtilTx?: number; uptimeSeconds?: number;
        } } };
      };
      if (typeof m.from !== 'number') return;
      const variant = m.data?.variant;
      if (variant?.case === 'deviceMetrics') {
        const dm = variant.value ?? {};
        if (typeof dm.batteryLevel === 'number') batteryByNode.set(m.from, dm.batteryLevel);
        // Métricas do PRÓPRIO rádio (RAK): quanto ele transmite (air_util_tx) e
        // quão ocupado está o canal. air_util_tx inclui o que ele RELAYA.
        if (m.from === configSnapshot.myNodeNum) {
          if (typeof dm.airUtilTx === 'number') localMetrics.airUtilTx = dm.airUtilTx;
          if (typeof dm.channelUtilization === 'number') localMetrics.channelUtilization = dm.channelUtilization;
          if (typeof dm.voltage === 'number') localMetrics.voltage = dm.voltage;
          if (typeof dm.uptimeSeconds === 'number') localMetrics.uptimeSeconds = dm.uptimeSeconds;
          localMetrics.updatedAt = Date.now();
        }
      }
      // Liveness: telemetria (bateria) chega periódica mesmo com a tag parada.
      pushNode(m.from, {});
    });

    // Posição NOVA → atualiza o buffer e empurra na hora (push forçado, fora do
    // throttle de liveness). É o gatilho principal do rastreamento.
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
      posByNode.set(from, { lat: pos.latitudeI * 1e-7, lon: pos.longitudeI * 1e-7 });
      pushNode(from, { packetId: typeof m.id === 'number' && m.id !== 0 ? m.id : Date.now(), force: true });
    });

    // ── Captura de config pro snapshot (pré-preenche a aba "Rádio") ──────────
    // Esses eventos disparam durante o configure() abaixo (dump inicial) e a
    // cada admin-message de leitura. Guardamos só o que o formulário precisa.
    device.events.onMyNodeInfo.subscribe((info: unknown) => {
      const i = info as { myNodeNum?: number };
      if (typeof i.myNodeNum === 'number') configSnapshot.myNodeNum = i.myNodeNum;
    });

    device.events.onConfigPacket.subscribe((cfg: unknown) => {
      const v = (cfg as { payloadVariant?: { case?: string; value?: Record<string, unknown> } }).payloadVariant;
      if (v?.case === 'lora') {
        if (typeof v.value?.region === 'number') configSnapshot.region = v.value.region as number;
        if (typeof v.value?.modemPreset === 'number') configSnapshot.modemPreset = v.value.modemPreset as number;
        if (typeof v.value?.hopLimit === 'number') configSnapshot.hopLimit = v.value.hopLimit as number;
      } else if (v?.case === 'position') {
        if (typeof v.value?.fixedPosition === 'boolean') configSnapshot.fixedPosition = v.value.fixedPosition as boolean;
        if (typeof v.value?.positionBroadcastSecs === 'number') configSnapshot.positionBroadcastSecs = v.value.positionBroadcastSecs as number;
        if (typeof v.value?.gpsUpdateInterval === 'number') configSnapshot.gpsUpdateInterval = v.value.gpsUpdateInterval as number;
        if (typeof v.value?.gpsMode === 'number') configSnapshot.gpsMode = v.value.gpsMode as number;
        if (typeof v.value?.positionBroadcastSmartEnabled === 'boolean') configSnapshot.smartBroadcast = v.value.positionBroadcastSmartEnabled as boolean;
        if (typeof v.value?.broadcastSmartMinimumDistance === 'number') configSnapshot.smartMinDist = v.value.broadcastSmartMinimumDistance as number;
        if (typeof v.value?.broadcastSmartMinimumIntervalSecs === 'number') configSnapshot.smartMinIntervalSecs = v.value.broadcastSmartMinimumIntervalSecs as number;
      }
    });

    // Module config (telemetria, notificação externa/buzzer) pro pré-preenchimento.
    device.events.onModuleConfigPacket.subscribe((cfg: unknown) => {
      const v = (cfg as { payloadVariant?: { case?: string; value?: Record<string, unknown> } }).payloadVariant;
      if (v?.case === 'telemetry') {
        if (typeof v.value?.deviceUpdateInterval === 'number') configSnapshot.telemetryIntervalSecs = v.value.deviceUpdateInterval as number;
      } else if (v?.case === 'externalNotification') {
        if (typeof v.value?.enabled === 'boolean') configSnapshot.buzzerEnabled = v.value.enabled as boolean;
      }
    });

    device.events.onChannelPacket.subscribe((ch: unknown) => {
      const c = ch as { index?: number; role?: number; settings?: { name?: string; psk?: Uint8Array } };
      if (c.index === 0 && c.settings) {
        if (typeof c.settings.name === 'string') configSnapshot.channelName = c.settings.name;
        if (c.settings.psk instanceof Uint8Array && c.settings.psk.length > 0) {
          configSnapshot.channelPskB64 = pskToB64(c.settings.psk);
        }
      }
      // Canal 1 ativo (role != DISABLED) = escuta pública configurada.
      if (c.index === 1) configSnapshot.publicChannelActive = (c.role ?? 0) !== 0;
    });

    device.events.onUserPacket.subscribe((meta: unknown) => {
      const m = meta as { from?: number; data?: { longName?: string; shortName?: string } };
      if (typeof m.from === 'number' && m.data) {
        // Censo: nome amigável de qualquer nó ouvido.
        touchNode(m.from, { longName: m.data.longName, shortName: m.data.shortName, lastHeard: Date.now() });
        // Owner do PRÓPRIO nó (myNodeNum) também alimenta o form de identidade.
        if (m.from === configSnapshot.myNodeNum) {
          if (m.data.longName) configSnapshot.ownerLongName = m.data.longName;
          if (m.data.shortName) configSnapshot.ownerShortName = m.data.shortName;
        }
      }
    });

    // Censo: NodeInfo (dump inicial + broadcasts periódicos) traz num, nome,
    // hops e SNR de cada nó conhecido — base da vizinhança.
    device.events.onNodeInfoPacket.subscribe((info: unknown) => {
      const n = info as {
        num?: number; snr?: number; lastHeard?: number; hopsAway?: number;
        viaMqtt?: boolean; user?: { longName?: string; shortName?: string };
      };
      if (typeof n.num !== 'number') return;
      touchNode(n.num, {
        longName: n.user?.longName,
        shortName: n.user?.shortName,
        snr: typeof n.snr === 'number' && n.snr !== 0 ? n.snr : undefined,
        hopsAway: typeof n.hopsAway === 'number' ? n.hopsAway : undefined,
        viaMqtt: n.viaMqtt === true,
        // lastHeard do NodeInfo vem em segundos epoch; 0/ausente → agora.
        lastHeard: typeof n.lastHeard === 'number' && n.lastHeard > 0 ? n.lastHeard * 1000 : Date.now(),
      });
    });

    // Eco: resposta de traceroute. `from` = nó que respondeu; data.route = caminho.
    device.events.onTraceRoutePacket.subscribe((meta: unknown) => {
      const m = meta as {
        from?: number;
        data?: { route?: number[]; snrTowards?: number[]; routeBack?: number[]; snrBack?: number[] };
      };
      if (typeof m.from !== 'number') return;
      touchNode(m.from, {
        route: m.data?.route,
        snrTowards: m.data?.snrTowards,
        routeBack: m.data?.routeBack,
        snrBack: m.data?.snrBack,
        routeAt: Date.now(),
        lastHeard: Date.now(),
      });
    });

    // Chat: mensagens de texto recebidas → grava no Convex (RX). PacketMetadata
    // traz from/to/channel/id; data = string. to == broadcastNum → mensagem de canal.
    device.events.onMessagePacket.subscribe((meta: unknown) => {
      const m = meta as { id?: number; from?: number; to?: number; channel?: number; data?: string };
      if (typeof m.from !== 'number' || typeof m.data !== 'string' || m.data.length === 0) return;
      const isBroadcast = m.to === 0xffffffff || m.to === undefined;
      void pushChatMessage({
        channel_index: typeof m.channel === 'number' ? m.channel : 0,
        from_node: nodeIdHex(m.from),
        to_node: isBroadcast ? undefined : nodeIdHex(m.to as number),
        text: m.data,
        timestamp: Date.now(),
        packet_id: typeof m.id === 'number' && m.id !== 0 ? m.id : Date.now(),
        direction: 'rx',
      });
    });

    // Link USB aberto + subscriptions registradas → já sinaliza "conectado".
    // Não espera o handshake (configure() leva alguns segundos pra despejar
    // config + node DB) — o status flipa na hora e os dados preenchem os
    // painéis conforme os eventos chegam.
    onStatus?.('connected');
    console.log('[meshtastic] rádio conectado — iniciando handshake.');
    try {
      // Handshake: dispara o dump de config + node DB. Roda em segundo plano;
      // se falhar, o link segue aberto (só faltam dados iniciais).
      await device.configure();
    } catch (e) {
      console.warn('[meshtastic] handshake (configure) falhou — link aberto, dados iniciais podem faltar:', e);
    }
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
  statusCb = null;
  batteryByNode.clear();
  rssiByNode.clear();
  snrByNode.clear();
  hopsByNode.clear();
  posByNode.clear();
  lastPushByNode.clear();
  meshNodes.clear();
  configSnapshot = {};
  localMetrics = {};
}

export function isRadioConnected(): boolean {
  return active !== null;
}

/**
 * Reconexão automática SEM clique: se o navegador já tem uma porta serial
 * autorizada (de uma conexão anterior), reabre direto via createFromPort.
 * `navigator.serial.getPorts()` não exige user gesture. Retorna true se
 * reconectou. Chamado pelo HealthWidget no load — só roda se já houver porta
 * autorizada (o chamador checa getPorts antes de importar a ponte).
 */
export async function tryAutoReconnect(onStatus?: (s: RadioStatus) => void): Promise<boolean> {
  if (active) return true;
  const serial = (navigator as unknown as {
    serial?: { getPorts?: () => Promise<unknown[]> };
  }).serial;
  if (!serial?.getPorts) return false;
  let ports: unknown[] = [];
  try { ports = await serial.getPorts(); } catch { return false; }
  if (!ports || ports.length === 0) return false;
  try {
    await connectRadio(onStatus, ports[0]);
    return true;
  } catch (e) {
    console.warn('[meshtastic] auto-reconexão falhou (clique manual segue valendo):', e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Fase D — Escrita de config no device (via dock USB / Web Serial)
// ═══════════════════════════════════════════════════════════════════════════
// A aba "Rádio" do Settings chama estes writers. Cada um exige rádio conectado.
// `setConfig` auto-inicia a sessão de edição (beginEditSettings) e fechamos com
// `commitEditSettings()`. Mudança de região/preset faz o firmware reiniciar.

function requireDevice(): MeshDevice {
  if (!active) throw new Error('Rádio não conectado. Conecte pelo painel Comando & Controle primeiro.');
  return active.device;
}

/** Nome longo (≤39 chars) + curto (≤4) — anunciados na mesh inteira. */
export async function applyOwner(longName: string, shortName: string): Promise<void> {
  const device = requireDevice();
  const user = mk(P.Mesh.UserSchema, { longName, shortName });
  await device.setOwner(user);
  configSnapshot.ownerLongName = longName;
  configSnapshot.ownerShortName = shortName;
}

/**
 * Região + modem preset. ⚠️ Mudar região reinicia o device (firmware aplica no
 * boot). usePreset=true diz pro firmware usar os parâmetros do preset escolhido.
 */
export async function applyLoraConfig(region: number, modemPreset: number, hopLimit?: number): Promise<void> {
  const device = requireDevice();
  const value: Record<string, unknown> = { region, modemPreset, usePreset: true };
  if (typeof hopLimit === 'number' && hopLimit >= 0) value.hopLimit = hopLimit;
  const cfg = mk(P.Config.ConfigSchema, {
    payloadVariant: { case: 'lora', value },
  });
  await device.setConfig(cfg);
  await device.commitEditSettings();
  configSnapshot.region = region;
  configSnapshot.modemPreset = modemPreset;
  if (typeof hopLimit === 'number') configSnapshot.hopLimit = hopLimit;
}

/** Canal primário (índice 0): nome + PSK compartilhado. Tags com o mesmo par conversam. */
export async function applyChannel(name: string, psk: Uint8Array): Promise<void> {
  const device = requireDevice();
  const channel = mk(P.Channel.ChannelSchema, {
    index: 0,
    role: 1, // Channel.Role.PRIMARY
    settings: mk(P.Channel.ChannelSettingsSchema, { name, psk }),
  });
  await device.setChannel(channel);
  configSnapshot.channelName = name;
  configSnapshot.channelPskB64 = psk.length > 0 ? pskToB64(psk) : undefined;
}

/**
 * Posição fixa (pra sensores parados — pluviômetro/anemômetro da Fase 6) +
 * intervalo de broadcast de posição. Quando `fixed=false`, remove a posição
 * fixa e o device volta a depender do GPS.
 */
export async function applyPositionConfig(opts: {
  fixed: boolean;
  lat?: number;
  lon?: number;
  positionBroadcastSecs?: number;
  gpsUpdateInterval?: number;
  gpsMode?: number;
  smartBroadcast?: boolean;
  smartMinDist?: number;
  smartMinIntervalSecs?: number;
}): Promise<void> {
  const device = requireDevice();
  const value: Record<string, unknown> = { fixedPosition: opts.fixed };
  if (typeof opts.positionBroadcastSecs === 'number' && opts.positionBroadcastSecs > 0) value.positionBroadcastSecs = opts.positionBroadcastSecs;
  if (typeof opts.gpsUpdateInterval === 'number' && opts.gpsUpdateInterval > 0) value.gpsUpdateInterval = opts.gpsUpdateInterval;
  if (typeof opts.gpsMode === 'number') value.gpsMode = opts.gpsMode;
  if (typeof opts.smartBroadcast === 'boolean') value.positionBroadcastSmartEnabled = opts.smartBroadcast;
  if (typeof opts.smartMinDist === 'number' && opts.smartMinDist > 0) value.broadcastSmartMinimumDistance = opts.smartMinDist;
  if (typeof opts.smartMinIntervalSecs === 'number' && opts.smartMinIntervalSecs > 0) value.broadcastSmartMinimumIntervalSecs = opts.smartMinIntervalSecs;
  const cfg = mk(P.Config.ConfigSchema, { payloadVariant: { case: 'position', value } });
  await device.setConfig(cfg);
  await device.commitEditSettings();

  if (opts.fixed && typeof opts.lat === 'number' && typeof opts.lon === 'number') {
    await device.setFixedPosition(opts.lat, opts.lon);
  } else if (!opts.fixed) {
    // removeFixedPosition existe no core; best-effort (não trava o fluxo se ausente).
    try {
      await (device as unknown as { removeFixedPosition?: () => Promise<number> }).removeFixedPosition?.();
    } catch { /* device antigo sem o comando */ }
  }
  configSnapshot.fixedPosition = opts.fixed;
  if (typeof opts.positionBroadcastSecs === 'number') configSnapshot.positionBroadcastSecs = opts.positionBroadcastSecs;
  if (typeof opts.gpsUpdateInterval === 'number') configSnapshot.gpsUpdateInterval = opts.gpsUpdateInterval;
  if (typeof opts.gpsMode === 'number') configSnapshot.gpsMode = opts.gpsMode;
  if (typeof opts.smartBroadcast === 'boolean') configSnapshot.smartBroadcast = opts.smartBroadcast;
  if (typeof opts.smartMinDist === 'number') configSnapshot.smartMinDist = opts.smartMinDist;
  if (typeof opts.smartMinIntervalSecs === 'number') configSnapshot.smartMinIntervalSecs = opts.smartMinIntervalSecs;
}

// ── Feature 2: re-leitura ativa da config atual do device ────────────────────
// Dispara admin "get" pra cada bloco — as respostas caem nos handlers que já
// populam o configSnapshot. A aba Rádio chama isso ao abrir.
export async function refreshRadioConfig(): Promise<void> {
  const device = requireDevice();
  const CT = P.Admin.AdminMessage_ConfigType;
  const MT = P.Admin.AdminMessage_ModuleConfigType;
  const d = device as unknown as {
    getConfig: (t: number) => Promise<number>;
    getModuleConfig: (t: number) => Promise<number>;
    getChannel: (i: number) => Promise<number>;
    getOwner?: () => Promise<number>;
  };
  const tasks = [
    d.getConfig(CT.LORA_CONFIG), d.getConfig(CT.POSITION_CONFIG),
    d.getModuleConfig(MT.TELEMETRY_CONFIG), d.getModuleConfig(MT.EXTNOTIF_CONFIG),
    d.getChannel(0), d.getChannel(1),
  ];
  await Promise.allSettled(tasks);
}

// ── Feature 1: enviar mensagem de chat (broadcast no canal) ──────────────────
export async function sendChatText(text: string, channelIndex: number): Promise<void> {
  const device = requireDevice();
  // wantAck=false: broadcast de canal não tem ACK por destinatário (grupo).
  const packetId = await device.sendText(text, 'broadcast', false, channelIndex as unknown as number);
  const self = configSnapshot.myNodeNum;
  void pushChatMessage({
    channel_index: channelIndex,
    from_node: typeof self === 'number' ? nodeIdHex(self) : 'self',
    text,
    timestamp: Date.now(),
    packet_id: typeof packetId === 'number' && packetId !== 0 ? packetId : Date.now(),
    direction: 'tx',
  });
}

// ── Feature 3: configuração automática de canais (privado + público) ─────────
// Seta canal 0 = privado Grid 48 (PRIMARY) + canal 1 = LongFast público
// (SECONDARY). O PSK privado vem do Convex (singleton compartilhado pela frota).
export async function applyAutoChannels(privateName: string, privatePskB64: string): Promise<void> {
  const device = requireDevice();
  const psk = pskFromB64(privatePskB64);
  // Canal 0 — privado, PRIMARY.
  const ch0 = mk(P.Channel.ChannelSchema, {
    index: 0, role: 1, // PRIMARY
    settings: mk(P.Channel.ChannelSettingsSchema, { name: privateName, psk }),
  });
  await device.setChannel(ch0);
  // Canal 1 — LongFast público, SECONDARY. PSK padrão = 1 byte 0x01 ("AQ==").
  const ch1 = mk(P.Channel.ChannelSchema, {
    index: 1, role: 2, // SECONDARY
    settings: mk(P.Channel.ChannelSettingsSchema, { name: '', psk: new Uint8Array([1]) }),
  });
  await device.setChannel(ch1);
  configSnapshot.channelName = privateName;
  configSnapshot.channelPskB64 = privatePskB64;
  configSnapshot.publicChannelActive = true;
}

/** Intervalo (s) entre broadcasts de device metrics (bateria/TX/uptime). Module config. */
export async function applyTelemetryConfig(deviceUpdateIntervalSecs: number): Promise<void> {
  const device = requireDevice();
  const mod = mk(P.ModuleConfig.ModuleConfigSchema, {
    payloadVariant: { case: 'telemetry', value: { deviceUpdateInterval: deviceUpdateIntervalSecs } },
  });
  await device.setModuleConfig(mod);
  configSnapshot.telemetryIntervalSecs = deviceUpdateIntervalSecs;
}

/** Liga/desliga o módulo de notificação externa (buzzer/LED). Module config. */
export async function applyBuzzer(enabled: boolean): Promise<void> {
  const device = requireDevice();
  const mod = mk(P.ModuleConfig.ModuleConfigSchema, {
    payloadVariant: { case: 'externalNotification', value: enabled
      ? { enabled: true, alertMessage: true, alertBell: true, usePwm: true }
      : { enabled: false } },
  });
  await device.setModuleConfig(mod);
  configSnapshot.buzzerEnabled = enabled;
}

/**
 * Configuração automática de canais: busca (ou gera+salva) o canal privado
 * canônico Grid 48 no Convex e aplica canal 0 = privado + canal 1 = público no
 * device conectado. Retorna o nome do canal privado aplicado.
 */
export async function autoConfigureChannels(): Promise<{ name: string; generated: boolean }> {
  requireDevice();
  const client = getOrCreateConvexClient();
  if (!client) throw new Error('Convex indisponível — não foi possível buscar o canal Grid 48.');
  const c = client as unknown as {
    query: (name: string, args: unknown) => Promise<unknown>;
    mutation: (name: string, args: unknown) => Promise<unknown>;
  };

  let ch = (await c.query('queries:getGrid48Channel', {})) as { nome: string; psk_b64: string } | null;
  let generated = false;
  if (!ch) {
    // Primeiro device da frota: gera PSK 32 bytes (AES-256) + nome e persiste.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const name = 'Grid48';
    const pskB64 = pskToB64(bytes);
    await c.mutation('mutations:setGrid48Channel', { nome: name, psk_b64: pskB64 });
    // Re-lê (first-write-wins: se outro device gravou no meio, pega o vencedor).
    ch = ((await c.query('queries:getGrid48Channel', {})) as { nome: string; psk_b64: string } | null)
      ?? { nome: name, psk_b64: pskB64 };
    generated = true;
  }
  await applyAutoChannels(ch.nome, ch.psk_b64);
  return { name: ch.nome, generated };
}

// ── Opções de enum pros dropdowns (lidas do runtime, robusto a versões) ──────
export interface EnumOption { value: number; label: string }

function enumOptions(e: Record<string, unknown>): EnumOption[] {
  // TS numeric enum = mapa bidirecional (nome→num E num→nome). Mantém só o
  // forward (chave não-numérica → valor numérico).
  return Object.entries(e)
    .filter(([k, v]) => typeof v === 'number' && !Number.isFinite(Number(k)))
    .map(([k, v]) => ({ value: v as number, label: k }));
}

export function getRegionOptions(): EnumOption[] {
  return enumOptions(P.Config.Config_LoRaConfig_RegionCode);
}
export function getModemPresetOptions(): EnumOption[] {
  return enumOptions(P.Config.Config_LoRaConfig_ModemPreset);
}

// ── Eco: sonda ativa da malha (traceroute pros nós conhecidos) ───────────────
// Pra cada nó da vizinhança (exceto o nosso), dispara um traceroute. A resposta
// volta em onTraceRoutePacket e enriquece o registro com caminho + SNR por
// salto. Escalonado (traceroute é caro: round-trip + relays) pra não inundar o
// ar. Se a vizinhança está vazia, não há alvo — o censo passivo já responde
// "não tem ninguém". Retorna quantos nós foram sondados.
const ECHO_STAGGER_MS = 4000;

export async function echoOnce(): Promise<{ probed: number }> {
  const device = requireDevice();
  const self = configSnapshot.myNodeNum;
  const targets = [...meshNodes.values()].filter((n) => n.num !== self);
  for (const t of targets) {
    try {
      await (device as unknown as { traceRoute: (dest: number) => Promise<number> }).traceRoute(t.num);
    } catch (e) {
      console.warn('[meshtastic] traceroute falhou', t.id, e);
    }
    await new Promise((r) => setTimeout(r, ECHO_STAGGER_MS));
  }
  return { probed: targets.length };
}
