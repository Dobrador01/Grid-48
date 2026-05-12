# Grid 48 — Plano de Limpeza Pós-WorldMonitor (Camadas B & C)

> **Documento de handoff para uma nova sessão da agente de IA.** Este arquivo descreve a
> faxina de código herdado do WorldMonitor que sobrou no fork Grid 48. Trabalho
> é dividido em duas camadas com risco/escopo crescente. Lê tudo antes de
> começar, valida o estado atual com os comandos da seção "Estado de partida",
> e segue o plano. Não pula a validação — o repo passou por várias sessões e
> coisas mudam.

---

- Lê docs/CLEANUP_PLAN.md primeiro inteiro antes de tocar em nada.
- Roda a seção "Estado de partida" (typecheck, build, bundle baseline)
  e me mostra o resultado ANTES de começar a deletar.
- Faz UM commit por bloco coerente. Após cada push, espera o CI ficar
  verde antes do próximo commit. Não acumula múltiplos commits sem
  validação.
- Se algum delete causar TS error não-óbvio, para e me pergunta —
  não tenta consertar errado por cima de errado.
- Camada B inteira primeiro. Para. Reporta resultado (bundle size
  antes/depois, linhas deletadas, smoke test). SÓ aí passa pra Camada C.
- Antes de Camada C, me pergunta sobre Tauri (manter ou deletar)
  e ESPERA minha resposta.



## 1. Contexto rápido

### Identidade do projeto

- **Grid 48**: dashboard tático C2 para a Grande Florianópolis (Brasil). Map deck.gl + camadas de Celesc (energia) + alertas OSINT da Defesa Civil + telemetria de rádio LoRa.
- **Fork do WorldMonitor** (`worldmonitor.app`). Grande parte do código original sobrou como dead weight.
- **Stack**: Vite + TypeScript + deck.gl no frontend; Node.js + Drizzle SQLite + Hono no engine local (Pi 3B+); Convex Cloud no backend.
- **Caminho local**: `C:\Users\Enio Jr\OneDrive\Documentos\Grid 48\grid48-main\`.
- **Repo**: `https://github.com/Dobrador01/Grid-48`.
- **Versão atual (verificar)**: v1.2.0 (pode ter sido bumpada).

### Estrutura do repo

```
Grid 48/                              ← raiz git
├── .github/workflows/                ← CI (main.yml, typecheck.yml, etc.)
├── grid48-main/                      ← código real
│   ├── src/                          ← frontend Vite
│   ├── engine/                       ← Node.js backend local (Pi)
│   ├── proto/                        ← schemas Protobuf grid48 + worldmonitor
│   ├── src-tauri/                    ← Tauri desktop (CANDIDATO DELEÇÃO — ver Camada C)
│   ├── docker/                       ← Dockerfile (web + engine) + compose
│   └── docs/                         ← este arquivo mora aqui
└── grid48-gateway/                   ← DELETADO após consolidação Convex
```

### Arquitetura essencial (o que NÃO pode quebrar)

- **Adapter pattern** em `src/adapters/`: `ConvexProvider` (cloud) vs `LocalProvider` (Pi).
  Build-time flag `__API_MODE__` injetado via `define` em `vite.config.ts`.
- **Engine local** (`engine/`): roda no Pi, decodifica rádio LoRa via Protobuf,
  faz scraping Celesc, puxa Beacon, expõe REST + WebSocket para o frontend LOCAL.
- **Convex consolidado**: tanto Beacon (RSS Defesa Civil + Gemini) quanto Gateway
  (telemetria + SITREP) rodam no mesmo deployment `secret-shrimp-538`.
  **Não recriar separação**.

### Trabalho recente (referência)

Sessões anteriores entregaram, na ordem:
- Onda 0–5: infraestrutura completa, adapter, engine, endpoints, UI, SITREP
  loop fechado (radio → cloud → radio).
- v1.2.0 release.
- Consolidação Convex (beacon + gateway num só deployment).
- Camada A da limpeza (delete `grid48-gateway/`, remove `CONVEX_GW_URL`).

**Camadas B e C são o que sobrou.**

---

## 2. Estado de partida — VALIDAR antes de tocar em nada

