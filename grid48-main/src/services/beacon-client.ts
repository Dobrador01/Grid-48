import { ConvexClient } from 'convex/browser';

let client: ConvexClient | null = null;

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

export type BeaconConnectionStatus =
    | { kind: 'no-config' }
    | { kind: 'connecting' }
    | { kind: 'connected' }
    | { kind: 'disconnected'; retries: number };

export interface BeaconSnapshot {
    alertas: BeaconAlert[];
    health: BeaconHealth | null;
    connection: BeaconConnectionStatus;
}

const initialSnapshot: BeaconSnapshot = {
    alertas: [],
    health: null,
    connection: { kind: 'connecting' },
};

export function initBeaconClient(onUpdate: (snapshot: BeaconSnapshot) => void) {
    if (client) return;

    const url = import.meta.env.VITE_CONVEX_URL;
    if (!url) {
        console.warn("[Beacon] VITE_CONVEX_URL ausente em build. Pub-Sub OSINT desligado.");
        onUpdate({ ...initialSnapshot, connection: { kind: 'no-config' } });
        return;
    }

    const snapshot: BeaconSnapshot = { ...initialSnapshot };
    const emit = () => onUpdate({ ...snapshot });

    try {
        client = new ConvexClient(url);
        console.log("[Beacon] Socket reativo TCP ativado em:", url);

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
