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
  fixedPosition?: boolean;
  positionBroadcastSecs?: number;
  channelName?: string;
  channelPskB64?: string;   // PSK do canal 0 em base64 (bytes crus na wire)
}
let configSnapshot: RadioConfigSnapshot = {};

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
  return [...meshNodes.values()].sort((a, b) => b.lastHeard - a.lastHeard);
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
    console.log(`[mesh-debug] push OK node=${input.node_id} lat=${input.lat.toFixed(5)} lon=${input.lon.toFixed(5)}`);
  } catch (e) {
    console.warn('[mesh-debug] push FALHOU:', e);
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

      // ── DIAGNÓSTICO ────────────────────────────────────────────────────────
      // onMeshPacket dispara pra TODO pacote, ANTES do filtro decoded/encrypted
      // do core. Logamos o suficiente pra descobrir por que a posição ao vivo
      // não flui: se vier `encrypted`, a base não tem a chave do canal da tag
      // (canal/PSK divergentes → Fase D resolve). Se vier `decoded` com portnum
      // 3 (POSITION_APP), o pacote chegou e devia ter empurrado.
      const variant = (pkt as { payloadVariant?: { case?: string; value?: { portnum?: number } } }).payloadVariant;
      const portnum = variant?.case === 'decoded' ? variant.value?.portnum : undefined;
      console.log(`[mesh-debug] pkt from=${nodeIdHex(p.from)} payload=${variant?.case ?? '?'}` +
        (portnum !== undefined ? ` portnum=${portnum}` : ''));

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
        data?: { variant?: { case?: string; value?: { batteryLevel?: number } } };
      };
      if (typeof m.from !== 'number') return;
      const variant = m.data?.variant;
      if (variant?.case === 'deviceMetrics' && typeof variant.value?.batteryLevel === 'number') {
        batteryByNode.set(m.from, variant.value.batteryLevel);
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

      console.log(`[mesh-debug] POSITION from=${nodeIdHex(from)} lat=${(pos.latitudeI * 1e-7).toFixed(5)} lon=${(pos.longitudeI * 1e-7).toFixed(5)} → push`);
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
      } else if (v?.case === 'position') {
        if (typeof v.value?.fixedPosition === 'boolean') configSnapshot.fixedPosition = v.value.fixedPosition as boolean;
        if (typeof v.value?.positionBroadcastSecs === 'number') configSnapshot.positionBroadcastSecs = v.value.positionBroadcastSecs as number;
      }
    });

    device.events.onChannelPacket.subscribe((ch: unknown) => {
      const c = ch as { index?: number; settings?: { name?: string; psk?: Uint8Array } };
      if (c.index === 0 && c.settings) {
        if (typeof c.settings.name === 'string') configSnapshot.channelName = c.settings.name;
        if (c.settings.psk instanceof Uint8Array && c.settings.psk.length > 0) {
          configSnapshot.channelPskB64 = pskToB64(c.settings.psk);
        }
      }
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
        user?: { longName?: string; shortName?: string };
      };
      if (typeof n.num !== 'number') return;
      touchNode(n.num, {
        longName: n.user?.longName,
        shortName: n.user?.shortName,
        snr: typeof n.snr === 'number' && n.snr !== 0 ? n.snr : undefined,
        hopsAway: typeof n.hopsAway === 'number' ? n.hopsAway : undefined,
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
      console.log(`[mesh-debug] traceroute resp de ${nodeIdHex(m.from)} route=[${(m.data?.route ?? []).map(nodeIdHex).join(', ')}]`);
      touchNode(m.from, {
        route: m.data?.route,
        snrTowards: m.data?.snrTowards,
        routeBack: m.data?.routeBack,
        snrBack: m.data?.snrBack,
        routeAt: Date.now(),
        lastHeard: Date.now(),
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
  posByNode.clear();
  lastPushByNode.clear();
  meshNodes.clear();
  configSnapshot = {};
}

export function isRadioConnected(): boolean {
  return active !== null;
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
export async function applyLoraConfig(region: number, modemPreset: number): Promise<void> {
  const device = requireDevice();
  const cfg = mk(P.Config.ConfigSchema, {
    payloadVariant: { case: 'lora', value: { region, modemPreset, usePreset: true } },
  });
  await device.setConfig(cfg);
  await device.commitEditSettings();
  configSnapshot.region = region;
  configSnapshot.modemPreset = modemPreset;
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
}): Promise<void> {
  const device = requireDevice();
  const value: Record<string, unknown> = { fixedPosition: opts.fixed };
  if (typeof opts.positionBroadcastSecs === 'number' && opts.positionBroadcastSecs > 0) {
    value.positionBroadcastSecs = opts.positionBroadcastSecs;
  }
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
  if (typeof opts.positionBroadcastSecs === 'number') {
    configSnapshot.positionBroadcastSecs = opts.positionBroadcastSecs;
  }
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
      console.log(`[mesh-debug] eco → traceroute pra ${t.id}`);
      await (device as unknown as { traceRoute: (dest: number) => Promise<number> }).traceRoute(t.num);
    } catch (e) {
      console.warn('[mesh-debug] traceroute falhou', t.id, e);
    }
    await new Promise((r) => setTimeout(r, ECHO_STAGGER_MS));
  }
  return { probed: targets.length };
}