```bash
# 1. Confirma que está na raiz certa
cd "C:/Users/Enio Jr/OneDrive/Documentos/Grid 48"
git status                              # main branch, working tree limpo?
git log --oneline -5                    # último commit deve ser consolidação Convex ou Camada A

# 2. Confirma que CI está verde
# Abre https://github.com/Dobrador01/Grid-48/actions
# Último run em main deve estar todo verde

# 3. Type-check baseline (deve passar zero erros)
cd grid48-main
npx tsc --noEmit && echo OK || echo BROKEN
cd engine && npx tsc --noEmit && echo OK || echo BROKEN

# 4. Bundle size baseline (para comparar depois)
cd ..
npm run build 2>&1 | tee /tmp/build-before.log
ls -lh dist/assets/*.js | head -20      # registra os tamanhos
```

Se algum desses passos falhar, **pare e investigue** antes de começar a deletar.
Pode ter havido commit não-mergeado ou drift.

---

## 3. Camada B — Painéis e variantes (sessão de 2–3h)

### Objetivo

Reduzir o frontend ao essencial do Grid 48: 6 painéis e 1 variante (`full`).
Tudo que é WorldMonitor-only sai. Ganho esperado: bundle inicial 30-40% menor,
TS check mais rápido, repo navegável.

### Painéis a MANTER (são os que Grid 48 usa)

Em `src/config/panels.ts`, o `FULL_PANELS` deve conter apenas:

```
map               — Mapa Grande Florianópolis (deck.gl)
celesc-status     — Painel de instabilidades Celesc
beacon-status     — Alertas Defesa Civil OSINT
tactical-status   — Status do engine + modo
engine-health     — Saúde rica do engine (uptime, pendrive, etc.)
sitrep            — Pedido SITREP via radio
```

### Painéis a DELETAR

Listados em `FULL_PANELS` mas sem uso real em Grid 48:

```
intel                  → Intel Feed (RSS news) — morto desde Wave 2.5
climate                → ClimateAnomalyPanel
population-exposure    → PopulationExposurePanel
airline-intel          → AirlineIntelPanel
tech-readiness         → TechReadinessPanel (?)
world-clock            → WorldClockPanel
gulf-economies         → GulfEconomiesPanel
oref-sirens            → OrefSirensPanel (alertas Israel)
telegram-intel         → TelegramIntelPanel
gcc-investments        → InvestmentsPanel
```

Verificar com grep antes de deletar cada um:
```bash
grep -r "ClimateAnomalyPanel\|PopulationExposurePanel\|..." src/ --include="*.ts"
```

Se algum aparecer em `App.ts`, `panel-layout.ts`, ou outros lugares vivos,
precisa remover a referência também.

### Componentes a deletar em `src/components/`

Provavelmente seguros para deletar (validar com grep externo antes):

```
AirlineIntelPanel.ts
AviationCommandBar.ts
ClimateAnomalyPanel.ts
CountryDeepDivePanel.ts          ← arquivo grande, tem CSS dedicado em country-deep-dive.css
GulfEconomiesPanel.ts
InvestmentsPanel.ts
OrefSirensPanel.ts
PopulationExposurePanel.ts
TechHubsPanel.ts                  ← exportado de components/index.ts; checar callers
TelegramIntelPanel.ts
```

Mais possíveis (verificar antes):
```
Globe*.ts                         ← se houver, era do worldmonitor (geo intel)
Country*.ts                       ← exceto se Grid 48 tiver feature de país
News*.ts                          ← removidos parcialmente na Wave 2.5
Threat*.ts                        ← classificação de ameaças, dead
```

### Variantes a remover

Em `src/config/variant-meta.ts`, manter apenas `full`. Deletar entradas:

```
tech         (Tech Monitor)
finance      (Finance Monitor)
happy        (Happy Monitor — positive news)
commodity    (Commodity Monitor)
```

Arquivos correlatos:

```
public/favico/{tech,finance,happy,commodity}/    ← apagar diretórios inteiros
src/config/variants/{tech,finance,happy,commodity}.ts    ← se existirem
package.json scripts: dev:tech, dev:finance, dev:happy, dev:commodity, build:tech, build:finance, build:happy, build:commodity, build:full
```

No `vite.config.ts`, simplificar `htmlVariantPlugin` (que faz substitute de meta tags por variante) ou eliminar de vez se só `full` sobrar.

