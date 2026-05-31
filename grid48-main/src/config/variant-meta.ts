export interface VariantMeta {
  title: string;
  description: string;
  keywords: string;
  url: string;
  siteName: string;
  shortName: string;
  subject: string;
  classification: string;
  categories: string[];
  features: string[];
}

// Grid 48 tem uma única variante. Indexado por chave (`full`) pra compat
// com o htmlVariantPlugin do vite.config, que injeta as meta tags no HTML
// durante o build.
export const VARIANT_META: { full: VariantMeta; [k: string]: VariantMeta } = {
  full: {
    title: 'Grid 48 — Comando & Controle Grande Florianópolis',
    description:
      'Painel tático em tempo real para a Grande Florianópolis: instabilidades da Celesc, alertas da Defesa Civil, telemetria LoRa e SITREP via rádio. C2 local com fallback offline.',
    keywords:
      'grid 48, comando e controle, defesa civil, celesc, florianópolis, santa catarina, lora, telemetria, sitrep, osint, monitoramento, energia, alertas meteorológicos',
    url: 'https://grid-48.vercel.app/',
    siteName: 'Grid 48',
    shortName: 'Grid48',
    subject: 'Tactical C2 Dashboard — Grande Florianópolis',
    classification: 'Emergency Operations Dashboard',
    categories: ['utilities', 'productivity'],
    features: [
      'Mapa tático da Grande Florianópolis (deck.gl)',
      'Monitoramento de instabilidades Celesc em tempo real',
      'Alertas OSINT da Defesa Civil (RSS + Gemini)',
      'Telemetria LoRa de nós móveis',
      'SITREP via rádio com resposta IA',
      'Engine local resiliente com fallback offline',
    ],
  },
};
