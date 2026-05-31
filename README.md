# Grid 48

**Grid 48** é um ecossistema tático de Comando e Controle (C2) híbrido, projetado sob o paradigma **Offline-First com Sincronia Eventual**. 

O objetivo do sistema é fornecer consciência situacional em tempo real e histórico da infraestrutura crítica da Grande Florianópolis (energia, clima, segurança e mobilidade), garantindo que a base de operações permaneça online e coletando inteligência via rádio LoRa/Meshtastic, mesmo diante de um colapso total da infraestrutura de internet e energia das concessionárias locais.

---

## 🏛️ Topologia e Arquitetura (V2.0)

O projeto abandona a dependência exclusiva da nuvem e adota a **Computação de Borda Assimétrica** distribuída em 4 zonas:

### 1. Zona 0: O Gateway Cloud (`/grid48-gateway`)
- **Papel:** Receber os dados quando há conectividade e rodar algoritmos pesados.
- **Tecnologia:** Convex (Serverless Database & Functions).
- **Inteligência:** Processamento de requisições SITREP (Situation Report) integradas ao **Google Gemini** para análise tática rápida do terreno, trafegando pacotes ultra-compactados de volta para a borda.

### 2. Zona 1: O Fat Client (`/grid48-main/src`)
- **Papel:** Interface tática e mapa interativo.
- **Tecnologia:** **Vanilla TypeScript + Vite** (sem framework — componentes herdam de uma classe base `Panel`). Mapa em **deck.gl + maplibre-gl** centrado na Grande Florianópolis, com camadas de instabilidades Celesc (polígonos municipais por % de UCs offline) e alertas da Defesa Civil. Estado reativo via cliente Convex (`convex/browser`).
- **Adapter Pattern:** O app monitora a conexão (`__API_MODE__`). Se a internet cair, o `LocalProvider` assume o controle e passa a buscar os dados estritamente da infraestrutura local (Zona 2), sem o usuário perceber.
- **Codebase Grid 48-nativo:** originalmente um fork do WorldMonitor, o frontend foi 100% limpo (Mai/2026) — `worldmonitor` = 0 referências no código vivo. Histórico da faxina em `grid48-main/docs/CLEANUP_PLAN.md`.

### 3. Zona 2: O Engine de Borda (`/grid48-main/engine`)
- **Papel:** O cérebro de sobrevivência (Instalado no Raspberry Pi / Ipiranga).
- **Tecnologia:** Node.js (Hono API) + SQLite-WAL + Drizzle ORM.
- **Resiliência:** Sincronização em fila (PUSH-ACK). O engine salva tudo localmente no Pendrive USB e só descarta dados quando a Zona 0 (Cloud) confirma o recebimento.

### 4. Zona 3: A Camada de Rádio (`/grid48-main/firmware-gateway`)
- **Papel:** A ponte física para a rede LoRa.
- **Tecnologia:** ESP32 + C++ (PlatformIO).
- **Protocolo:** Traduz sinais de radiofrequência para JSON via HTTP. Possui estratégias de Backoff Exponencial para lidar com Wi-Fi intermitente no teatro de operações e lida com polling de SITREPs da IA.

---

## 🚀 Como Fazer o Deploy

A documentação foi estritamente segregada por responsabilidade. Para levantar o ecossistema na sua máquina ou hardware dedicado, consulte os manuais abaixo:

- **[Guia de Sobrevivência: Deploy Físico no Raspberry Pi](./grid48-main/deploy/README.md)**
  _Manual tático de como flashar o cartão SD, preparar o Pendrive (prevenção de corrupção do WAL SQLite), plugar a antena e levantar a arquitetura Docker._

- **Deploy do Cloud Gateway (Convex)**
  _Navegue até `grid48-gateway` e rode `npx convex dev` para iniciar o backend serverless._

- **Deploy do Frontend Local (Desenvolvimento)**
  _Navegue até `grid48-main`, instale as dependências com `npm install` e inicie via `npm run dev`._

---

## 📖 Documentação Técnica

- **[`grid48-main/CLAUDE.md`](./grid48-main/CLAUDE.md)** — onboarding completo para qualquer agente/dev: stack, arquitetura, schema Convex, modelo DEFCON, sistema de regras DSL, pegadinhas conhecidas e roadmap. **Ponto de entrada recomendado.**
- **[`grid48-main/docs/CLEANUP_PLAN.md`](./grid48-main/docs/CLEANUP_PLAN.md)** — histórico da limpeza pós-WorldMonitor.
