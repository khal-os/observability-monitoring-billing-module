# Auditoria de inconsistências — observability-module × documentação Khal OS

**Data:** 27/07/2026
**Fonte comparada:** site de documentação Khal OS (`khal-os-docs_2.html` — Geral, Plataforma, App/Module/Connector/Agent Register, Auth System, ADRs 1–77)
**Código auditado:** este repositório (`packages/api`, stack LangWatch de `compose.connector.yml`)

## Enquadramento

Na arquitetura Khal OS este repositório é o **Module de Tracing** (`packages/api`) mais o **connector LangWatch** que ele lê. Fora do escopo desta auditoria, por decisão de revisão:

- `packages/ui` — mock de visualização da API, não é o app do marco.
- `packages/register` — mock de teste local, não é o Connector Register.

**Regra aplicada em toda a auditoria:** as convenções da §9 obrigam os **registers**, não a API interna de um module. O que acontece dentro do module é problema do module. A §1.3 obriga modules apenas a: versionamento na URL (`/vX`), mudanças aditivas, tolerant reader e deprecação de 90 dias.

**Contexto que pesa em tudo:** o contrato de query do Module de Tracing está `[PENDENTE — Martino]` (MO5), e a própria doc diz que ele fecha com os requisitos dos 2 apps do marco (P5/C4). Ou seja: **o `/api/v1` deste repositório é o rascunho de facto do contrato que a doc está esperando.** Vários itens abaixo não são "código viola contrato fechado", e sim "o contrato de facto diverge das convenções que terá de cumprir".

## Resumo

| # | Achado | Ação |
|---|---|---|
| 1 | "expõe agregados, não trace cru" contradiz o propósito do Farol | FIX DOC |
| 1b | "não trace cru" é regra de privacidade (sem conteúdo de conversa)? | REGISTER |
| 3 | Valores de exibição no contrato, fixados em pt-BR / UTC-3 | FIX CODE |
| 5 | Module não autentica quem chama; sem checagem de `tracing:read`; CORS `*` | FIX CODE |
| 6 | Sem `ModuleManifest`, sem health endpoint, sem `apiVersion`/`lifecycle` | FIX CODE |
| 7a | `connector-register-arquitetura.md` ainda descreve o modelo HAL aposentado | FIX DOC |
| 7b | Durabilidade do billing: OTLP best-effort, sem reconciliação (Q49 da própria doc) | REGISTER |
| 9 | Convenção de metadata de atribuição do agent não ratificada dos dois lados | REGISTER |
| 10 | `X-Request-Id` não propagado (a doc nomeia o module na cadeia) | FIX CODE |
| 11 | Postura de dados em repouso × baseline §4.5 (KMS, Secrets Manager, residência) | REGISTER |

---

## 1 — "agregados, não trace cru" · **FIX DOC**

**Doc** (module-register §M-B1/US-M5 e §M-E4/MO5, compilado na ADR-77, marcado `[confirmado — Martino: M-M5]`):

> o módulo **lê o ClickHouse** (analítico, **read-only**) e **escreve a saída própria no MongoDB**; expõe **agregados/consultas** (custo/contagem — **não** trace cru) com filtros. Os apps (Farol/Billing) leem **só o módulo**, **nunca** o connector/ClickHouse direto. Escopos no estilo `tracing:read`.

> **Aceite:** … então recebo **agregados** (custo/contagem, com filtros), **nunca trace cru**; o app não toca ClickHouse nem o connector.

**Código:** `GET /api/v1/traces/:id` devolve o trace inteiro — `content.input`/`output` e payload próprio por span (`packages/api/src/presentation/controllers/traces/trace-view-schemas.ts:93` e `:61`); `GET /api/v1/sessions/:id` devolve a cadeia com conteúdo por trace (`sessions/session-view-schemas.ts:51`).

