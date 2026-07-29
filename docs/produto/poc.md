# PoC — escopo, ordem e definição de "demo pronta"

Objetivo do PoC: provar a arquitetura do backlog v2.3 com a fatia vertical
mais fina possível — **preço carimbado na ingestão, um armazenamento só, e
as três faces (traces, sessions, billing) contando a mesma história de
dinheiro por construção**.

## O que entra (na ordem de construção)

1. **T4 — Tabela de preços versionada (seed via `make seed-prices`, decisão 74 — migrações só criam índices; store é MongoDB)**
   - `price_versions`: model, token_type (input | output | cache_read |
     cache_write), price_brl_per_million, effective_from. Imutável (insert
     only); constraint de unicidade (model, token_type, effective_from).
   - Seed com 2+ modelos e pelo menos UMA troca de preço no meio do período
     dos dados de teste — para a demo provar a imutabilidade do carimbo.

2. **Cliente de fonte de traces (interface + fixtures; QA14 resolvida — clientes reais entregues)**
   - Interface `TraceSourceClient`; em produção a cadeia é ClickHouse
     direto → HTTP LangWatch (janela limitada a ~100 pela busca — guard no
     código) → `FakeTraceSourceClient` lendo fixtures JSON no contrato T1
     (traces com spans, session_id, agente,
     modelo, tokens por tipo, timestamps, status, conteúdo de entrada/saída,
     channel, domain/subdomain).
   - Fixtures devem incluir casos de borda: trace com erro em um span; trace
     sem session_id; trace de modelo SEM preço cadastrado (vira
     pending_price); traces da mesma sessão em ordem embaralhada.
   - O cliente real é um swap futuro (spike QA14). Nada no resto do código
     pode depender de detalhes do fake.

3. **T2-lite + T5 — Sync com carimbo no ato**
   - Job/comando que puxa uma janela do cliente LangWatch e grava traces já
     precificados: resolve a versão de preço vigente na DATA do trace
     (QA19), carimba preço aplicado + custo por tipo de token + custo total.
   - Idempotente: rodar duas vezes a mesma janela não duplica nada
     (chave natural = trace id).
   - Sem preço aplicável → grava como `pending_price`; comando/endpoint
     simples de "reprocessar pendentes" carimba quando o preço aparecer.
   - Detecção de buracos e alertas de retenção podem ser stub (log).

4. **T3 — Armazenamento**
   - Entidades: traces (com carimbo), spans (ordenados, tempo/status/erro),
     conteúdo (entrada/saída). Índices para: período + agente + status +
     tipo + busca por id.

5. **T10/T11 — Endpoints de leitura**
   - `GET /traces` — filtros: from/to, agent, status, type, domain,
     subdomain, busca por trace/session id; paginação; ordenação recente
     primeiro. Cada item: id, agent (+path), type, status, duration,
     tokens in/out, cost_brl, timestamp.
   - `GET /traces/:id` — métricas, spans ordenados, conteúdo, session_id.
   - `GET /sessions` — read-model derivado (GROUP BY session_id): nº de
     traces, status (com erro se qualquer trace falhou), duração somada,
     tokens somados, custo somado, início, última atividade. Filtro de
     período pelo horário de início (QA17).
   - `GET /sessions/:id` — agregados + cadeia cronológica de traces.
   - Traces sem session_id: aparecem em /traces normalmente; fora de
     /sessions (regra dita com honestidade no payload do trace).

6. **Billing mínimo**
   - `GET /billing/summary?year=YYYY&month=M` — total do mês + quebra por
     agente × modelo × tipo de token, tudo = SOMA dos custos carimbados.
   - Traces `pending_price` reportados à parte (contagem/volume), nunca
     como R$ 0,00 dentro do total.
   - Check de consistência (teste automatizado): summary ≡ Σ custos dos
     traces do mês.

## O que fica de fora do PoC

Fechamento/snapshot (T6), projeção do extrato (T7 completo), tendências
(T8), composição (T9), exportação (US17), auth/RBAC, voz, mascaramento,
telas. Ver `backlog-v2.3.md` para os critérios completos de cada um.

## Roteiro da demo (o que "pronto" significa)

1. Rodar migrations (índices) + `make seed-prices` (decisão 74).
2. Rodar o sync → fixtures ingeridas e carimbadas; mostrar no banco o
   trace com preço/custo gravados e o caso `pending_price`.
3. Trocar o preço de um modelo (insert de nova versão com effective_from
   futuro ou passado) → rodar o sync de novo → traces antigos INALTERADOS;
   só traces novos pegam o preço novo. (Prova da decisão 25.)
4. `GET /traces` filtrado + `GET /traces/:id` mostrando spans e conteúdo.
5. `GET /sessions/:id` mostrando a cadeia e o custo = soma dos traces.
6. `GET /billing/summary` do mês ≡ soma dos custos — teste de consistência
   verde.
7. Registrar o preço que faltava → reprocessar pendentes → pendente some da
   fila e entra nos totais.
