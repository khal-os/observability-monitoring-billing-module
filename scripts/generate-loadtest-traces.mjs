/**
 * Load-test data generator: fills a THROWAWAY database with synthetic
 * traces shaped EXACTLY like real ingested documents (full-schema null
 * convention, consistent price stamps — Σ stampedCosts ≡ totalCostMicrocents,
 * invariant 3 — sessions sharing session_id, months spread for billing).
 *
 * Usage:
 *   node scripts/generate-loadtest-traces.mjs [count] [mongoUri] [dbName]
 * Defaults: 1_000_000 traces into mongodb://127.0.0.1:27019, db "loadtest".
 *
 * Dump it afterwards (container has the tools):
 *   docker exec cliente-mongo mongodump --db loadtest --archive --gzip > file.gz
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../packages/module/package.json'),
);
const { MongoClient } = require('mongodb');

const TOTAL = Number(process.argv[2] ?? 1_000_000);
// 27019 = the loadtest stack's own mongo (clients/loadtest.env MONGO_HOST_PORT) — 27018 belongs to another client.
const URI = process.argv[3] ?? 'mongodb://127.0.0.1:27019';
const DB = process.argv[4] ?? 'loadtest';
const BATCH = 2_000;

/* ---- 10 values per filterable dimension ---- */
const AGENTS = [
  'agent-atendimento', 'agent-cobranca', 'agent-suporte', 'agent-vendas',
  'agent-onboarding', 'agent-retencao', 'agent-fiscal', 'agent-logistica',
  'agent-rh', 'agent-juridico',
];
const DOMAINS = [
  'varejo', 'financeiro', 'suporte', 'comercial', 'logistica',
  'saude', 'educacao', 'industria', 'servicos', 'agro',
];
const SUBDOMAINS = [
  'loja-sp', 'loja-rj', 'cobranca', 'vendas', 'pos-venda',
  'onboarding', 'faturamento', 'estoque', 'atendimento-n1', 'atendimento-n2',
];
const TYPES = [
  'chat', 'agent', 'workflow', 'task', 'tool-run',
  'batch', 'evaluation', 'ingestion', 'report', 'webhook',
];
const CHANNELS = [
  'whatsapp', 'web', 'api', 'telegram', 'slack',
  'email', 'sms', 'teams', 'instagram', 'voice-sim',
];
const MODELS = [
  'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4-5', 'anthropic/claude-opus-5',
  'openai/gpt-5-mini', 'openai/gpt-5', 'google/gemini-2.5-pro',
  'google/gemini-2.5-flash', 'meta/llama-4-70b', 'mistral/mistral-large-3',
  'deepseek/deepseek-v4',
];
const ENVIRONMENTS = ['prod', 'staging', 'dev'];
const AGENT_VERSIONS = ['1.0.0', '1.1.0', '1.2.0', '2.0.0'];
const CHANNEL_VERSIONS = ['3.2.0', '3.3.1', '4.0.0'];
const SPAN_TYPES = ['llm', 'tool', 'retrieval', 'guardrail', 'memory'];

/* Prices in MICROCENTS per million tokens (1 BRL = 1e8 microcents).
   One immutable version per model, effective before the data window. */
const EFFECTIVE_FROM = new Date('2026-01-01T00:00:00.000Z');
const PRICE_TABLE = Object.fromEntries(
  MODELS.map((model, i) => {
    const inputBrlPerMillion = 3 + i * 4.5; // 3.00 .. 43.50 BRL/M
    const input = Math.round(inputBrlPerMillion * 1e8);
    return [model, {
      input,
      output: input * 4,
      cache_read: Math.round(input / 10),
      cache_write: Math.round(input * 1.25),
    }];
  }),
);

/* Pending-price model: the 11th model, absent from the price table — its
   traces land as pending_price, tokens kept, cost open (invariant 2). */
const UNPRICED_MODEL = 'acme/unpriced-experimental-1';

/* Stored shape (decision 82): the trace carries the model as a structured
   { id, provider } ref — the `provider/id` string is only the price-table
   key. All keys here have the slash form, so the parse is a single split. */
const modelRef = (key) => {
  const slash = key.indexOf('/');
  return { id: key.slice(slash + 1), provider: key.slice(0, slash) };
};

