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
}

export function initBeaconClient(onUpdate: (alertas: BeaconAlert[]) => void) {
    if (client) return;

    // VITE_CONVEX_URL injetada no .env.local pelo script anterior
    const url = import.meta.env.VITE_CONVEX_URL;
    if (!url) {
        console.warn("[Beacon] VITE_CONVEX_URL ausente em build. Pub-Sub OSINT desligado.");
        return;
    }

    try {
        client = new ConvexClient(url);
        console.log("[Beacon] Socket reativo TCP ativado em:", url);

        // Ouve ativamente e notifica a callback sempre que a nuvem mutar.
        client.onUpdate("queries:listarAlertasAtivos", {}, (data: any) => {
            console.log("[Beacon] Live Query Reative State — Pacote O(1) Atualizado:", data?.length);
            onUpdate(data || []);
        });
    } catch(e) {
        console.error("[Beacon] Falha na subscrição reativa bidirecional:", e);
    }
}