### CSS órfão

`src/styles/panels.css` tem ~2200 linhas. Boa parte é seletor de painéis que vamos deletar.

Estratégia: após deletar componentes, fazer grep dos seletores no `panels.css` e remover blocos órfãos:

```bash
# Para cada bloco CSS .panel-name no panels.css, ver se há HTML usando:
grep -r "panel-name-aqui" src/ --include="*.ts" --include="*.html"
# Se 0 matches, deleta o bloco.
```

`country-deep-dive.css` provavelmente deleta inteiro (componente vai embora).

### CSS happy theme

`src/styles/happy-theme.css` — tema visual da variante happy. Apagar.

### Verificação por commit

Estratégia recomendada: **um commit por bloco coerente**, push após cada um,
deixar o CI validar.

Sugestão de commits:

1. `chore(panels): remover variantes tech/finance/happy/commodity` — só variant-meta + scripts + favicons
2. `chore(panels): remover painéis WorldMonitor das definições` — FULL_PANELS + panel-layout
3. `chore(components): deletar componentes WorldMonitor não-usados` — components/*.ts + index.ts
4. `chore(styles): remover CSS órfão de painéis deletados` — panels.css + country-deep-dive.css + happy-theme.css
5. `chore(vite): simplificar htmlVariantPlugin` — se aplicável

### Verificação técnica entre cada commit

```bash
npx tsc --noEmit                       # zero erros
npm run build                          # sucesso
```

`noUnusedLocals: true` no tsconfig vai pegar imports órfãos automaticamente —
use isso como guia.

---

## 4. Camada C — Refactor profundo (sessão de 6–10h)

### Objetivo

Remover infraestrutura WorldMonitor de fundo: ML pipeline, Tauri desktop,
proxies de API de news/intel global, serviços não-Grid48. Após Camada C, o
repo passa a "ser Grid 48", não mais "WorldMonitor adaptado".

### Pré-decisão obrigatória: Tauri

**Antes de começar Camada C**, perguntar ao usuário:

> "Você usa ou planeja usar Grid 48 como app desktop (Tauri)? Se não, todo o
> `src-tauri/` + workflows correspondentes saem."

Se a resposta for **NÃO**:
- Apagar `src-tauri/` (diretório inteiro: Rust source, ícones, configs)
- Apagar `.github/workflows/build-desktop.yml`
- Apagar `.github/workflows/test-linux-app.yml`
- Apagar `scripts/sync-desktop-version.mjs` e `scripts/download-node.sh`
- Remover scripts de desktop do `package.json` (`version:sync`, `version:check`, `build:sidecar-sebuf`, `build:desktop`)
- Remover `tsconfig.api.json` se for específico de Tauri
- Remover constantes `VITE_DESKTOP_RUNTIME`, `isDesktopRuntime()` em `src/services/runtime.ts`
- Remover lógicas condicionais `isDesktopRuntime()` espalhadas pelo código

Se a resposta for **SIM** ou **TALVEZ**:
- Pula essa subseção. Tauri fica.

### ML pipeline — sempre deletar

Grid 48 não faz classificação de news (já foi removido o pipeline de news em
Wave 2.5). Os bundles ML que sobraram são puro overhead:

**Deps a remover do `package.json` (dependencies):**
```
@xenova/transformers
onnxruntime-web
```

**Arquivos a deletar:**
```
src/services/ml-worker.ts
src/services/clustering.ts
src/services/threat-classifier.ts
src/services/analysis-worker.ts
src/services/correlation.ts
src/services/temporal-baseline.ts          ← se não usado fora de ML
src/services/ai-classify-queue.ts
```

**Em `vite.config.ts`:**
- Remover `manualChunks` para `transformers` e `onnxruntime`
- Remover `globIgnores` para `ml*.js` e `onnx*.wasm` em `workbox`
- Remover `onwarn` que silencia eval do `onnxruntime-web`

### Proxies de API e RSS — limpar

Em `vite.config.ts`, **deletar inteiros**:

- `polymarketPlugin()` + chamadas
- `youtubeLivePlugin()` + chamadas
- `gpsjamDevPlugin()` + chamadas
- `rssProxyPlugin()` + chamadas
- A `RSS_PROXY_ALLOWED_DOMAINS` (lista de ~150 domínios) inteira
- Todas as entradas em `server.proxy` exceto as que Grid 48 usa de fato

Verificar quais proxies o frontend de Grid 48 usa hoje:
```bash
grep -rn "/api/\|/rss/\|/ws/" src/ --include="*.ts" | grep -v node_modules
```

Provavelmente sobrarão pouquíssimos (talvez nenhum, dado que tudo passa pelo
adapter agora).

**Proxies que provavelmente saem:**
```
/api/yahoo, /api/polymarket, /api/earthquake, /api/pizzint, /api/fred-data,
/api/cloudflare-radar, /api/nga-msi, /api/gdelt, /api/faa, /api/opensky,
/api/adsb-exchange, /api/gpsjam, /ws/aisstream,
todos os /rss/* (50+ feeds)
```

### Serviços a deletar em `src/services/`

Validar cada um com `grep -rn "from '@/services/NOME'"` antes de remover:

```
analytics.ts                      ← se for Worldmonitor-specific tracking
bootstrap.ts                      ← /api/bootstrap foi removido (404)
country-geometry.ts               ← se Grid 48 não tem feature de país
country-instability.ts            ← CII score, WorldMonitor
country-brief.ts                  ← briefings de país
ai-flow-settings.ts               ← AI flow do WM
satellite-*.ts                    ← se houver, dead
security-advisories.ts            ← se não usado
oref-alerts.ts                    ← alertas Israel
data-freshness.ts                 ← talvez ainda usado pelo data-loader, verificar
celesc.ts                         ← MANTER (Grid 48 usa, frontend OU engine)
beacon-client.ts                  ← MANTER (ConvexProvider)
runtime.ts                        ← talvez simplificar se Tauri sair
runtime-config.ts                 ← se feature flags Worldmonitor saírem
i18n.ts                           ← talvez Grid 48 não precise (uma língua)
threat-*.ts                       ← dead
climate.ts                        ← se ClimateAnomalyPanel sair, vai junto
```

### Managers em `src/app/`

```
country-intel.ts                  ← se feature de país for embora
search-manager.ts                 ← verificar — pode ainda ser usado
refresh-scheduler.ts              ← manter (App.ts:548 usa)
event-handlers.ts                 ← provavelmente simplificar drasticamente
panel-layout.ts                   ← simplificar após Camada B
desktop-updater.ts                ← se Tauri sair
```

### Proto gerado WorldMonitor

```
src/generated/client/worldmonitor/          ← apagar diretório inteiro
src/generated/server/worldmonitor/          ← idem
docs/api/                                    ← OpenAPI WorldMonitor
proto/worldmonitor/                          ← schemas .proto WorldMonitor
proto/sebuf/                                 ← se for só usado por WM
```

Atualizar `proto/buf.gen.yaml` para não gerar mais isso (ou deletar o arquivo
de codegen central e ficar só com `engine/buf.gen.yaml`).

### Scripts em `scripts/`

```
scripts/fetch-gpsjam.mjs                    ← gpsjam-related
scripts/build-sidecar-sebuf.mjs             ← Tauri-related
scripts/download-node.sh                    ← Tauri-related
scripts/data/                                ← provavelmente WM data dumps
```

### Outros arquivos do repo

```
e2e/                              ← Playwright tests. Se forem todos WM, deletar. Senão, manter só Grid 48 tests.
pro-test/                         ← propósito? Verificar
shared/                           ← se vazio, apagar
middleware.ts                     ← se for Vercel WM middleware, apagar
public/favico/{variants}/         ← já tratado em Camada B
```

### Verificação técnica

Após cada commit grande:

```bash
# Type-check
npx tsc --noEmit

# Build (e medir bundle size!)
npm run build
du -sh dist/                                 # compare com baseline
ls -lh dist/assets/*.js | head -10           # tamanhos individuais

# Engine
cd engine && npx tsc --noEmit && cd ..
```

### Verificação visual obrigatória ao fim de Camada C

Antes do commit final, abrir a app em dev (`npm run dev`) e:

1. Mapa carrega
2. Painel Celesc mostra dados (modo cloud OK)
3. Painel Beacon mostra alertas
4. SITREP button responde (modo cloud → "unavailable", esperado)
5. Engine Health mostra "Modo Cloud"
6. Tactical Status mostra "MODE: CLOUD" e "CLOUD-OK"

Se algo quebrar visualmente, **não pusha**. Bisect o último commit.

---

## 5. Workflow recomendado

### Cadência

- **Commits pequenos e atômicos**: 1 commit por bloco coerente, não junta tudo.
- **Push frequente**: após cada commit, push → CI testa.
- **Não force push em main** sob nenhuma circunstância.

### Mensagens de commit

Padrão Conventional Commits, português. Exemplos do projeto:

```
refactor: cleanup world monitor zombie panels
chore(deps): remove @xenova/transformers + onnxruntime-web
chore(vite): remove RSS proxy plugin and allowlist
refactor: purge legacy news and RSS architecture
```

Acrescentar trailer:
```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

### Bump de versão

Após Camada B completa: minor bump → 1.3.0.
Após Camada C completa: minor bump → 1.4.0 (ou major se quiser sinalizar
mudança grande — opinião do usuário).

Comando:
```bash
# Edita src-tauri/tauri.conf.json (se Tauri ainda existir) e package.json
# Depois roda:
cd grid48-main && npm run version:sync
```

Se Tauri foi removido, atualizar apenas `package.json`.

---

## 6. Riscos a evitar

### Barrel imports

`src/components/index.ts`, `src/services/index.ts`, etc. re-exportam coisas.
Deletar um componente sem remover sua linha de export aqui causa erro de
build *só na Vercel* (que faz `tsc` strict), passando local.

**Sempre buscar:**
```bash
grep -rn "export.*from.*'./Nome'" src/components/index.ts
```

### Cleanup parcial vs total

Tentação: "vou comentar em vez de deletar". **Não faça isso.** Comentar deixa
o repo mais difícil de ler, não menos. Delete confiante, o git tem o histórico.

### `noUnusedLocals` é seu amigo

`tsconfig.json` tem `"noUnusedLocals": true`. Isso significa que após remover
o uso de algo, o import órfão vira erro. Use isso como guia: deletar o uso →
TS aponta o import órfão → deletar o import → repete.

### Não tocar nestes diretórios

Mesmo se parecem "WorldMonitor cruft", deixar:

- `engine/` inteiro (foi escrito pra Grid 48, é tudo necessário)
- `src/adapters/` (adapter pattern, novinho)
- `src/components/Celesc*.ts`, `Beacon*.ts`, `Sitrep*.ts`, `Health*.ts`, `Tactical*.ts`
- `src/services/celesc.ts`, `src/services/beacon-client.ts`
- `proto/grid48/` (schemas Grid 48)
- `docker/Dockerfile.engine`, `docker/engine-entrypoint.sh`, `docker/docker-compose.yml`
- `.github/workflows/main.yml` e `typecheck.yml`

### Não mexer em Convex sem motivo

`grid48-main/` não tem código Convex próprio (Convex mora em `beacon/` em
outro path). Não tocar.

---

## 7. Verificação final do trabalho completo

Antes de declarar "Camada B+C feita":

```bash
# 1. Métricas concretas
du -sh dist/                                 # compare com baseline
wc -l src/**/*.ts | tail -1                  # número total de linhas
git diff --stat <BASE_COMMIT>..HEAD          # diff cumulativo