// Billing months cut at the CLIENT's midnight (decision 130), not UTC's:
// a trace at 2026-01-01T00:30Z is 2025-12-31 21:30 in São Paulo and lands
// in a December/2025 bill — which then blocks every close (oldest-first).
// Start the window at the client-tz midnight of Jan 1 (UTC-3 → 03:00Z).
const WINDOW_START = Date.UTC(2026, 0, 1, 3);
const WINDOW_END = Date.now(); // ...up to the moment of generation (all of 2026 so far)

const rnd = (max) => Math.floor(Math.random() * max);
const pick = (arr) => arr[rnd(arr.length)];
const chance = (p) => Math.random() < p;
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[rnd(16)]).join('');

const WORDS = ('cliente pedido fatura cobranca boleto estoque entrega prazo troca cupom '
  + 'garantia suporte plano upgrade cancelamento reembolso nota fiscal endereco '
  + 'pagamento cartao pix limite juros parcela desconto catalogo produto agenda').split(' ');
const sentence = (min, max) => {
  const n = min + rnd(max - min + 1);
  return Array.from({ length: n }, () => pick(WORDS)).join(' ');
};

const tokenCounts = (status) => {
  // Small share of error traces died before any token was consumed.
  if (status === 'error' && chance(0.3)) {
    return { input: null, output: null, cache_read: null, cache_write: null };
  }
  return {
    input: 50 + rnd(59_950), // trace "size" spans tiny one-liners to huge contexts
    output: 20 + rnd(11_980),
    cache_read: chance(0.35) ? 500 + rnd(80_000) : null,
    cache_write: chance(0.2) ? 200 + rnd(20_000) : null,
  };
};

const stampCosts = (model, tokens) => {
  const prices = PRICE_TABLE[model];
  const lines = [];
  for (const [tokenType, count] of Object.entries(tokens)) {
    if (count == null || count === 0) continue;
    const price = prices[tokenType];
    lines.push({
      tokenType,
      tokens: count,
      appliedPriceMicrocentsPerMillion: price,
      appliedPriceEffectiveFrom: EFFECTIVE_FROM,
      costMicrocents: Math.round((count * price) / 1e6),
    });
  }
  return lines;
};

const buildSpans = (trace, model, tokens) => {
  const count = 1 + rnd(14); // waterfalls de 1 a 15 spans
  const spans = [];
  for (let i = 0; i < count; i += 1) {
    const isRoot = i === 0;
    const offsetMs = isRoot ? 0 : rnd(Math.max(1, trace.durationMs - 50));
    const durationMs = isRoot
      ? trace.durationMs
      : 20 + rnd(Math.max(20, trace.durationMs - offsetMs));
    const startedAt = new Date(trace.startedAt.getTime() + offsetMs);
    const type = isRoot ? 'agent' : pick(SPAN_TYPES);
    const failed = trace.status === 'error' && i === count - 1;
    spans.push({
      spanId: hex(16),
      type,
      name: isRoot ? `${trace.agentId}.run` : `${type}.step_${i}`,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + durationMs),
      durationMs,
      offsetMs,
      status: failed ? 'error' : 'ok',
      errorMessage: failed ? `Timeout após ${durationMs} ms chamando ${type}` : null,
      tokens: type === 'llm'
        ? { input: tokens.input, output: tokens.output, cache_read: tokens.cache_read, cache_write: tokens.cache_write }
        : null,
      input: chance(0.7) ? sentence(4, 18) : null,
      output: chance(0.7) ? sentence(4, 24) : null,
    });
  }
  return spans;
};

let seq = 0;

