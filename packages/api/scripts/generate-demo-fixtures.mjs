/**
 * Generates realistic per-client demo traffic as source fixtures.
 *
 *   node packages/api/scripts/generate-demo-fixtures.mjs                    # the 3 PoC profiles
 *   node packages/api/scripts/generate-demo-fixtures.mjs --client tim        # generic profile for ANY client
 *
 * Writes demo-data/<client>/window-<month>.json, which compose bind-mounts
 * over the API image's fixture directory so `make sync CLIENT=<client>` ingests
 * that client's own traffic through the normal pipeline (price stamped at
 * write time — this script never writes to Mongo).
 *
 * Every trace is sized so its STAMPED cost lands in [R$ 1, R$ 100]. The
 * price table is the authority on cost, so the generator mirrors the as-of
 * lookup here (same integer µ¢ math as common/helpers/money) and scales
 * token counts to hit a target cost. Prices below MUST match what is
 * seeded/registered in each client database.
 *
 * Deterministic: seeded PRNG per client, so re-running produces identical
 * traces and re-syncing never double-counts.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../demo-data',
);

/* ---------- money (mirrors common/helpers/money, integer µ¢) ---------- */

const MICROCENTS_PER_BRL = 100_000_000;
const brl = (value) => Math.round(value * MICROCENTS_PER_BRL);
const costMicrocents = (tokens, priceMicrocentsPerMillion) =>
  (BigInt(tokens) * BigInt(priceMicrocentsPerMillion) + 500_000n) / 1_000_000n;

/* Price versions, as-of by effectiveFrom. Mirrors migration 002 plus the
   premium model registered by scripts/register-demo-prices.sh. */
const JUNE_1 = Date.UTC(2026, 5, 1);
const JUNE_15 = Date.UTC(2026, 5, 15);

const PRICES = {
  'openai/gpt-5-mini': {
    input: [[JUNE_1, brl(2.75)], [JUNE_15, brl(3.1)]],
    output: [[JUNE_1, brl(11)], [JUNE_15, brl(12.4)]],
    cache_read: [[JUNE_1, brl(0.275)]],
    cache_write: [[JUNE_1, brl(3.4375)]],
  },
  'anthropic/claude-sonnet-5': {
    input: [[JUNE_1, brl(16.5)]],
    output: [[JUNE_1, brl(82.5)]],
    cache_read: [[JUNE_1, brl(1.65)]],
    cache_write: [[JUNE_1, brl(20.625)]],
  },
  'anthropic/claude-opus-4-8': {
    input: [[JUNE_1, brl(82.5)]],
    output: [[JUNE_1, brl(412.5)]],
    cache_read: [[JUNE_1, brl(8.25)]],
    cache_write: [[JUNE_1, brl(103.125)]],
  },
};

const priceAsOf = (model, tokenType, at) => {
  const versions = PRICES[model][tokenType].filter(([from]) => from <= at);
  return versions[versions.length - 1][1];
};

/* ---------- deterministic PRNG ---------- */

const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const makeRandom = (seed) => {
  const next = mulberry32(seed);
  const rnd = {
    float: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted: (entries) => {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let roll = next() * total;
      for (const [value, weight] of entries) {
        roll -= weight;
        if (roll <= 0) return value;
      }
      return entries[entries.length - 1][0];
    },
    chance: (probability) => next() < probability,
    /* log-uniform: many cheap traces, a few expensive ones */
    logUniform: (min, max) =>
      Math.exp(Math.log(min) + next() * (Math.log(max) - Math.log(min))),
  };
  return rnd;
};

/* ---------- client profiles ---------- */

