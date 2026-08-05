/**
 * OTLP write-path load generator — drives the LangWatch ingestion API at a
 * fixed rate of TRACES PER SECOND, with payloads shaped like the real agent's
 * emission: OTLP/HTTP protobuf, one export request per trace, root agent span
 * + LLM/tool children carrying OpenInference attributes and token counts.
 *
 * Every trace gets fresh random trace/span ids — replaying a fixed body would
 * make LangWatch collapse everything into ONE trace and the test would
 * measure nothing.
 *
 * Zero dependencies (hand-rolled protobuf encoder; Node >= 20 global fetch).
 * Writes NOTHING anywhere: results go to stdout only.
 *
 * Usage (all config via env; the API key is COPIED BY YOU from the LangWatch
 * UI — no script reads or writes env files):
 *
 *   LANGWATCH_ENDPOINT=http://localhost:<LANGWATCH_PORT> \
 *   LANGWATCH_API_KEY=<paste from the LangWatch UI> \
 *   RATE=1000 DURATION=60 node loadtest/otlp-load-gen.mjs
 *
 * Env:
 *   LANGWATCH_ENDPOINT  required — LangWatch base URL (no path)
 *   LANGWATCH_API_KEY   required — project API key (Bearer)
 *   RATE                traces/second to sustain (default 1000)
 *   DURATION            seconds (default 60)
 *   SPANS_PER_TRACE     spans per trace incl. root (default 5)
 *   MODEL_NAME          llm.model_name stamped on LLM spans (default claude-sonnet-5)
 *   MAX_INFLIGHT        backpressure cap — beyond it, sends are DROPPED and
 *                       counted (default 512; a growing drop count means the
 *                       target cannot sustain RATE)
 *   EMIT_SAMPLE=<path>  write ONE sample payload to <path> and exit (for
 *                       offline inspection; no requests are made)
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

// ── minimal protobuf encoder (varint / fixed64 / length-delimited) ─────────
const varint = (n) => {
  const out = [];
  let v = typeof n === 'bigint' ? n : BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return Buffer.from(out);
};
const tag = (field, wire) => varint((field << 3) | wire);
const lenField = (field, payload) => Buffer.concat([tag(field, 2), varint(payload.length), payload]);
const strField = (field, s) => lenField(field, Buffer.from(String(s), 'utf8'));
const varField = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
const fix64Field = (field, big) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(big);
  return Buffer.concat([tag(field, 1), b]);
};

// AnyValue{string_value=1|int_value=3} · KeyValue{key=1,value=2}
const attrStr = (key, value) =>
  Buffer.concat([strField(1, key), lenField(2, strField(1, value))]);
const attrInt = (key, value) =>
  Buffer.concat([strField(1, key), lenField(2, varField(3, value))]);

// Span{trace_id=1,span_id=2,parent=4,name=5,kind=6,start=7,end=8,attrs=9,status=15}
const SPAN_KIND_INTERNAL = 1;
const STATUS_OK = 1;
const span = ({ traceId, spanId, parentId, name, startNs, endNs, attrs }) =>
  Buffer.concat([
    lenField(1, traceId),
    lenField(2, spanId),
    ...(parentId ? [lenField(4, parentId)] : []),
    strField(5, name),
    varField(6, SPAN_KIND_INTERNAL),
    fix64Field(7, startNs),
    fix64Field(8, endNs),
    ...attrs.map((a) => lenField(9, a)),
    lenField(15, varField(3, STATUS_OK)),
  ]);

// ── one export request = one trace, agent-shaped ────────────────────────────
const MODEL = process.env.MODEL_NAME ?? 'claude-sonnet-5';
const SPANS = Math.max(1, Number(process.env.SPANS_PER_TRACE ?? 5));
const rint = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));

const buildTrace = (seq) => {
  const traceId = randomBytes(16);
  const rootId = randomBytes(8);
  const endNs = BigInt(Date.now()) * 1_000_000n;
  const rootStart = endNs - BigInt(rint(1200, 3000)) * 1_000_000n;
  const sessionId = `loadtest-session-${seq % 500}`;

  const spans = [
    span({
      traceId,
      spanId: rootId,
      name: 'agent.run',
      startNs: rootStart,
      endNs,
      attrs: [
        attrStr('openinference.span.kind', 'AGENT'),
        attrStr('input.value', `loadtest input ${seq}`),
        attrStr('output.value', `loadtest output ${seq}`),
        attrStr('langwatch.user.id', `loadtest-user-${seq % 200}`),
        attrStr('langwatch.thread.id', sessionId),
        attrStr('channel', 'api'),
      ],
    }),
  ];
  for (let i = 1; i < SPANS; i += 1) {
    const childStart = rootStart + BigInt(rint(5, 60)) * 1_000_000n;
    const childEnd = childStart + BigInt(rint(80, 900)) * 1_000_000n;
    const isLlm = i % 2 === 1; // alternate llm/tool, llm first
    spans.push(
      span({
        traceId,
        spanId: randomBytes(8),
        parentId: rootId,
        name: isLlm ? 'llm.call' : 'tool.call',
        startNs: childStart,
        endNs: childEnd,
        attrs: isLlm
          ? [
              attrStr('openinference.span.kind', 'LLM'),
              attrStr('llm.model_name', MODEL),
              attrInt('llm.token_count.prompt', rint(200, 3000)),
              attrInt('llm.token_count.completion', rint(50, 800)),
            ]
          : [
              attrStr('openinference.span.kind', 'TOOL'),
              attrStr('input.value', 'lookup'),
              attrStr('output.value', 'ok'),
            ],
      }),
    );
  }

  // Resource{attrs=1} · ScopeSpans{scope=1,spans=2} · ResourceSpans{resource=1,scope_spans=2}
  const resource = Buffer.concat([
    lenField(1, attrStr('service.name', 'loadtest-agent')),
    lenField(1, attrStr('deployment.environment', 'loadtest')),
    lenField(1, attrStr('agent.version', '0.0.0-loadtest')),
  ]);
  const scopeSpans = Buffer.concat([
    lenField(1, strField(1, 'otlp-load-gen')),
    ...spans.map((s) => lenField(2, s)),
  ]);
  const resourceSpans = Buffer.concat([lenField(1, resource), lenField(2, scopeSpans)]);
  return lenField(1, resourceSpans); // ExportTraceServiceRequest{resource_spans=1}
};

// ── sample emission (offline inspection, no requests) ──────────────────────
if (process.env.EMIT_SAMPLE) {
  const sample = buildTrace(0);
  writeFileSync(process.env.EMIT_SAMPLE, sample);
  console.log(`sample payload (${sample.length} bytes, ${SPANS} spans) → ${process.env.EMIT_SAMPLE}`);
  process.exit(0);
}

// ── load loop: fixed rate with backpressure accounting ─────────────────────
const ENDPOINT = process.env.LANGWATCH_ENDPOINT;
const KEY = process.env.LANGWATCH_API_KEY;
if (!ENDPOINT || !KEY) {
  console.error(
    'Set LANGWATCH_ENDPOINT and LANGWATCH_API_KEY (copy the key from the LangWatch UI).',
  );
  process.exit(1);
}
const URL_ = `${ENDPOINT.replace(/\/$/, '')}/api/otel/v1/traces`;
const RATE = Number(process.env.RATE ?? 1000);
const DURATION = Number(process.env.DURATION ?? 60);
const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT ?? 512);
const TOTAL = RATE * DURATION;

let sent = 0;
let inflight = 0;
let dropped = 0;
let seq = 0;
const codes = new Map(); // http status (0 = network error) → count
const latencies = [];
const t0 = performance.now();

const record = (code, ms) => {
  codes.set(code, (codes.get(code) ?? 0) + 1);
  latencies.push(ms);
};

const fire = () => {
  const body = buildTrace(seq++);
  const started = performance.now();
  sent += 1;
  inflight += 1;
  fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf', authorization: `Bearer ${KEY}` },
    body,
  })
    .then((r) => {
      record(r.status, performance.now() - started);
      return r.arrayBuffer().catch(() => undefined);
    })
    .catch(() => record(0, performance.now() - started))
    .finally(() => {
      inflight -= 1;
    });
};

let quota = 0;
const TICK_MS = 20;
const ticker = setInterval(() => {
  quota += (RATE * TICK_MS) / 1000;
  while (quota >= 1 && sent + dropped < TOTAL) {
    if (inflight >= MAX_INFLIGHT) {
      // Cannot sustain RATE — drop instead of queueing (queueing would just
      // measure the generator's memory, not the target's throughput).
      dropped += 1;
    } else {
      fire();
    }
    quota -= 1;
  }
  if (sent + dropped >= TOTAL && inflight === 0) {
    clearInterval(ticker);
    clearInterval(progress);
    report();
  }
}, TICK_MS);

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const progress = setInterval(() => {
  const elapsed = (performance.now() - t0) / 1000;
  const ok = codes.get(200) ?? 0;
  console.log(
    `[${elapsed.toFixed(0).padStart(3)}s] sent=${sent} ok=${ok} dropped=${dropped} inflight=${inflight} rate=${(sent / elapsed).toFixed(0)}/s`,
  );
}, 5000);

const report = () => {
  const elapsed = (performance.now() - t0) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  const ok = codes.get(200) ?? 0;
  console.log('\n──── otlp-load-gen report ────');
  console.log(`target        ${RATE} traces/s × ${DURATION}s = ${TOTAL} traces (${SPANS} spans each)`);
  console.log(`achieved      ${(sent / elapsed).toFixed(1)} req/s over ${elapsed.toFixed(1)}s`);
  console.log(`accepted 2xx  ${ok} (${((100 * ok) / TOTAL).toFixed(2)}%)`);
  for (const [code, n] of [...codes.entries()].sort((a, b) => a[0] - b[0])) {
    if (code !== 200) console.log(`  status ${code === 0 ? 'ERR' : code}   ${n}`);
  }
  if (dropped > 0) {
    console.log(
      `dropped       ${dropped} — backpressure (MAX_INFLIGHT=${MAX_INFLIGHT} saturated): the target cannot sustain RATE`,
    );
  }
  if (sorted.length > 0) {
    console.log(
      `latency ms    p50=${pct(sorted, 50).toFixed(1)} p95=${pct(sorted, 95).toFixed(1)} p99=${pct(sorted, 99).toFixed(1)} max=${sorted[sorted.length - 1].toFixed(1)}`,
    );
  }
  console.log('\nFront door only — now check the drain: loadtest/watch-pipeline.sh');
  process.exit(ok + dropped === TOTAL && dropped === 0 ? 0 : 1);
};
