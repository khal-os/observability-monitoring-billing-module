import { readFileSync } from 'node:fs';
import fg from 'fast-glob';
import {
  TraceSourceClient,
  SourceTrace,
  SyncWindow,
} from '../../application/interfaces/trace-source-client.js';
import { sourceTraceListSchema } from './source-trace-schema.js';

// Fixture-backed client for offline demos and tests — third in the
// sync-factory chain, behind the real source clients (direct ClickHouse
// read preferred, vendor HTTP API as fallback; QA14 RESOLVED, decision
// 40). Fixtures are JSON shaped like the real API's payloads. Nothing
// outside this file may depend on fixture details — consumers only see
// the TraceSourceClient interface.

const defaultFixtureFiles = (): string[] =>
  [
    ...new Set(
      fg.sync(
        [
          // From the connector's own cwd (container, jobs, this package's
          // tests) and from the workspace root.
          '**/src/infrastructure/traceSource/fixtures/*.json',
          // From a SIBLING package's cwd: @khal/module's route suites seed
          // through the real ingestion (dev-only dependency), and the
          // node_modules symlink route is ignored below — so the fixtures
          // are named by their workspace path.
          '../connector/src/infrastructure/traceSource/fixtures/*.json',
        ],
        {
          ignore: ['**/node_modules/**'],
          absolute: true,
        },
      ),
    ),
  ].sort();

export class FakeTraceSourceClient implements TraceSourceClient {
  private readonly fixtureFiles: string[];

  constructor(args: { fixtureFiles?: string[] } = {}) {
    this.fixtureFiles = args.fixtureFiles ?? defaultFixtureFiles();
  }

  /** Static, settled fixtures — the paged contract's single-page form (audit C-6.3). */
  async *fetchTracesPaged(window: SyncWindow): AsyncIterable<SourceTrace[]> {
    const traces = this.fixtureFiles.flatMap((file) =>
      sourceTraceListSchema.parse(JSON.parse(readFileSync(file, 'utf-8'))),
    );

    // Half-open window [from, to): windows compose without double-counting.
    // Fixture file order is preserved on purpose — the real API gives no
    // ordering guarantee, and same-session traces arrive shuffled.
    const inWindow = traces.filter(
      (trace) =>
        trace.startedAt >= window.from && trace.startedAt < window.to,
    );

    if (inWindow.length > 0) {
      yield inWindow;
    }
  }
}