const CLIENTS = {
  hapvida: {
    seed: 20260721,
    traceCount: 150,
    /* health plan: high volume, cheaper models, whatsapp-first */
    models: [
      ['openai/gpt-5-mini', 5],
      ['anthropic/claude-sonnet-5', 4],
      ['anthropic/claude-opus-4-8', 1],
    ],
    channels: [['whatsapp', 7], ['web', 3]],
    errorRate: 0.06,
    agents: [
      { id: 'agente-triagem', domain: 'saude', subdomain: 'triagem' },
      { id: 'agente-agendamento', domain: 'saude', subdomain: 'agendamento' },
      { id: 'agente-autorizacao', domain: 'saude', subdomain: 'autorizacao' },
      { id: 'agente-segunda-via', domain: 'financeiro', subdomain: 'boletos' },
    ],
    dialogues: [
      ['Preciso marcar um cardiologista em Fortaleza para esta semana.',
       'Encontrei 3 cardiologistas com agenda esta semana na sua região. O Dr. Alencar tem horário quinta às 14h30, na Unidade Aldeota. Confirmo para você?'],
      ['Meu exame de ressonância foi autorizado?',
       'Sua autorização para ressonância magnética de joelho saiu aprovada ontem, guia 8841-2. Você pode realizar o exame em qualquer unidade credenciada até 20/08.'],
      ['Quero a segunda via do boleto de julho.',
       'Enviei a segunda via do boleto de julho (vencimento 25/07, R$ 487,90) para o seu e-mail cadastrado e também por aqui em PDF.'],
      ['Estou com dor de cabeça forte há três dias, o que faço?',
       'Dor de cabeça persistente por mais de 48 horas merece avaliação. Há um pronto atendimento a 3 km de você, com espera estimada de 25 minutos. Quer que eu registre a sua ida?'],
      ['Qual a carência para cirurgia eletiva no meu plano?',
       'No seu plano Mais Saúde, a carência para cirurgias eletivas é de 180 dias a partir da adesão. Como você aderiu em 12/01, a carência já está cumprida.'],
    ],
  },
  claro: {
    seed: 20260722,
    traceCount: 45,
    /* Recent window only: LangWatch's free self-hosted plan redacts span
       detail (incl. the model) past 14 days, and the sync needs the model
       to price the trace. */
    windowStart: Date.UTC(2026, 6, 9, 8, 0, 0),
    windowEnd: Date.UTC(2026, 6, 21, 18, 0, 0),
    /* telecom: balanced model mix, more errors, app + whatsapp */
    models: [
      ['openai/gpt-5-mini', 3],
      ['anthropic/claude-sonnet-5', 4],
      ['anthropic/claude-opus-4-8', 3],
    ],
    channels: [['whatsapp', 5], ['web', 3], ['app', 2]],
    errorRate: 0.11,
    agents: [
      { id: 'agente-suporte-tecnico', domain: 'telecom', subdomain: 'suporte' },
      { id: 'agente-cobranca', domain: 'financeiro', subdomain: 'cobranca' },
      { id: 'agente-vendas', domain: 'comercial', subdomain: 'upgrade' },
    ],
    dialogues: [
      ['Minha internet caiu desde ontem à noite e já reiniciei o modem.',
       'Identifiquei instabilidade na sua região (OLT Vila Mariana) com previsão de normalização às 18h. Abri o chamado 55-772134 e você receberá aviso assim que restabelecer.'],
      ['Por que minha fatura veio R$ 60 mais cara?',
       'A diferença vem de dois itens: R$ 39,90 do pacote de dados extra ativado em 03/07 e R$ 19,90 de um filme alugado. Posso remover o pacote extra a partir do próximo ciclo.'],
      ['Quero cancelar meu plano.',
       'Entendo. Antes de seguir com o cancelamento: seu plano atual custa R$ 149,90 e tenho uma condição de R$ 99,90 pelos próximos 12 meses mantendo a mesma velocidade. Prefere avaliar?'],
      ['O sinal da TV está travando nos canais HD.',
       'Travamento apenas em HD costuma indicar atenuação no cabo. Fiz um teste remoto no seu decodificador e o nível de sinal está em -12 dBm, abaixo do ideal. Agendei visita técnica para amanhã entre 8h e 12h.'],
      ['Consigo aumentar minha franquia de dados só este mês?',
       'Sim. Posso adicionar 20 GB válidos até o fim do ciclo atual por R$ 24,90, sem renovação automática. Confirma a ativação?'],
    ],
  },
  vivo: {
    seed: 20260723,
    traceCount: 42,
    windowStart: Date.UTC(2026, 6, 9, 8, 0, 0),
    windowEnd: Date.UTC(2026, 6, 21, 18, 0, 0),
    /* telecom premium: fewer, heavier traces on the expensive model */
    models: [
      ['anthropic/claude-opus-4-8', 6],
      ['anthropic/claude-sonnet-5', 3],
      ['openai/gpt-5-mini', 1],
    ],
    channels: [['web', 5], ['whatsapp', 4], ['app', 1]],
    errorRate: 0.08,
    agents: [
      { id: 'agente-atendimento', domain: 'telecom', subdomain: 'atendimento' },
      { id: 'agente-fatura', domain: 'financeiro', subdomain: 'fatura' },
      { id: 'agente-retencao', domain: 'comercial', subdomain: 'retencao' },
      { id: 'agente-portabilidade', domain: 'telecom', subdomain: 'portabilidade' },
    ],
    dialogues: [
      ['Quero portar meu número de outra operadora para cá.',
       'Perfeito. Para a portabilidade preciso do número, do CPF do titular e da operadora atual. O prazo é de até 3 dias úteis e a linha não fica fora do ar durante a migração.'],
      ['Fui cobrado por um serviço que não contratei.',
       'Localizei a cobrança de R$ 12,90 referente a um serviço de conteúdo ativado em 08/07. Cancelei o serviço e solicitei o estorno integral, que aparece na próxima fatura.'],
      ['Minha fatura digital não chegou este mês.',
       'Sua fatura de julho foi emitida em 05/07 no valor de R$ 219,80, mas retornou por caixa de e-mail cheia. Reenviei agora e também deixei o PDF disponível no app.'],
      ['Estou pensando em mudar de plano, o que vocês têm?',
       'Considerando seu consumo médio de 42 GB, o plano Ilimitado 60 GB por R$ 129,90 sairia mais barato que seu atual com pacotes extras. Inclui roaming nacional e 5G.'],
      ['O 5G não funciona no meu aparelho.',
       'Seu aparelho é compatível, mas o chip é da geração anterior e não suporta 5G SA. A troca do chip é gratuita em qualquer loja própria e leva cerca de 10 minutos.'],
    ],
  },
};

