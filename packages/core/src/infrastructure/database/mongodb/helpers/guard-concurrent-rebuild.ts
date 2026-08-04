import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../collections.js';

/**
 * The rebuild jobs (session summaries, filter cube) end in `$out`, which
 * REPLACES the target collection: `$out` writes a temp collection and
 * `renameCollection … dropTarget: true`, so everything the always-on
 * ingestion worker wrote to the target BETWEEN the aggregation's first
 * read and the rename is dropped with the old collection (audit F-1). A
 * finished conversation whose summary lands in that window never appears
 * in `GET /sessions` again ("healed on next touch" never fires), and a
 * dropped cube `$inc` is wrong FOREVER (decision 77's own note).
 *
 * The jobs run against the LIVE stack, and nothing told the operator to
 * stop the worker first. This guard makes the job REFUSE to finish blind:
 * it samples two independent "did ingestion advance?" signals before and
 * after the rebuild, and if either moved it throws — the swap already
 * happened, but a non-zero exit with a clear message is the honest signal
 * that the rebuild must be re-run with the worker stopped.
 *
 * `sync_state` is the connector's collection; read raw and best-effort so
 * core takes no dependency on the connector (a stack with no worker yet
 * has no such doc — the trace count still guards it).
 */
const SYNC_STATE_COLLECTION = 'sync_state';
const TRACE_CURSOR_ID = 'trace-cursor';

interface IngestionMark {
  traceCount: number;
  watermarkAdvancedAt: number | null;
}

const sampleIngestion = async (): Promise<IngestionMark> => {
  const traceCount = await MongoDb.getCollection(
    TRACES_COLLECTION,
  ).estimatedDocumentCount();

  let watermarkAdvancedAt: number | null = null;

  try {
    const cursor = (await MongoDb.getCollection(SYNC_STATE_COLLECTION).findOne(
      { _id: TRACE_CURSOR_ID } as never,
    )) as { advancedAt?: Date } | null;

    watermarkAdvancedAt = cursor?.advancedAt?.getTime() ?? null;
  } catch {
    // No sync_state (pre-onboarding / worker never ran) — the trace count
    // is signal enough.
  }

  return { traceCount, watermarkAdvancedAt };
};

export const guardConcurrentRebuild = async (
  rebuild: () => Promise<void>,
): Promise<void> => {
  const before = await sampleIngestion();

  await rebuild();

  const after = await sampleIngestion();

  if (
    after.traceCount !== before.traceCount ||
    after.watermarkAdvancedAt !== before.watermarkAdvancedAt
  ) {
    throw new Error(
      'Ingestion advanced DURING the rebuild — the $out swap discarded the ' +
        'concurrent maintenance writes (audit F-1). Stop the ' +
        'trace-ingestion-worker (`docker compose stop trace-ingestion-worker`) ' +
        'and re-run this job.',
    );
  }
};
