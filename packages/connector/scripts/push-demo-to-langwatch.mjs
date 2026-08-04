/**
 * Pushes the generated demo traffic (demo-data/<client>/window-*.json,
 * platform source-trace shape) into each client's own LangWatch instance
 * via the collector API — so the platform can then ingest it back through
 * the REAL sync path (HttpLangWatchClient), never writing to Mongo directly.
 *
 *   node packages/module/scripts/push-demo-to-langwatch.mjs            # all clients
 *   node packages/module/scripts/push-demo-to-langwatch.mjs vivo      # one client
 *
 * Reads LANGWATCH_PORT from clients/<name>.env; the API key arrives via
 * the LANGWATCH_API_KEY process env var (decisão 127: the key lives only
 * in LangWatch's own Postgres — scripts/4-seed-demo-data.sh fetches and
 * passes it; for a hand run, copy it from the LangWatch UI and export it).
 *
 * Round-trip mapping (mirrors langwatch-api-mapper expectations):
 * - metadata.thread_id            -> platform sessionId
 * - metadata.agent/.version/.instance, channel/.version, domain, subdomain
 * - root span (no parent) type 'agent': its type becomes the trace type,
 *   its input/output become the trace input/output, its error drives status
 * - single 'llm' child span carries the model (singleModelOf) and the FULL
 *   trace token counts as metrics (prompt/completion/cache_read/
 *   cache_creation) — token totals, and therefore stamped costs, are
 *   preserved exactly
 * - timestamps are epoch ms; original demo dates are kept as-is
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONCURRENCY = 4;

const clientsArg = process.argv.slice(2);
const CLIENT_NAMES = clientsArg.length > 0 ? clientsArg : ['hapvida', 'claro', 'vivo'];

const readEnv = (client) => {
  const content = readFileSync(path.join(ROOT, 'clients', `${client}.env`), 'utf-8');
  const get = (key) => content.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  // Port default mirrors compose.connector.yml (${LANGWATCH_PORT:-5560}).
  return { apiKey: process.env.LANGWATCH_API_KEY ?? '', port: get('LANGWATCH_PORT') || '5560' };
};

const spanTypeMap = { retrieval: 'rag' };

const toContent = (value) => {
  if (value === undefined || value === null) return { type: 'text', value: '' };
  if (typeof value === 'string') return { type: 'text', value };
  return { type: 'json', value };
};

const convertTrace = (trace) => {
  const rootId = `${trace.traceId}-s0`;
  const failing = trace.status === 'error';

  const rootError = failing
    ? {
        has_error: true,
        message: trace.output?.detalhe ?? 'falha ao gerar resposta',
        stacktrace: [],
      }
    : undefined;

  const rootSpan = {
    type: 'agent',
    span_id: rootId,
    input: { type: 'text', value: trace.input?.mensagem ?? '' },
    output: {
      type: 'text',
      value: failing
        ? (trace.output?.erro ?? 'falha ao gerar resposta')
        : (trace.output?.mensagem ?? ''),
    },
    ...(rootError ? { error: rootError } : {}),
    timestamps: {
      started_at: Date.parse(trace.startedAt),
      finished_at: Date.parse(trace.finishedAt),
    },
  };

  const children = trace.spans.map((span) => {
    const child = {
      type: spanTypeMap[span.type] ?? span.type,
      span_id: span.spanId,
      parent_id: rootId,
      name: span.name,
      input: toContent(span.input),
      output: toContent(span.output),
      timestamps: {
        started_at: Date.parse(span.startedAt),
        finished_at: Date.parse(span.finishedAt),
      },
    };

    if (span.status === 'error') {
      child.error = {
        has_error: true,
        message: span.errorMessage ?? 'erro',
        stacktrace: [],
      };
    }

    if (child.type === 'llm') {
      child.model = trace.model;
      // Full trace token counts live on the single llm span: the sync
      // mapper sums span metrics per type, so totals round-trip exactly.
      child.metrics = {
        prompt_tokens: trace.tokens.input ?? 0,
        completion_tokens: trace.tokens.output ?? 0,
        cache_read_input_tokens: trace.tokens.cache_read ?? 0,
        cache_creation_input_tokens: trace.tokens.cache_write ?? 0,
      };
    }

    return child;
  });

  return {
    trace_id: trace.traceId,
    metadata: {
      thread_id: trace.sessionId,
      user_id: trace.input?.cliente ?? undefined,
      agent: trace.agent.id,
      'agent.version': trace.agent.version,
      'agent.instance': trace.agent.instance,
      channel: trace.channel.type,
      'channel.version': trace.channel.version,
      domain: trace.domain,
      subdomain: trace.subdomain,
    },
    spans: [rootSpan, ...children],
  };
};

const pushClient = async (client) => {
  let apiKey;
  let port;
  let traces;
  try {
    ({ apiKey, port } = readEnv(client));
    const dir = path.join(ROOT, 'demo-data', client);
    traces = readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .flatMap((file) => JSON.parse(readFileSync(path.join(dir, file), 'utf-8')));
  } catch (err) {
    console.error(
      `${client}: clients/${client}.env ou demo-data/${client}/ inexistente (${err.code ?? err.message}) — pulei.`,
    );
    return { client, pushed: 0, failed: 0, skipped: true };
  }

  if (!apiKey) {
    console.error(`${client}: LANGWATCH_API_KEY ausente no ambiente — rode via scripts/4-seed-demo-data.sh (ou exporte a key copiada da UI do LangWatch). Pulei.`);
    return { client, pushed: 0, failed: 0, skipped: true };
  }

  const endpoint = `http://localhost:${port}/api/collector`;

  let pushed = 0;
  const failures = [];

  const send = async (trace) => {
    const payload = convertTrace(trace);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'X-Auth-Token': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          pushed += 1;
          return;
        }
        const body = await res.text();
        if (attempt === 3) failures.push(`${trace.traceId}: HTTP ${res.status} ${body.slice(0, 120)}`);
      } catch (err) {
        if (attempt === 3) failures.push(`${trace.traceId}: ${err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  };

  for (let i = 0; i < traces.length; i += CONCURRENCY) {
    await Promise.all(traces.slice(i, i + CONCURRENCY).map(send));
    if ((i / CONCURRENCY) % 10 === 0) {
      process.stdout.write(`\r${client}: ${pushed}/${traces.length}`);
    }
  }

  console.log(`\r${client}: ${pushed}/${traces.length} enviados, ${failures.length} falhas`);
  for (const failure of failures.slice(0, 5)) console.error(`  ${failure}`);
  return { client, pushed, failed: failures.length, total: traces.length };
};

const results = [];
for (const client of CLIENT_NAMES) {
  results.push(await pushClient(client));
}

const anyFailed = results.some((result) => result.skipped || result.failed > 0);
process.exit(anyFailed ? 1 : 0);