const SPAN_PLANS = [
  { type: 'guardrail', name: 'input-policy-check', tokenShare: 0.02 },
  { type: 'retrieval', name: 'busca-base-conhecimento', tokenShare: 0.12 },
  { type: 'tool', name: 'consulta-cadastro', tokenShare: 0 },
  { type: 'tool', name: 'consulta-faturamento', tokenShare: 0 },
  { type: 'tool', name: 'agenda-disponibilidade', tokenShare: 0 },
  { type: 'llm', name: 'resposta-final', tokenShare: 0.6 },
  { type: 'guardrail', name: 'output-policy-check', tokenShare: 0.02 },
];

const ERROR_MESSAGES = [
  'upstream timeout after 30000ms',
  'tool call failed: 503 from billing-api',
  'context window exceeded on retry',
  'guardrail blocked: PII detected in output',
];

/* Token mix per trace: input-heavy with cache reuse, as real agent runs are. */
const tokenMix = (rnd) => {
  const output = rnd.float(0.12, 0.24);
  const cacheRead = rnd.float(0.05, 0.22);
  const cacheWrite = rnd.float(0.01, 0.05);
  return {
    input: 1 - output - cacheRead - cacheWrite,
    output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
  };
};

/* Cost band per model, so token counts stay plausible while costs span
   the full R$ 1–100 range across the fleet. */
const COST_BAND = {
  'openai/gpt-5-mini': [1, 6],
  'anthropic/claude-sonnet-5': [2, 28],
  'anthropic/claude-opus-4-8': [6, 100],
};

const MIN_COST = brl(1);
const MAX_COST = brl(100);