# 2. Builds limpos
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.api.json && npm run build

# 3. CI verde em main
# Abrir GitHub Actions e confirmar último run

# 4. Smoke test manual (dev mode)
npm run dev
# Abrir browser, verificar checklist da Camada C
```

Resultado esperado de bundle: redução de 40-60% no JS inicial. Se ficou menos
que isso, provavelmente sobrou cruft pra encontrar.

---

## 8. Quando declarar concluído

- Camada B: commits 1-5 acima feitos, CI verde, bundle 30%+ menor, smoke test passa.
- Camada C: deps removidas, Tauri tratado (sai ou fica explícito), proxies limpos, CI verde, smoke test passa.

Após ambas: commitar release notes (`CHANGELOG.md` se houver, senão criar) com
o resumo das remoções e bump de versão.

---

## 9. Se algo der MUITO errado

- **Build quebra após delete**: provavelmente referência indireta. `grep -rn` o nome do símbolo deletado, encontra o caller, decide se deleta o caller também ou se mantém o símbolo.
- **CI verde local mas vermelho remoto**: pode ser case-sensitivity (Windows vs Linux). Procurar imports com casing errado.
- **Quebra visual em prod mas não em dev**: provavelmente CSS dependente de service worker cache. Hard refresh no browser.
- **TypeCheck quebra com erros de tipo bizarros**: provavelmente um arquivo `_pb.ts` (proto generated) foi deletado mas ainda há `import` dele. Procurar `from '@/generated'` e limpar.

Se ficar travado, parar e reverter o último commit (`git revert HEAD`) e abordar de outro ângulo. Não tentar "consertar errado por cima de errado".

---

## 10. Apêndice — Camada D residual (descoberta pós-1.3.0)

Auditoria depois de Camadas B+C revelou uma rede de código WorldMonitor
**ainda reachable do código vivo**, que não dava pra cortar sem refactor mais
profundo. Lista de arquivos no `src/services/` que precisam ir embora juntos
(deletar um isolado quebra os outros):

```
threat-classifier.ts              ← classificação de ameaças
analysis-core.ts                  ← motor de análise
analysis-constants.ts             ← constantes do motor
analysis.worker.ts (em src/workers/)
intelligence/index.ts             ← agregador de inteligência
correlation.ts                    ← correlação cross-source
entity-extraction.ts              ← extração de entidades
focal-point-detector.ts           ← detecção de hotspots
geo-convergence.ts                ← análise de convergência geográfica
cross-module-integration.ts       ← integração entre módulos
trending-keywords.ts              ← keywords trending
cached-risk-scores.ts             ← scores de risco cacheados
desktop-readiness.ts              ← readiness check (resíduo Tauri)
pizzint.ts                        ← Pentagon Pizza Index, dead
```

**Por que não foi feito agora:** `geo-convergence` é importado por:

```
src/components/DeckGLMap.ts        ← LIVE
src/components/Map.ts              ← LIVE
src/main.ts                        ← LIVE (entry point)
```

Cortar isso exige editar DeckGLMap/Map/main.ts pra remover os call sites,
o que vai além do escopo "delete arquivos órfãos". Camada D requer:

1. Identificar exatamente quais funções de `geo-convergence` são chamadas
   pelos componentes vivos.
2. Verificar se essas funções fazem algo útil em Grid 48 (provável que não —
   eram pra processar news/threats que não existem mais).
3. Remover as chamadas dos componentes vivos.
4. Aí sim deletar a cadeia inteira de cima.

Outras pendências de baixo impacto pra Camada D:

- **index.html**: hreflang alternates e CSP ainda referenciam `worldmonitor.app`
  e subdomínios. `htmlVariantPlugin` em `vite.config.ts` só substitui um
  subset dos tags meta; os hard-coded sobreviveram.
- **vercel.json**: header `X-WorldMonitor-Key` no CORS allowlist.
- **public/** assets: provavelmente tem favicons/og-images herdados que não
  são Grid 48-branded.
- **i18next**: 20+ arquivos de locale (`src/locales/*.json`) que duplicam
  textos do WorldMonitor. Grid 48 só usa pt-BR efetivamente. Bundle gera
  `locale-*.js` chunks de 100-145 KB cada — economia real se cortar.
- **`src/components/GlobeMap.ts`**: visualizador globo 3D do WorldMonitor.
  Grid 48 só usa mapa 2D (deck.gl + maplibre). Provável dead weight.

Quando atacar Camada D, começar por:

```bash
# Listar todas as chamadas a geo-convergence dos componentes vivos
grep -n "from.*geo-convergence" src/components/DeckGLMap.ts src/components/Map.ts src/main.ts

# Para cada função importada, ver se de fato é usada no body do arquivo
grep -nE "computeFocalPoints|detectClusters|<nome da função>" <arquivo>
```

Se for tudo dead-code-after-purge (chamadas que processam dados que não
existem mais), basta remover as chamadas + a import line, e a cadeia inteira
fica liberada pra delete em massa.

Ganho esperado de Camada D: provavelmente +5-10% redução de bundle, dezenas
de arquivos órfãos a menos, repo significativamente mais navegável.