**Análise:** a regra vem de **uma** resposta do Martino (a ADR-77 é transcrição dela, não fonte independente — sua própria coluna de racional diz "compila o modelo confirmado sem inventar"), dada no contexto do **manifesto** do module. Todas as cláusulas ao redor tratam da **fronteira** ("o app não toca ClickHouse nem o connector"), então "trace cru" com maior probabilidade significa *a linha crua do fornecedor* — que este repositório nunca devolve: ele serve o modelo próprio do contrato T1, atrás de um adapter isolado por testes de arquitetura. Lido ao pé da letra, o texto elimina US19/US22 (o núcleo de "transparência e confiança") e torna o Farol idêntico ao Billing, o que quebra a própria divisão de 2 apps do marco.

**Ação:** reescrever para — *o module expõe (a) agregados (custo/contagem, com filtros) **e** (b) recursos de trace e sessão **no formato do contrato do próprio module, nunca a linha do fornecedor**; os apps leem só o module.* Fazer antes de MO5 fechar.

## 1b — Leitura de privacidade da mesma cláusula · **REGISTER**

Pergunta em aberto para Pedro/Martino: **"não trace cru" também significa "sem conteúdo de conversa"?** Nada na doc diz isso, mas é a leitura que um revisor de proteção de dados faria — e colide com a invariante 6 e a decisão 18 (guarda tudo, sem máscara, para sempre). Se a resposta for "sim", é decisão de produto que destrói o Farol e precisa do Pereira na sala.

## 3 — Formatação de exibição dentro do contrato · **FIX CODE**

**Doc** (Geral §4.1):

> **Fuso horário (timezone):** todo timestamp de contrato em **ISO 8601 UTC** (§9); a conversão para o fuso do usuário é responsabilidade de **apresentação** (front), nunca do dado armazenado. Preparar para operação **multi-fuso**.

ADR-61: *"Contratos M2M não têm i18n estrutural."*
Plataforma (§WD-3.1.2): *"O locale resolvido vira duas coisas: o `Accept-Language` do `GET /apps` **e** o `locale` do `init` da bridge"* — re-emitido quando muda em runtime.

**Código** (decisão 51):

> formatação de exibição (pt-BR, R$, durações, datas, idade relativa, rótulos…) vive nos view-models da presentation — campos `*_display`/`*_label` no contrato. **Datas exibidas no fuso fixo UTC-3** (America/Sao_Paulo, sem DST desde 2019)

A API não aceita `Accept-Language` nem parâmetro de locale/timezone.

**Análise:** a decisão 51 não briga com o *padrão* da plataforma — o App Register também resolve texto no servidor. Falta a **entrada**: locale entra, valores formatados saem.

**Ação:** aceitar `Accept-Language`/timezone e resolver os campos `*_display` por request, preservando "front só renderiza". Gatilho: primeiro cliente fora de pt-BR / UTC-3.

## 5 — O module não autentica quem chama · **FIX CODE**

**Doc** (module-register §M-C3, `ModuleManifest`):

> `auth: { requiredScopes: ScopeRef[]   // escopos M2M que o CHAMADOR precisa p/ chamar o module }`

US-M5: *"dado o `endpoint`/`requiredScopes` (`tracing:read`) descobertos, **quando chamo o Module de Tracing com o token exigido**, então recebo…"*
Racional de segurança: *"o module **ainda** exige o token de escopo próprio (defesa em profundidade)"*
ADR-77: escopos `tracing:read`.

**Código:** ~~nenhuma autenticação em `/api/v1`~~ **RESOLVIDO (parcial)** — a API
ganhou auth gateada por env: com `AUTH_SYSTEM_URL` setada, todo request a
`/api/v1` exige `Authorization: Bearer <token M2M>`, validado por
**introspection no Auth System** (RFC 7662, só `active` é lido — fail closed).
Sem a env, a API segue aberta (compat PoC). Implementação:
`main/server/middlewares/auth.ts` + `infrastructure/auth/http-token-authenticator.ts`.

> Nota: o desenho implementado segue a simplificação M2M da plataforma
> (spec `spec-simplificacao-m2m-discovery-versao.md` — claims
> `{tenant, client_id, client_secret}`, **sem scopes**) e SUPERSEDE a proposta
> original abaixo (JWKS local + checagem de escopo `tracing:read`): o module
> pergunta ao Auth System "autenticado ou não" a cada request e não carrega
> nenhuma lógica de scope/tenant.