const buildTrace = (session, startedMs) => {
  seq += 1;
  const status = chance(0.05) ? 'error' : 'ok';
  const durationMs = 200 + rnd(120_000);
  const startedAt = new Date(startedMs);
  const finishedAt = new Date(startedMs + durationMs);
  const ingestedAt = new Date(finishedAt.getTime() + 5_000 + rnd(60_000));

  const unclassified = chance(0.01);
  const pending = !unclassified && chance(0.07);
  const model = unclassified ? null : pending ? UNPRICED_MODEL : session.model;
  const tokens = tokenCounts(status);
  // Decision 128: a MODEL with zero measured tokens is no_measured_usage —
  // cost unknown, never R$ 0,00, never pending (no price resolves it), and
  // it does not block month close. The real ingestion stamper classifies
  // this at write time; a direct-insert generator must speak the same
  // dialect or it plants unresolvable pending_price / lying R$ 0,00 docs.
  const noMeasuredUsage =
    model !== null && Object.values(tokens).every((n) => n === null);
  const tokensTotal = Object.values(tokens).reduce((sum, n) => sum + (n ?? 0), 0);
  const stampedCosts =
    pending || unclassified || noMeasuredUsage ? null : stampCosts(model, tokens);
  const totalCostMicrocents = stampedCosts
    ? stampedCosts.reduce((sum, line) => sum + line.costMicrocents, 0)
    : null;

  const trace = {
    traceId: `lt-${seq.toString(36)}-${hex(12)}`,
    sessionId: session.sessionId,
    userId: chance(0.9) ? session.userId : null,
    agent: unclassified ? null : {
      id: session.agentId,
      version: session.agentVersion,
      instance: `${session.agentId}-${session.instanceSuffix}`,
    },
    model: model ? modelRef(model) : null,
    type: session.type,
    channel: {
      type: session.channelType,
      version: session.channelVersion,
      instance: chance(0.8) ? `omni-${session.channelType}-${session.instanceSuffix}` : null,
    },
    domain: session.domain,
    subdomain: session.subdomain,
    environment: session.environment,
    experiment: session.experiment,
    startedAt,
    finishedAt,
    durationMs,
    status,
    tokens,
    tokensTotal,
    pricingStatus: noMeasuredUsage
      ? 'no_measured_usage'
      : pending && !unclassified
        ? 'pending_price'
        : 'stamped',
    stampedCosts: pending || noMeasuredUsage ? null : (stampedCosts ?? []),
    totalCostMicrocents: pending || noMeasuredUsage ? null : (totalCostMicrocents ?? 0),
    stampedAt: pending || noMeasuredUsage ? null : ingestedAt,
    pendingPrice: null, // never persisted — derived at read time
    unclassified: unclassified ? { reasons: ['missing agent metadata'] } : null,
    ingestedAt,
    input: sentence(6, 40),
    output: status === 'error' && chance(0.5)
      ? `Erro: ${sentence(4, 12)}`
      : sentence(10, 60),
    spans: [],
    agentId: session.agentId, // temp for span naming, deleted below
  };
  trace.spans = buildSpans(trace, model, tokens);
  delete trace.agentId;
  return trace;
};

const buildSession = () => {
  const agentIdx = rnd(AGENTS.length);
  const domainIdx = rnd(DOMAINS.length);
  return {
    sessionId: chance(0.8) ? `sess-lt-${hex(12)}` : null,
    userId: `user-${rnd(500).toString().padStart(4, '0')}`,
    agentId: AGENTS[agentIdx],
    agentVersion: pick(AGENT_VERSIONS),
    instanceSuffix: `${hex(6)}-${hex(5)}`,
    model: MODELS[rnd(MODELS.length)],
    type: pick(TYPES),
    channelType: pick(CHANNELS),
    channelVersion: chance(0.9) ? pick(CHANNEL_VERSIONS) : null,
    domain: DOMAINS[domainIdx],
    subdomain: chance(0.85) ? SUBDOMAINS[rnd(SUBDOMAINS.length)] : null,
    environment: chance(0.95) ? ENVIRONMENTS[rnd(3)] : null,
    experiment: chance(0.15)
      ? { name: `exp-${pick(['pricing', 'tone', 'router'])}`, variant: pick(['A', 'B', 'C']), variantVersion: chance(0.5) ? '1' : null }
      : null,
  };
};

const main = async () => {
  const client = await MongoClient.connect(URI);
  const collection = client.db(DB).collection('traces');
  const started = Date.now();

  let produced = 0;
  let batch = [];

  while (produced < TOTAL) {
    const session = buildSession();
    const size = session.sessionId ? 1 + rnd(20) : 1; // conversas de 1 a 20 turnos
    let cursor = WINDOW_START + rnd(WINDOW_END - WINDOW_START);
    for (let i = 0; i < size && produced < TOTAL; i += 1) {
      batch.push(buildTrace(session, cursor));
      cursor += 30_000 + rnd(600_000); // next trace later in the conversation
      produced += 1;
    }
    if (batch.length >= BATCH) {
      await collection.insertMany(batch, { ordered: false });
      batch = [];
      if (produced % 100_000 < BATCH) {
        const rate = Math.round(produced / ((Date.now() - started) / 1000));
        console.log(`${produced.toLocaleString()} traces (${rate}/s)`);
      }
    }
  }
  if (batch.length) await collection.insertMany(batch, { ordered: false });

  const total = await collection.countDocuments();
  console.log(`done: ${total.toLocaleString()} docs in db "${DB}" (${Math.round((Date.now() - started) / 1000)}s)`);
  await client.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
