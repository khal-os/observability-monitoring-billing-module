import { readFileSync } from 'node:fs';
import fg from 'fast-glob';
import {
  TraceSourceClient,
  SourceTrace,
  SyncWindow,
} from '../../application/interfaces/trace-source-client.js';
import { sourceTraceListSchema } from './source-trace-schema.js';

// QA14: fake client backed by JSON fixtures shaped like the expected real
// API. Nothing outside this file may depend on fixture details — consumers
// only see the TraceSourceClient interface. The real client (pagination,
// auth, size limits) is a future swap pending the QA14 spike.

const defaultFixtureFiles = (): string[] =>
  fg
    .sync('**/src/infrastructure/traceSource/fixtures/*.json', {
      ignore: ['**/node_modules/**'],
      absolute: true,
    })
    .sort();

export class FakeTraceSourceClient implements TraceSourceClient {
  private readonly fixtureFiles: string[];

  constructor(args: { fixtureFiles?: string[] } = {}) {
    this.fixtureFiles = args.fixtureFiles ?? defaultFixtureFiles();
  }

  async fetchTraces(window: SyncWindow): Promise<SourceTrace[]> {
    const traces = this.fixtureFiles.flatMap((file) =>
      sourceTraceListSchema.parse(JSON.parse(readFileSync(file, 'utf-8'))),
    );

    // Half-open window [from, to): windows compose without double-counting.
    // Fixture file order is preserved on purpose — the real API gives no
    // ordering guarantee, and same-session traces arrive shuffled.
    return traces.filter(
      (trace) =>
        trace.startedAt >= window.from && trace.startedAt < window.to,
    );
  }
}
