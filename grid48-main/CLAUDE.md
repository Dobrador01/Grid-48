<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->

---

# Grid 48 — Onboarding Doc

Ponto de entrada pra qualquer agente Claude (ou humano) que vá trabalhar no Grid 48. Cobre os **dois repos entrelaçados** do projeto: `beacon` (este, backend Convex) e `Grid 48` (frontend Vanilla TS).

## 1. O que é o Grid 48

Sistema de **comando & controle pessoal** pra Grande Florianópolis, focado em monitoramento agregado de:
- **DEFCON** — estado operacional 1–5 (1 = colapso, 5 = normal) calculado por regras determinísticas a partir de sinais reais (Defesa Civil, Celesc, OpenWeather, Google Routes)
- **Clima** — previsão por localidade-foco com sparkline 12h
- **Tráfego** — tempo de deslocamento Casa↔Trabalho + pontos estratégicos (pontes, BR-101), com detecção da localização atual via Geolocation API
- **Celesc** — instabilidades elétricas por município + bairro (poll JSONP no frontend, sync pro backend)
- **Defesa Civil** — alertas RSS classificados via Gemini

Single-user. Dono opera no navegador, dashboard se adapta ao contexto (estou em casa → mostra rota pro trabalho, etc.).

## 2. Stack & Arquitetura

