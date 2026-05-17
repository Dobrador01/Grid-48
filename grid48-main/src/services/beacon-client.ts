import { ConvexClient } from 'convex/browser';

let client: ConvexClient | null = null;

/**
 * Retorna o singleton ConvexClient. Se ainda não foi criado por
 * initBeaconClient, cria sob demanda usando VITE_CONVEX_URL.
 * Retorna null se a URL não estiver configurada (build sem Convex).
 *
 * Usado por outros services (ex: celesc.ts) que precisam invocar
 * mutations sem montar uma segunda conexão WebSocket.
 */
export function getOrCreateConvexClient(): ConvexClient | null {
    if (client) return client;
    const url = import.meta.env.VITE_CONVEX_URL;
    if (!url) return null;
    try {
        client = new ConvexClient(url);
        return client;
    } catch (e) {
        console.error("[Beacon] Falha ao criar ConvexClient compartilhado:", e);
        return null;
    }
}

// Tipo isolado para garantir consistência Vanilla TS do projeto sem vazamento de types do backend
export interface BeaconAlert {
    _id: string;
    guid: string;
    titulo: string;
    nivel_risco: "Baixo" | "Medio" | "Alto";
    cidades_afetadas_ibge: number[];
    expiresAt: number;
    firstSeenAt?: number;
}

export interface BeaconHealth {
    lastRunAt: number;
    lastSuccessAt: number | null;
    lastError: string | null;
    itemsProcessed: number;
    itemsFailed: number;
}

// Espelha shape de convex/defcon/queries.ts:getDefconStatus. Não importa types
// do backend (mesmo padrão de BeaconAlert).
export interface DefconStatus {
    _id: string;
    nivel_global: number;          // 1..5 (1 = mais crítico)
    niveis_categoria: {
        energia: number;
        clima: number;
        mobilidade: number;
    };
    inputs_hash: string;
    sinais_disparadores: Array<{
        categoria: string;
        regra_id: string;
        evidencia: string;
    }>;
    explicacao?: {
        texto: string;
        gerada_em: number;
        inputs_hash: string;
        modelo: string;
    };
    nivel_anterior?: number;
    recomputado_em: number;
    ultima_mudanca_em: number;
}

// Espelha shape de convex/clima/queries.ts:getMeteorologiaState (uma row por
// fonte × localidade). Fonte hoje é só "openweather"; "lora_local" entra
// quando o hardware chegar.
export interface ClimaLocalidade {
    _id: string;
    fonte: "openweather" | "lora_local";
    localidade_label: string;
    lat: number;
    lon: number;
    ts: number;
    current: {
        temperatura_c: number;
        sensacao_c: number;
        umidade_pct: number;
        vento_kmh: number;
        vento_rajada_kmh?: number;
        chuva_1h_mm?: number;
        condicao_id: number;
        condicao_descricao: string;
        icone: string;
    };
    hourly: Array<{
        ts: number;
        temperatura_c: number;
        chuva_1h_mm?: number;
        vento_kmh: number;
        prob_chuva: number;
        condicao_id: number;
        icone: string;
    }>;
    chuva_24h_mm: number;
    alertas?: Array<{
        evento: string;
        descricao: string;
        inicio_ts: number;
        fim_ts: number;
        severidade?: string;
    }>;
}

export type BeaconConnectionStatus =
    | { kind: 'no-config' }
    | { kind: 'connecting' }
    | { kind: 'connected' }
    | { kind: 'disconnected'; retries: number };

export interface BeaconSnapshot {
    alertas: BeaconAlert[];
    health: BeaconHealth | null;
    defcon: DefconStatus | null;
    clima: ClimaLocalidade[];
    connection: BeaconConnectionStatus;
}

const initialSnapshot: BeaconSnapshot = {
    alertas: [],
    health: null,
    defcon: null,
    clima: [],
    connection: { kind: 'connecting' },
};

export function initBeaconClient(onUpdate: (snapshot: BeaconSnapshot) => void) {
    // Idempotente: se outro caller (ex: getOrCreateConvexClient) já criou o
    // socket, reusamos. Subscriptions são adicionadas mesmo assim.
    const url = import.meta.env.VITE_CONVEX_URL;
    if (!url) {
        console.warn("[Beacon] VITE_CONVEX_URL ausente em build. Pub-Sub OSINT desligado.");
        onUpdate({ ...initialSnapshot, connection: { kind: 'no-config' } });
        return;
    }

    const snapshot: BeaconSnapshot = { ...initialSnapshot };
    const emit = () => onUpdate({ ...snapshot });

    try {
        if (!client) {
            client = new ConvexClient(url);
            console.log("[Beacon] Socket reativo TCP ativado em:", url);
        }

        emit();

        // Cast intencional: estamos usando string-FunctionReference sem o codegen do backend
        const c = client as any;
        c.onUpdate("queries:listarAlertasAtivos", {}, (data: any) => {
            console.log("[Beacon] Alertas atualizados:", data?.length ?? 0);
            snapshot.alertas = data || [];
            emit();
        });

        c.onUpdate("queries:getOsintHealth", {}, (data: any) => {
            snapshot.health = data || null;
            emit();
        });

        // DEFCON — singleton de estado operacional agregado (calculado reativamente
        // no backend via convex/defcon/mutations.ts:recomputeDefcon).
        c.onUpdate("defcon/queries:getDefconStatus", {}, (data: any) => {
            snapshot.defcon = data || null;
            emit();
        });

        // Clima — array de localidades-foco com snapshot OpenWeather atual +
        // forecast 12h. Populado pelo cron fetch-openweather (15min).
        c.onUpdate("clima/queries:getMeteorologiaState", {}, (data: any) => {
            snapshot.clima = Array.isArray(data) ? data : [];
            emit();
        });

        const anyClient = client as any;
        if (typeof anyClient.subscribeToConnectionState === 'function') {
            anyClient.subscribeToConnectionState((cs: any) => {
                if (cs?.isWebSocketConnected) {
                    snapshot.connection = { kind: 'connected' };
                } else if (cs?.hasEverConnected) {
                    snapshot.connection = { kind: 'disconnected', retries: cs.connectionRetries ?? 0 };
                } else {
                    snapshot.connection = { kind: 'connecting' };
                }
                emit();
            });
        } else {
            // Fallback otimista para versões mais antigas do convex/browser
            snapshot.connection = { kind: 'connected' };
            emit();
        }
    } catch(e) {
        console.error("[Beacon] Falha na subscrição reativa bidirecional:", e);
        onUpdate({ ...initialSnapshot, connection: { kind: 'disconnected', retries: 0 } });
    }
}