**Ação restante:**
1. ~~Validação de JWT por JWKS + checagem de escopo `tracing:read`~~ — superada
   pela introspection sem scopes (acima).
2. Restringir o CORS — independente da plataforma, vale antes. **(ainda aberto)**
3. Quando a auth for ligada num cliente, a UI/nginx precisa passar a enviar o
   token (hoje chama a API sem header). **(aberto)**

## 6 — O module não é registrável · **FIX CODE**

**Doc** (§M-C3):

> ```
> ModuleManifest: { id, manifestVersion,
>   info: { name, description, protocol, apiVersion },
>   connection: { endpoint, health },
>   auth: { requiredScopes }, lifecycle: "active"|"deprecated"|"disabled",
>   audit: { registeredBy, registeredAt } }
> ```
> **Obrigatórios:** `id`, `manifestVersion`, `info.name`, `connection.endpoint`, `auth.requiredScopes`

SOP-M1 registra com id `tracing`: `PUT .../v0.1/modules/tracing -d @module-manifest.json`.
§M-A1: *"health é campo declarado no manifesto; healthcheck ativo é futuro."*

**Código:** não existe manifesto, `apiVersion`, `lifecycle` — nem um health path para declarar. O healthcheck do contêiner aponta para o Swagger:

```yaml
# openapi.json is built in memory at startup — proves the process is up.
test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/api/v1/docs/openapi.json"]
```

Prova que o processo subiu; não prova que o Mongo responde nem que o trace-ingestion-worker está vivo.

**Ação:** health endpoint real + `module-manifest.json` versionado no repo. O manifesto serve como resposta ao MO5.

## 7a — Página de connector desatualizada · **FIX DOC**

`connector-register-arquitetura.md` (linha 3) ainda descreve o modelo aposentado:

> a resposta é info de conexão + **credencial do connector** por link, TTL curto (CO5 — exemplo Langwatch: `ttlSeconds:60`, HAL `_links` `traces`/`events`, cada um com `href`/`method`/`headers`)

A spec vigente aposenta explicitamente (ADR-CR-1 e glossário):

