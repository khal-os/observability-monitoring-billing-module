# Demo do PoC — roteiro executável

> **DESATUALIZADO (pré-dockerização).** Este roteiro descreve o fluxo antigo
> com mongod no host (`127.0.0.1:27017`) e `npm run migrate/sync` locais.
> O fluxo atual é dockerizado e single-tenant por cliente — siga o
> [README.md](../README.md): `make up CLIENT=<nome>`, `make migrate
> CLIENT=<nome>`, `make seed-prices CLIENT=<nome>` (dev-only, decisão 74 —
> **sem ele a tabela de preços fica vazia e todo trace entra
> `pending_price`**), `make sync CLIENT=<nome> FROM=... TO=...`; acesso
> direto ao banco via `docker exec -it <cliente>-mongo mongosh <cliente>`.
> O roteiro abaixo permanece como referência da narrativa da demo (o QUE
> demonstrar).

Roteiro do `docs/produto/poc.md` ("Roteiro da demo"), passo a passo, com os
comandos reais. Todos os comandos rodam em `packages/api`.

## Pré-requisitos

- `npm install` na raiz do monorepo (workspaces).
- **MongoDB em `127.0.0.1:27017`** (o `.env.development` aponta para o banco
  `cleandb`). Qualquer mongod ≥ 6 serve, por exemplo:
  ```bash
  docker run -d --name poc-mongo -p 27017:27017 mongo:7
  ```
  (Os testes `npm test` NÃO precisam disso — usam um Mongo em memória.)
- Para a demo começar do zero: banco `cleandb` vazio (ou `docker rm -f` e
  suba de novo).

## Roteiro

**1. Migrations + seed de preços**

```bash
npm run migrate
ENVIRONMENT=development npx tsx src/main/jobs/seed-poc-prices.ts
```

O `migrate` aplica SÓ índices (índices únicos de `price_versions` + índices
de consulta de traces) — desde a decisão 74 a cadeia de migrações é
indexes-only e **não carrega mais o seed de preços**. O seed é o job
dev-only à parte (segunda linha acima; no fluxo dockerizado, `make
seed-prices CLIENT=<nome>`): 2 modelos precificados, com **troca de preço do
gpt-5-mini em 15/06**; `meta/llama-4-scout` deliberadamente sem preço. Sem o
seed, todo trace do passo 2 entra `pending_price`.

**2. Sync da janela 1 → fixtures ingeridas e carimbadas**

```bash
npm run sync -- --from 2026-06-01 --to 2026-06-15
```

Esperado no log: `fetched 6, inserted 6, ... pending price 1`.
No banco (`db.traces`): `trace-w1-001` com `stampedCosts` (preço aplicado
R$ 2,75/M vigente em 01/06) e `totalCostMicrocents`; `trace-w1-006`
(llama) com `pricingStatus: "pending_price"`, tokens guardados e **nenhum**
campo de custo — nunca R$ 0,00.

**3. Troca de preço → re-sync → imutabilidade (decisão 25)**

```bash
npm run price:insert -- --model openai/gpt-5-mini --token-type input \
  --price-brl 99.00 --effective-from 2026-06-16
npm run sync -- --from 2026-06-15 --to 2026-07-01
npm run sync -- --from 2026-06-01 --to 2026-06-15   # re-sync: idempotente
```

Esperado: traces da janela 1 **inalterados** (re-sync reporta `inserted 0,
skipped 6`); só `trace-w2-001` (16/06, ingerido após o insert) carimba o
preço novo de R$ 99/M. Atenção ao as-of (QA19): o preço vale pela **data do
trace** — um insert com `effective-from` anterior a 15/06 não vence a versão
de 15/06 para traces de 16/06.

**4–6. Endpoints (suba a API)**

```bash
npm run start:dev
# em outro terminal:
curl "http://127.0.0.1:3000/api/v1/traces?agent=agent-cobranca&status=error"
curl "http://127.0.0.1:3000/api/v1/traces/trace-w1-005"      # spans + conteúdo + custos
curl "http://127.0.0.1:3000/api/v1/sessions/sess-checkout-001" # cadeia; custo = Σ traces
curl "http://127.0.0.1:3000/api/v1/billing/summary?year=2026&month=6"
```

Observações honestas para a narração:

- Os volumes das fixtures são pequenos, então `cost_brl` (2 casas) de traces
  individuais aparece como `0.00`/`0.01`; a precisão cheia da linha está em
  `cost_brl_exact` no detalhe do trace e nas linhas do billing (T5: linha em
  precisão cheia, só totais arredondam).
- No billing, `Σ cost_brl_display` das linhas **fecha exatamente** com
  `total_cost_brl` (largest remainder), e `pending_price` é reportado à
  parte, fora do total.
- O teste de consistência automatizado (billing ≡ Σ carimbos, recomputado
  independentemente) está em
  `src/main/server/routes/v1/billing-routes.test.ts` — roda no `npm test`.

**7. Registrar o preço que faltava → reprocessar pendentes**

```bash
npm run price:insert -- --model meta/llama-4-scout --token-type input \
  --price-brl 1.00 --effective-from 2026-06-01
npm run price:insert -- --model meta/llama-4-scout --token-type output \
  --price-brl 4.00 --effective-from 2026-06-01
npm run reprocess:pending
curl "http://127.0.0.1:3000/api/v1/billing/summary?year=2026&month=6"
```

Esperado: `Reprocess pending: examined 2, stamped 2, still pending 0`;
`pending_price.trace_count` cai a 0 e as linhas do llama entram no total.
O carimbo usa o preço vigente na **data de cada trace** (as-of), nunca "o
preço mais recente".

## Notas

- `price:insert` é insert-only (runbook do T4): repetir um
  `(model, token-type, effective-from)` existente é rejeitado pelo unique
  index — registre um novo `effective-from`.
- Janelas de sync são half-open `[from, to)` e idempotentes; re-rodar
  qualquer janela nunca duplica.
- Build de produção: `npm run build && ENVIRONMENT=development node dist/main/index.js`
  também funciona (rotas registradas estaticamente).