/** Sizes token counts so the stamped cost lands on `targetMicrocents`. */
const sizeTokens = (model, startedAtMs, targetMicrocents, rnd) => {
  const mix = tokenMix(rnd);
  const types = ['input', 'output', 'cache_read', 'cache_write'];

  const microcentsPerToken = types.reduce(
    (sum, type) => sum + (mix[type] * priceAsOf(model, type, startedAtMs)) / 1e6,
    0,
  );

  const scale = (factor) => {
    const total = (targetMicrocents / microcentsPerToken) * factor;
    const tokens = {};
    for (const type of types) tokens[type] = Math.max(1, Math.round(mix[type] * total));
    const cost = types.reduce(
      (sum, type) => sum + costMicrocents(tokens[type], priceAsOf(model, type, startedAtMs)),
      0n,
    );
    return { tokens, cost: Number(cost) };
  };

  let sized = scale(1);
  /* Rounding is negligible at these magnitudes, but never ship a trace
     outside the band: correct by the observed ratio and re-check. */
  let factor = 1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (sized.cost >= MIN_COST && sized.cost <= MAX_COST) break;
    const wanted = sized.cost < MIN_COST ? MIN_COST * 1.02 : MAX_COST * 0.98;
    factor *= wanted / sized.cost;
    sized = scale(factor);
  }

  return sized;
};

const iso = (ms) => new Date(ms).toISOString();

const buildSpans = (rnd, trace, totalTokens, failing) => {
  const plans = [
    SPAN_PLANS[0],
    ...(rnd.chance(0.75) ? [SPAN_PLANS[1]] : []),
    ...(rnd.chance(0.65) ? [rnd.pick(SPAN_PLANS.slice(2, 5))] : []),
    ...(rnd.chance(0.3) ? [rnd.pick(SPAN_PLANS.slice(2, 5))] : []),
    SPAN_PLANS[5],
    ...(rnd.chance(0.5) ? [SPAN_PLANS[6]] : []),
  ];

  const totalMs = trace.finishedAtMs - trace.startedAtMs;
  const weights = plans.map(() => rnd.float(0.5, 1.5));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

  let cursor = trace.startedAtMs;
  return plans.map((plan, index) => {
    const share = weights[index] / weightSum;
    const duration = Math.max(40, Math.round(totalMs * share));
    const startedAt = cursor;
    const finishedAt = Math.min(trace.finishedAtMs, startedAt + duration);
    cursor = finishedAt;

    const isLast = index === plans.length - 1;
    const failed = failing && isLast;

    const span = {
      spanId: `${trace.traceId}-s${index + 1}`,
      type: plan.type,
      name: plan.name,
      startedAt: iso(startedAt),
      finishedAt: iso(finishedAt),
      status: failed ? 'error' : 'ok',
    };

    if (failed) span.errorMessage = rnd.pick(ERROR_MESSAGES);

    /* Span tokens are a partial view of the trace's usage (the trace-level
       counts remain the billing truth). */
    if (plan.tokenShare > 0) {
      span.tokens = {
        input: Math.round(totalTokens.input * plan.tokenShare),
        output: plan.type === 'llm' ? totalTokens.output : 0,
      };
    }

    if (plan.type === 'retrieval') {
      span.input = { query: trace.question.slice(0, 80) };
      span.output = { documentos: rnd.int(2, 8), fonte: 'base-conhecimento' };
    } else if (plan.type === 'tool') {
      span.input = { cliente: trace.customerRef };
      span.output = failed ? { erro: span.errorMessage } : { status: 'ok' };
    } else if (plan.type === 'llm') {
      span.input = { prompt: trace.question };
      span.output = failed ? { erro: span.errorMessage } : { texto: trace.answer };
    } else {
      span.input = { politica: 'v3' };
      span.output = { aprovado: !failed };
    }

    return span;
  });
};