> separá-los em **`Connector`** (estático) e **`ResolvedConnection`** (dinâmico…). O antigo termo "payload de conexão" **sai**.
> Não há mais `LangwatchTraceConnector`/**"payload de conexão"**.

Duas descrições contraditórias de connector coexistem na doc. **Sem impacto neste repositório** — nem o manifesto `Connector` nem a `ResolvedConnection` são artefatos deste componente (registro é do Time de Khal OS).

## 7b — Durabilidade do billing · **REGISTER**

**Doc** — a obrigação (§4.3, herdada em connector §B.2):

> **ack assíncrono, at-least-once**; buffer (SQS/Kinesis) + DLQ; perda ≈0 tolerável; **p95 ≤ 100 ms** até aceitar no buffer

**Doc** — e o reconhecimento de que a realidade não cumpre (connector §E.5, Q49 `[CONCERN]`):

> billing precisa ser ultra-preciso, mas a escrita é **OTLP best-effort** (dropa sob saturação) → **lacuna de durabilidade real**; **aceito por ora ("it is what it is")**. … ClickHouse = verdade de observabilidade; **Mongo = system-of-record de billing pretendido, mas herda a perda sem reconciliação**.

Q48 `[ABERTA]`: *"o LangWatch **não publica** contrato de rate-limit … saturação pode aparecer como **lag silencioso**, não `429`. **Precisa load test**."*

**Código:** a stack tem fila (redis + contêiner `langwatch-workers`), mas o buffer começa *depois* que o LangWatch aceita o OTLP. A invariante 3 prova `billing aggregate ≡ Σ carimbos` — mesmo banco, mesmos carimbos: **não detecta trace que nunca chegou**. Os dois mecanismos que pegariam isso seguem stub (decisão 33): *"detecção de buracos e alerta de retenção ficam como stub de log"*.

**Este é o risco aberto de maior valor: é o único achado em que estar errado custa dinheiro.** Uma fatura pode sair short pelo que o OTLP dropou, sem componente responsável por notar.

**Ação:** load test (passo nomeado pela doc) + promover detecção de buracos de stub para real.

## 9 — Contrato de atribuição agent → module sem dono · **REGISTER**

**Doc** afirma o fato mas nunca o especifica (ADR-76/Q80):

> credencial é **por connector/por tenant, não por agent** (o `agentId` vem carimbado no evento, não da credencial — Q80)

É a única menção. O `EventEnvelope` de referência não tem campo de agent: `{ eventId, occurredAt, signal, payload? }`, com `payload` marcado `[PENDENTE — Martino]`.

**Código** já inventou e embarcou a convenção — e sabe que não foi ratificada (QA14): *"agent/channel/domain/subdomain via **convenção de metadata (a formalizar com os times)**"*. A decisão 42 fixou, com fallback OTel semconv, e o mapper implementa:

```ts
attributeString(metadata, 'agent') ?? attributeString(metadata, 'service.name');
… 'service.version' … 'service.instance.id'
channel: attributeString(metadata, 'channel') ?? 'unknown'
```

**Por que importa:** é o único contrato que atravessa a cadeia inteira (agent → connector → module) e é a entrada do agrupamento de billing. Se um time de agent subir sem `metadata.agent`, o trace ingere, é precificado, e cai sob `service.name` ou como não classificado — o custo é real, a atribuição é chute. A quebra por **versão** do agente no extrato (decisão 48) depende de `service.version` vir por convenção.

**Ação:** ratificar as chaves de metadata com os times de agent e levá-las para a doc (no `EventEnvelope` ou no manifesto do agent). QA14 marcou como pendente e nada fechou.

## 10 — `X-Request-Id` · **FIX CODE**

**Doc** (Geral §4.3, `[PROPOSTA]`, q16) — nomeia o module explicitamente na cadeia:

> Observabilidade cross-componente | **`X-Request-Id` propagado ponta a ponta** (agent→connector→module→app) + **tracing distribuído** (X-Ray/OTel) + métricas RED por rota

**Código:** nenhum header de correlação, em request ou response. Barato de adicionar; é o único gancho de observabilidade cross-componente exigido.

## 11 — Dados em repouso · **REGISTER**

**Doc** (§4.5, `[PROPOSTA]`, q21/q22/q26):

> **Criptografia em repouso (q21):** **KMS** em tudo … **Gestão de segredos (q22):** `client_secret` … **nunca em claro**; segredos de infra em **AWS Secrets Manager** … **Residência (q26):** dados no **Brasil**, região **sa-east-1**

**Código:** segredos em claro em `clients/*.env`, volume Mongo sem criptografia, sem garantia de residência — guardando o dado mais sensível da plataforma (conversas integrais, sem máscara, permanentes).

---

## Descartados durante a revisão

| Item | Motivo |
|---|---|
| Retenção / mascaramento (1 mês × permanente) | Bancos diferentes, entidades diferentes: store de eventos do connector × store do module |
| snake_case, erros RFC 9457, paginação por cursor, envelope `{bills:[]}`, `/api/v1` × `info.version 0.1.0` | §9 obriga o Module **Register**, não a API interna do module |
| Camada de connector (manifesto / conexão resolvida) | Nenhum dos dois artefatos pertence a este repositório; registro é do Time de Khal OS |
| Split da UI, bridge, manifestos de app, slug `farol` × `tracing` | UI é mock de visualização, não o app do marco |

## Ordem sugerida

1. **1** e **7a** (FIX DOC) — mais baratos, e o 1 destrava o desenho do contrato MO5.
2. **1b** — pergunta ao Pedro/Martino; a resposta muda o produto.
3. **7b** — maior risco financeiro em aberto.
4. **6** e **10** — pequenos, sem dependência externa.
5. **5** — depende do Auth System existir; o CORS não depende.
6. **9** e **11** — registrar e agendar.
7. **3** — quando aparecer o primeiro cliente fora de pt-BR/UTC-3.