### Repos
- **beacon** (https://github.com/Dobrador01/beacon-osint): backend Convex. Local: `C:\Users\Enio Jr\OneDrive\Documentos\beacon`
- **Grid 48** (https://github.com/Dobrador01/Grid-48): frontend Vanilla TS + Vite. Local: `C:\Users\Enio Jr\OneDrive\Documentos\Grid 48` (código em `grid48-main/`)

### Stack
- **Backend**: Convex (Reactive BaaS). Sem Node em runtime padrão — só V8 isolate. Actions com `"use node";` quando precisam de Node.
- **Frontend**: Vanilla TypeScript + Vite + maplibre-gl + deck.gl + Convex client (`convex/browser`). Sem React. Componentes herdam de `Panel` base.
- **Deploys**:
  - Convex Dev: `dev:watchful-ermine-713` (`https://watchful-ermine-713.convex.cloud`)
  - Convex Prod: `secret-shrimp-538` (`https://secret-shrimp-538.convex.cloud`) ← **é o que o Vercel usa**
  - Frontend Prod: Vercel `https://grid-48.vercel.app`
- **APIs externas**:
  - Gemini API (`GEMINI_API_KEY`) — explicações DEFCON + classificação alertas Defesa Civil
  - OpenWeather One Call 3.0 (`OPENWEATHER_API_KEY`) — clima por lat/lon (free 1000/dia)
  - Google Maps Platform (`GOOGLE_MAPS_API_KEY`) — Routes API (tráfego, Pro tier $10/1k, free 5k/mês) + Geocoding API (endereço→lat/lon, Essentials free 10k/mês)
  - Celesc (sem chave, JSONP do navegador) — instabilidades elétricas SC
  - Defesa Civil SC (RSS público) — alertas meteorológicos

### Cadência de coleta
| Fonte | Cadência | Onde | Armazenamento |
|--|--|--|--|
| Defesa Civil RSS | cron 15min | `convex/ingestor.ts:fetchWeatherOSINT` | `alertas_rss` (TTL 48h) |
| Celesc | poll 5min frontend | `services/celesc.ts` → `celesc/mutations:reportCelescSnapshot` | `celesc_state` (latest) + `celesc_history` (90d) |
| OpenWeather | cron 15min | `convex/clima/actions.ts:fetchOpenWeather` | `meteorologia_state` (latest) |
| Google Routes | **on-demand** (sem cron) | `TrafegoWidget` enquanto montado → `trafego/mutations:requestUpdate` (throttle 5min) | `trafego_state` (latest) |
| Recompute DEFCON | reativo (após cada ingestão) | `convex/defcon/mutations.ts:recomputeDefcon` via scheduler | `defcon_status` (singleton) |

## 3. Como rodar

### Backend (Convex)
```bash
cd "C:\Users\Enio Jr\OneDrive\Documentos\beacon"
npx convex dev           # watch mode em dev:watchful-ermine-713
npx convex deploy --yes  # deploy prod em secret-shrimp-538
```

**Env vars** (set via `npx convex env set <NOME> <valor>` em prod E dev):
- `GEMINI_API_KEY`
- `OPENWEATHER_API_KEY`
- `GOOGLE_MAPS_API_KEY`
- `PSK_GATEWAY` / `PSK_GATEWAY_V2` (PSKs do gateway LoRa HTTP)

### Frontend (Grid 48)
```bash
cd "C:\Users\Enio Jr\OneDrive\Documentos\Grid 48\grid48-main"
pnpm dev          # ou npm run dev — Vite local
pnpm typecheck    # tsc --noEmit (sempre rode antes de commit)
pnpm build        # build pra prod
```

**Env vars** (no `.env.local` da raiz):
- `VITE_CONVEX_URL` = URL do deploy Convex (prod ou dev)
- `VITE_SENTRY_DSN` (opcional)

### Deploy completo (sequência)
1. Mudou backend → `npx convex deploy --yes` em `beacon/`
2. Mudou frontend → `git push origin main` em `Grid 48/` → Vercel auto-builda
3. Verificar prod no [dashboard Convex](https://dashboard.convex.dev) → projeto grid-48 → Production

## 4. Estado do roadmap (Maio 2026)

### Limpeza pós-WorldMonitor (Maio 2026)

Grid 48 nasceu como fork do WorldMonitor. Sessão 2026-05-23/24 executou
5 fases de cleanup deletando ~247 arquivos / ~52k linhas de cruft
worldmonitor. Detalhes completos em `docs/CLEANUP_PLAN.md` (seção 11).

| Fase | Escopo | Commit |
|--|--|--|
| 1 | Assets/docs zero-risk (public/pro, docs/, CHANGELOG, etc.) | `9fd371a` |
| 2 | Tauri desktop runtime + bridges | `2f0e6f4` |
| 3 | Settings UI WorldMonitor (Inteligência, Mídia, etc.) | `bb60214` |
| 4 | `isDesktopApp` dead code + settings.html standalone | `aec56b3` |
| 5 | 60+ services órfãos + 12 subdirs + workers/ + stubs | `384a18f` |

**Pendência principal**: `Map.ts` / `DeckGLMap.ts` / `MapContainer.ts`
ainda têm 100+ refs cada a tipos/services worldmonitor. Layers ficam
off-by-default em `FULL_MAP_LAYERS` (dead code at runtime), mas
compile-time precisam de refactor camada-por-camada (~6-10h sessão).
Ver `docs/CLEANUP_PLAN.md` seções 10-11.

### Fases concluídas

| Fase | Escopo | Status |
|--|--|--|
| **0** (inicial) | DEFCON básico: widget + 3 regras hard-coded (6.1/6.2/6.3) + Convex schema | ✅ Deployado |
| **1** | Backend OpenWeather (cron 15min, 2 localidades, current + hourly[12] + chuva 24h) | ✅ Deployado |
| **2** | Backend tráfego on-demand (Google Routes Pro, throttle 5min, 4 rotas) | ✅ Deployado |
| **3** | ClimaWidget compacto + sparkline SVG 12h | ✅ Deployado |
| **4** | TrafegoWidget + Geolocation + lógica casa/trabalho/fora + pontos paralelos | ✅ Deployado |
| **5** | DSL JSON + Engine + Import/Export + Histórico/Rollback + Validator Levenshtein | ✅ Deployado |

### Refactors no caminho
- `tactical-status` + `engine-health` consolidados em **um único "Comando & Controle"** (HealthWidget com badge MODE)
- Endereços Casa/Trabalho via Google Geocoding API (Essentials free 10k/mês)

### Pendente (Fase 6 — futuro)
- **Hardware LoRa**: pluviômetro/anemômetro físicos. Quando chegar, reusar `meteorologia_state` com `fonte="lora_local"` (já no schema). Prioridade > openweather em `buildAggregatedSignals` (hiperlocal vence regional).

## 5. Modelo de domínio: DEFCON

### Convenção militar (1 = pior)
- **DEFCON 1** Colapso / Evacuação (vermelho)
- **DEFCON 2** Crise aguda (laranja)
- **DEFCON 3** Ameaça iminente (amarelo)
- **DEFCON 4** Alerta incrementado (azul → no widget atual é verde-lima)
- **DEFCON 5** Normalidade vigilante (verde)

### Categorias
- **energia** — apagões Celesc
- **clima** — Defesa Civil + OpenWeather (chuva, vento)
- **mobilidade** — Google Routes
- **combinada** — regras cross-categoria pra DEFCON 1 (ex: chuva ≥100mm AND vento ≥90)

### Agregação
`nivel_global = min(energia, clima, mobilidade, combinada?)` — pior categoria define o estado geral.

### Cálculo
1. `recomputeDefcon` lê todas as tabelas operacionais
2. Constrói `AggregatedSignals` (legacy) E `DSLSignals` (achatado por chave)
3. Carrega `defcon_ruleset` do banco (ou auto-gera inicial se ausente)
4. Engine DSL avalia cada regra ativa em ordem de prioridade — primeira que casa por categoria define o nível
5. `hashSignalsDSL + hashRuleSet` → `inputs_hash` → se mudou, agenda action `explainDefcon` (Gemini gera 2 frases factuais)

## 6. Schema Convex (tabelas atuais)

Definidas em `convex/schema.ts`. Todas com índices pra queries comuns (sem `.filter()` — sempre `withIndex`).

| Tabela | Tipo | Propósito |
|--|--|--|
| `alertas_rss` | TTL 48h | Defesa Civil → Gemini → upsert |
| `telemetry` | append-only | Pacotes LoRa (Fase 6 futura) |
| `sitrep_queue` | TTL 5min | Queue de requests pra processamento Gemini |
| `celesc_state` | mutável | Latest por (municipio, bairro?) — ~300 rows |
| `celesc_history` | append-only 90d | Timeline futura, só município (sem bairro) |
| `defcon_config` | singleton | Localidades-foco (lat/lon/tipo/endereço), thresholds legacy (6.1-6.3), rotas monitoradas |
| `defcon_status` | singleton | Nível DEFCON atual + explicação Gemini cacheada |
| `meteorologia_state` | mutável | OpenWeather por (fonte × localidade) — ~2 rows |
| `trafego_state` | mutável | Latest por rota_id — ~5 rows |
| `defcon_ruleset` | singleton | RuleSet DSL JSON ativo (Fase 5) |
| `defcon_ruleset_history` | append-only | Audit/rollback (item B do plano) |
| `osint_health` | singleton | Heartbeat do ingestor Defesa Civil |

## 7. Componentes Frontend principais

Todos em `Grid 48/grid48-main/src/components/`. Registrados em `config/panels.ts` (`FULL_PANELS`) + instanciados em `app/panel-layout.ts`.

| Componente | Painel ID | Responsabilidade |
|--|--|--|
| `DefconWidget` | `defcon` | Gauge SVG semicircular 5 quadrantes + pills por categoria + explicação Gemini |
| `ClimaWidget` | `clima` | Card compacto + sparkline 12h (chuva barras + temp linha) — cycle entre localidades |
| `TrafegoWidget` | `trafego` | Rota principal contextual (casa/trabalho/fora via Geolocation) + 3 paralelas |
| `BeaconStatusWidget` | `beacon-status` | Lista de alertas Defesa Civil ativos |
| `CelescStatusWidget` | `celesc-status` | Tabela de municípios SC com instabilidades |
| `HealthWidget` | `engine-health` (rótulo "Comando & Controle") | Badge MODE + breakdown LoRa quando aplicável |
| `SitrepButton` | `sitrep` | Botão pra disparar request SITREP ad-hoc via Gemini |
| `DefconSettings` (factory) | dentro tab DEFCON | Endereços + localidades-foco + thresholds legacy |
| `DefconRulesPanel` (factory) | dentro tab DEFCON | Import/Export JSON + lista regras + histórico |

### Padrão de fanout
Componente herda de `Panel`, expõe `setSnapshot(BeaconSnapshot)`. `App.ts:362+` faz fanout do snapshot pra TODOS os painéis em paralelo. Snapshot vem de `services/beacon-client.ts` (singleton ConvexClient + subscriptions a múltiplas queries).

### Padrão import estático (lição aprendida)
**SEMPRE import estático** pra widgets registrados em `panel-layout.ts`. O loop síncrono em `sidebarOrder.forEach` insere no DOM antes do dynamic import resolver — widget fica órfão. Exceção: DefconWidget e BeaconStatusWidget usam `insertAdjacentElement('afterbegin')` explícito dentro do `.then()`, então funcionam mesmo com dynamic import.

## 8. Sistema de regras DSL (Fase 5)

### Por que existe
Antes: regras hard-coded em `convex/defcon/rules_catalog.ts`. Pra mudar, precisava deploy. Inflexível.

Agora: ruleset persistido em `defcon_ruleset` (JSON). User edita via UI Settings (Import/Export). Validator backend confere antes de salvar.

### Estrutura JSON
```json
{
  "versao": "1.0.0",
  "regras": [
    {
      "id": "evacuacao-tempestade",
      "nome": "Evacuação — tempestade severa",
      "descricao": "Chuva extrema + (vento forte OU alerta oficial)",
      "categoria": "combinada",
      "prioridade": 1,
      "ativa": true,
      "acao": { "nivel_defcon": 1 },
      "condicao": {
        "tipo": "AND",
        "filhos": [
          { "tipo": "comparacao", "sinal": "clima.Casa.chuva_24h_mm", "op": "GTE", "valor": 100 },
          {
            "tipo": "OR",
            "filhos": [
              { "tipo": "comparacao", "sinal": "clima.Casa.vento_kmh", "op": "GTE", "valor": 90 },
              { "tipo": "comparacao", "sinal": "defesa_civil.alto_cobre_grande_floripa", "op": "EQ", "valor": 1 }
            ]
          }
        ]
      }
    }
  ]
}
```

### SinalRefs disponíveis (catálogo)
Documentado em `convex/defcon/dsl/types.ts`. Resumo:
- **Defesa Civil** (estáticos): `defesa_civil.alto_cobre_grande_floripa`, `.ativos_total`, `.por_nivel.{Alto|Medio|Baixo}`
- **Celesc bairro** (dinâmicos): `celesc.bairro.<localidade_label>.ucs_afetadas`
- **Celesc município** (dinâmicos): `celesc.municipio.<ibge>.{pct|ucs_afetadas}`
- **Clima** (dinâmicos): `clima.<localidade_label>.{chuva_24h_mm|vento_kmh|temperatura_c|umidade_pct}`
- **Tráfego** (dinâmicos): `trafego.<rota_id>.{ratio|travel_time_sec|velocidade_media_kmh}`
- **Sitrep** (estáticos): `sitrep.{energia|clima|mobilidade}.latest_valor`

### Operadores
`GT`, `GTE`, `LT`, `LTE`, `EQ`, `NEQ`, `BETWEEN` (valor = [min, max]), `TRUE` (sempre).

### Conectivos lógicos
`AND` (filhos all match), `OR` (any match), `NOT` (inverte filho).

### Validator
`convex/defcon/dsl/validator.ts:validateRuleSet` confere:
- Estrutura do JSON
- SinalRefs contra catálogo dinâmico (gera lista baseado em config atual)
- Levenshtein pra typos (sugere "você quis dizer X?")
- Operadores válidos
- IDs únicos
- Nível DEFCON 1..5

### Workflow recomendado
1. UI Settings → tab DEFCON → role até "Regras DEFCON (DSL)" → **Exportar JSON**
2. Editar em VSCode / editor preferido
3. **Importar JSON** → Validar + Salvar → backend dispara recompute imediato
4. Se mudou regra mas signals iguais, `inputs_hash` muda mesmo assim (hash inclui ruleset) → Gemini regera explicação

## 9. Pegadinhas conhecidas (já corrigidas)

Documentar pra próximo agente não cair de novo.

### CSP (Content Security Policy)
- **CSP fica em `index.html` meta tag**, não em `vercel.json`. As duas existem mas meta tag vence quando ambas presentes.
- Em CSP3, hashes + `'unsafe-inline'` → `'unsafe-inline'` é IGNORADO. Só hashes valem.
- Cada inline script precisa ter seu sha256 explícito no CSP.
- **NUNCA use `onclick="..."`/`onmouseenter="..."` inline** — bloqueados pelo CSP. Use event delegation com `addEventListener` no constructor + classes + `data-*` attrs.
- Hover effects: prefira CSS `:hover` (inject `<style>` no head uma vez).
- **Atenção**: hash sha256 em base64 pode confundir letra `I` com número `1` em fontes monoespaçadas. Validar via `node -e` calculando o hash real do script.

### Convex `db.patch` com `undefined`
**Não limpa o campo** — preserva valor antigo. Pra limpar/resetar campos opcionais use `db.replace` (substitui doc inteiro).

### Dynamic vs static import em widgets
Vide seção 7. **Sempre estático** pra novos painéis a menos que use `insertAdjacentElement` explícito.

### Google Routes API `departureTime`
Não passar `departureTime: "now"` — chega no passado por latência. **Omitir o campo** — TRAFFIC_AWARE assume agora implícito.

### Convex codegen e api.d.ts
`npx convex dev` regenera `convex/_generated/api.d.ts` sobrescrevendo edits manuais. Durante desenvolvimento local sem rodar `convex dev`, edita-se manualmente o `api.d.ts` pra typecheck passar — mas isso é volátil e o codegen real vai substituir.

### Encoding UTF-8 mojibake
Arquivos editados em editores com encoding errado viram `ÃƒÂ¢ÂÅ' InstÃƒÂ¢ncia`. Detectar via grep, corrigir via `node -e` com buffer hex se Edit tool não conseguir matchar.

### Service Worker / PWA cache
Após deploy, hard refresh (`Ctrl+Shift+R`) frequentemente necessário pra invalidar cache. Em casos extremos: DevTools → Application → Service Workers → Unregister.

### Convex query stale `getOsintHealth`
Frontend subscrevia query que não existia. Solução implementada: criar a query no backend (`convex/queries.ts:getOsintHealth`) + tabela `osint_health` populada pelo ingestor.

## 10. Dívidas técnicas documentadas

- **Mutations públicas sem auth** — `reportCelescSnapshot`, `updateDefconConfig`, `updateRuleset`, `trafego/requestUpdate`. Single-user assumption. Quando migrar pra multi-user: Convex Auth resolve tudo.
- **"Vermelho" da Defesa Civil = "Alto" Gemini** (proxy). Quando bater divergência real, refinar prompt do `ingestor.ts` pra extrair cor oficial.
- **Categoria mobilidade sem regras hard-coded antigas** (legacy 6.x). Hoje vem do DSL.
- **Coleta Celesc no frontend** (JSONP do navegador). Eventualmente migrar pra cron Convex action.
- **`rules.ts` + `rules_catalog.ts` dead code** (legacy pré-DSL). `rules.test.ts` ainda referencia. Limpar quando refatorar testes.
- **OpenWeather `chuva_24h_mm`** usa `daily[0].rain` (previsão pro dia) como aproximação. Pra "últimas 24h reais" precisaria buffer history próprio.
- **TrafegoWidget só atualiza com dashboard aberta** (decisão explícita pra economizar cota Google). DEFCON mobilidade fica stale se ninguém está olhando.
- **Estação INMET A806 (Florianópolis)** está em "Pane" desde antes do projeto. INMET descartado como fonte primária; se voltar, vira fonte gratuita alternativa.

## 11. Comandos de verificação rápida

```bash
# Backend: typecheck antes de deploy
cd "C:\Users\Enio Jr\OneDrive\Documentos\beacon"
npx --yes --package=typescript@5.5 tsc -p convex/tsconfig.json --noEmit

# Forçar fetch OpenWeather imediato (em prod)
./node_modules/.bin/convex run --prod clima/actions:fetchOpenWeather

# Forçar fetch tráfego em todas as rotas
./node_modules/.bin/convex run --prod trafego/mutations:requestUpdate '{"rotas_solicitadas":["casa_trabalho","ponte_pedro_ivo","ponte_colombo_salles","br101_sj_palhoca"]}'

# Inspecionar estado DEFCON atual
./node_modules/.bin/convex run --prod defcon/queries:getDefconStatus

# Listar ruleset atual
./node_modules/.bin/convex run --prod defcon/ruleset:getRuleset

# Disparar recompute manual (útil pra testar regras novas)
./node_modules/.bin/convex run --prod defcon/dev:injectTestSignal '{"kind":"alerta","nivel_risco":"Baixo","cidades_afetadas_ibge":[4205407]}'

# Limpar sinais sintéticos
./node_modules/.bin/convex run --prod defcon/dev:clearDefconState

# Frontend: typecheck antes de commit
cd "C:\Users\Enio Jr\OneDrive\Documentos\Grid 48\grid48-main"
./node_modules/.bin/tsc --noEmit
```

## 12. Roadmap futuro

### Fase 6 — Hardware LoRa (quando hardware chegar)
- Pluviômetro + anemômetro físicos transmitindo via LoRa
- Reusar `meteorologia_state.fonte = "lora_local"` (já no schema)
- Prioridade > `openweather` em `buildAggregatedSignals` quando ambos presentes pra mesma localidade
- Telemetria entra via `convex/mutations.ts:ingestTelemetry` (HTTP endpoint `/gateway` com PSK já existe)

### Backlog de melhorias
- **Auth real**: Convex Auth pra eliminar a dívida das mutations públicas
- **Rotas alternativas Google Routes**: `computeAlternativeRoutes: true` pra mostrar "via BR-101: 25min · via bairro: 12min"
- **Editor visual de regras**: implementação com Drawflow ou Blockly se a edição via JSON virar dor (hoje funciona bem)
- **Migrar coleta Celesc pro backend**: action com scraping próprio, elimina dependência JSONP do navegador
- **Timeline visual**: usar `celesc_history` (90d retention já implementado) pra renderizar gráfico de UCs ao longo do tempo no mapa
- **Modo war-room compartilhado**: persistir histórico de DEFCON transitions, log de incidentes

## 13. Como continuar trabalhando (nova sessão Claude)

### Setup inicial recomendado
Quando começar nova sessão:
1. Leia este CLAUDE.md primeiro (vai pra `beacon/CLAUDE.md` e `Grid 48/grid48-main/CLAUDE.md`)
2. Leia `convex/_generated/ai/guidelines.md` no beacon (regras Convex obrigatórias)
3. Se vai mexer em limpeza WorldMonitor → leia `docs/CLEANUP_PLAN.md` (seção 11 tem o status da última sessão)
4. Execute `git status` em ambos os repos pra ver onde paramos
5. Confira o último plan file em `~/.claude/plans/` se houver

### Localização dos plan files anteriores
`C:\Users\Enio Jr\.claude\plans\c-users-enio-jr-onedrive-documentos-gri-mellow-knuth.md` contém o roadmap detalhado da sessão de Maio 2026 (Fases 1-5 originais Grid 48) — referência boa pra decisões e trade-offs históricos.

### Padrões de trabalho
- **NUNCA** crie `.md` sem ser pedido (exceto este CLAUDE.md que foi explicitamente pedido)
- **SEMPRE** typecheck antes de commit (`tsc --noEmit`)
- **SEMPRE** valide deploy Convex em prod (`secret-shrimp-538`) antes de marcar fase completa
- Git: 2 repos sincronizados independentemente. Use mensagens descritivas com co-author "Claude Opus 4.7".
- Skill Convex em `~/.claude/agent-instructions/` se disponível — use proativamente.

### Pra mudar regras DEFCON sem mexer em código
1. Abrir dashboard Grid 48 → engrenagem → tab DEFCON → role até "Regras DEFCON (DSL)"
2. Exportar JSON
3. Editar (cuidado com SinalRefs — validator vai pegar typos com sugestão Levenshtein)
4. Importar de volta
5. Dispara recompute automático

### Tom de comunicação esperado (do usuário)
- Português BR conversacional
- Direto, sem floreio
- Aprecia trade-offs explícitos e perguntas estruturadas via AskUserQuestion
- Gosta de plan mode quando trabalho é grande
- Ok com decisões pragmáticas ("aceitável por enquanto") quando ROI baixo

---

**Última atualização**: 2026-05-24 (sessão de limpeza pós-WorldMonitor — Fases 1-5 do `docs/CLEANUP_PLAN.md` + fix do throttle Gemini DEFCON + fix do expiresAt da Defesa Civil em `beacon/`).