const generateClient = (name, profile) => {
  const rnd = makeRandom(profile.seed);
  const traces = [];

  /* Default traffic window 01/06 → 21/07 (today): June is a complete bill
     and July the current partial one. Profiles can override (recent-only
     windows keep spans inside LangWatch's 14-day visibility). */
  const WINDOW_START = profile.windowStart ?? Date.UTC(2026, 5, 1, 8, 0, 0);
  const WINDOW_END = profile.windowEnd ?? Date.UTC(2026, 6, 21, 18, 0, 0);

  let sessionIndex = 0;
  while (traces.length < profile.traceCount) {
    sessionIndex += 1;
    const sessionId = `sess-${name}-${String(sessionIndex).padStart(4, '0')}`;
    const agent = rnd.pick(profile.agents);
    const channel = rnd.weighted(profile.channels);
    const customerRef = `cli-${rnd.int(10000, 99999)}`;

    /* A session is a conversation: 1–6 traces, minutes apart. */
    const turns = Math.min(
      rnd.weighted([[1, 5], [2, 4], [3, 3], [4, 2], [5, 1], [6, 1]]),
      profile.traceCount - traces.length,
    );

    let cursor = rnd.float(WINDOW_START, WINDOW_END - turns * 15 * 60_000);

    for (let turn = 0; turn < turns; turn += 1) {
      const model = rnd.weighted(profile.models);
      const [question, answer] = rnd.pick(profile.dialogues);
      const failing = rnd.chance(profile.errorRate);

      const startedAtMs = Math.round(cursor);
      /* Duration varies from a snappy answer to a long tool-heavy run. */
      const durationMs = Math.round(
        rnd.weighted([
          [rnd.float(900, 4000), 5],
          [rnd.float(4000, 20000), 4],
          [rnd.float(20000, 90000), 2],
          [rnd.float(90000, 240000), 1],
        ]),
      );
      const finishedAtMs = startedAtMs + durationMs;

      const [bandMin, bandMax] = COST_BAND[model];
      const target = brl(rnd.logUniform(bandMin, bandMax));
      const { tokens } = sizeTokens(model, startedAtMs, target, rnd);

      const traceId = `tr-${name}-${String(traces.length + 1).padStart(4, '0')}`;
      const trace = {
        traceId,
        sessionId,
        agent: {
          id: agent.id,
          version: rnd.pick(['1.2.0', '1.3.0', '2.0.1']),
          instance: `${agent.id}-${rnd.int(1, 3)}`,
        },
        model,
        type: 'conversation',
        channel: { type: channel, version: '1.0.0' },
        domain: agent.domain,
        subdomain: agent.subdomain,
        startedAt: iso(startedAtMs),
        finishedAt: iso(finishedAtMs),
        status: failing ? 'error' : 'ok',
        tokens,
        input: { mensagem: question, cliente: customerRef, canal: channel },
        output: failing
          ? { erro: 'falha ao gerar resposta', detalhe: rnd.pick(ERROR_MESSAGES) }
          : { mensagem: answer },
        spans: [],
      };

      trace.spans = buildSpans(
        rnd,
        { traceId, startedAtMs, finishedAtMs, question, answer, customerRef },
        tokens,
        failing,
      );

      traces.push(trace);
      cursor = finishedAtMs + rnd.float(30_000, 12 * 60_000);
    }
  }

  return traces;
};


/* ---------- generic profile for arbitrary clients (--client <name>) ---------- */

const GENERIC_DIALOGUES = [
  ['Preciso de ajuda com meu pedido, ele não chegou.',
   'Localizei seu pedido: saiu do centro de distribuição ontem e a entrega está prevista para amanhã até as 18h. Enviei o código de rastreio por aqui.'],
  ['Quero a segunda via da minha fatura.',
   'Enviei a segunda via da fatura deste mês (vencimento dia 25) para o seu e-mail cadastrado e também em PDF por aqui.'],
  ['Como faço para alterar meu plano?',
   'Você pode migrar para o plano superior sem custo de adesão. Considerando seu uso dos últimos 3 meses, a opção intermediária cobre com folga. Quer que eu simule os valores?'],
  ['Estou com um problema técnico no serviço desde ontem.',
   'Rodei um diagnóstico remoto e identifiquei instabilidade no seu ponto. Abri o chamado TEC-4471 com prioridade alta; a previsão de normalização é hoje às 18h.'],
  ['Fui cobrado duas vezes no cartão.',
   'Confirmei a duplicidade da cobrança de R$ 89,90 e já solicitei o estorno integral, que aparece em até 5 dias úteis. Protocolo ETN-2210.'],
  ['Quero cancelar minha assinatura.',
   'Entendo. Antes de concluir: posso oferecer 30% de desconto pelos próximos 6 meses mantendo todos os benefícios. Prefere avaliar a proposta?'],
];

const nameSeed = (name) => {
  let hash = 5381;
  for (const ch of name) hash = ((hash * 33) ^ ch.charCodeAt(0)) >>> 0;
  return hash;
};

/* Window relative to now (last ~12 days): inside LangWatch's span-visibility
   window on any deploy date. Anchored to the current UTC day so re-running
   on the same day is deterministic. */
const genericProfile = (name, traceCount) => {
  const today = new Date();
  const dayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return {
    seed: nameSeed(name),
    traceCount,
    windowStart: dayUtc - 12 * 24 * 60 * 60 * 1000,
    windowEnd: dayUtc + 17 * 60 * 60 * 1000,
    models: [
      ['openai/gpt-5-mini', 4],
      ['anthropic/claude-sonnet-5', 4],
      ['anthropic/claude-opus-4-8', 2],
    ],
    channels: [['whatsapp', 5], ['web', 4], ['app', 1]],
    errorRate: 0.08,
    agents: [
      { id: 'agente-atendimento', domain: 'atendimento', subdomain: 'geral' },
      { id: 'agente-financeiro', domain: 'financeiro', subdomain: 'faturas' },
      { id: 'agente-suporte', domain: 'suporte', subdomain: 'tecnico' },
    ],
    dialogues: GENERIC_DIALOGUES,
  };
};

const argv = process.argv.slice(2);
const clientFlag = argv.indexOf('--client');
const TARGETS =
  clientFlag !== -1
    ? { [argv[clientFlag + 1]]: genericProfile(
        argv[clientFlag + 1],
        parseInt(argv[argv.indexOf('--traces') + 1], 10) || 48,
      ) }
    : CLIENTS;

/* ---------- write ---------- */

let grandTotal = 0;
const summary = [];

for (const [name, profile] of Object.entries(TARGETS)) {
  /* The client name becomes a directory under demo-data/ that gets rm -rf'd
     below — validate the slug (same rule as deploy-lib.sh) BEFORE any
     filesystem write: `--client ..` must never resolve to the repo root. */
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) {
    throw new Error(`invalid client slug: ${name}`);
  }

  const traces = generateClient(name, profile);

  const byMonth = new Map();
  for (const trace of traces) {
    const month = trace.startedAt.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(trace);
  }

  const dir = path.join(OUT_ROOT, name);
  /* Belt and braces for the same traversal: only ever delete INSIDE demo-data. */
  if (!path.resolve(dir).startsWith(OUT_ROOT + path.sep)) {
    throw new Error(`refusing to delete outside demo-data/: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  for (const [month, monthTraces] of [...byMonth].sort()) {
    monthTraces.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    writeFileSync(
      path.join(dir, `window-${month}.json`),
      `${JSON.stringify(monthTraces, null, 2)}\n`,
    );
  }

  /* Report the cost distribution actually produced (the assertion that
     matters: every trace inside the requested band). */
  const costs = traces.map((trace) =>
    Object.entries(trace.tokens).reduce(
      (sum, [type, count]) =>
        sum + Number(costMicrocents(count, priceAsOf(trace.model, type, Date.parse(trace.startedAt)))),
      0,
    ),
  );

  const min = Math.min(...costs);
  const max = Math.max(...costs);
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  grandTotal += total;

  if (min < MIN_COST || max > MAX_COST) {
    throw new Error(
      `${name}: cost outside [R$1, R$100] — min ${min / MICROCENTS_PER_BRL}, max ${max / MICROCENTS_PER_BRL}`,
    );
  }

  summary.push({
    cliente: name,
    traces: traces.length,
    sessoes: new Set(traces.map((trace) => trace.sessionId)).size,
    meses: [...byMonth.keys()].sort().join(' + '),
    'menor R$': (min / MICROCENTS_PER_BRL).toFixed(2),
    'maior R$': (max / MICROCENTS_PER_BRL).toFixed(2),
    'total R$': (total / MICROCENTS_PER_BRL).toFixed(2),
  });
}

console.table(summary);
console.log(`Total geral: R$ ${(grandTotal / MICROCENTS_PER_BRL).toFixed(2)}`);
console.log(`Fixtures em ${OUT_ROOT}/<cliente>/`);
