import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../collections.js';

/**
 * The unique `traceId` index IS ingestion idempotency (audit G-2 /
 * decision 117): `insertIfAbsent` inserts directly and treats E11000 as
 * "already stored" — without the index the same trace enters twice, each
 * copy with its own immutable price stamp and its own facet-cube
 * increment, and billing (Σ stamped costs) silently over-charges with no
 * evidence in the archive.
 *
 * Nothing migrates on its own, and compose ordering cannot guarantee
 * `make migrate` ran before the first writer — so every WRITER asserts
 * the index at startup and refuses to run without it. A crash loop that
 * says "run make migrate" beats a quietly double-counting archive.
 */
export interface IndexDescription {
  key: Record<string, unknown>;
  unique?: boolean;
}

/** Pure check, unit-testable: does any index uniquely cover { traceId: 1 }? */
export const hasUniqueTraceIdIndex = (indexes: IndexDescription[]): boolean =>
  indexes.some(
    (index) =>
      index.unique === true &&
      Object.keys(index.key).length === 1 &&
      index.key['traceId'] === 1,
  );

export const assertIngestionIndexes = async (): Promise<void> => {
  const indexes = (await MongoDb.getCollection(TRACES_COLLECTION).indexes()) as
    IndexDescription[];

  if (!hasUniqueTraceIdIndex(indexes)) {
    throw new Error(
      'The unique traceId index is missing from the traces collection — ' +
        'run `make migrate CLIENT=<name>` before starting any ingestion ' +
        '(first boot AND after every image upgrade, decision 117). ' +
        'Refusing to ingest: without the index, re-reads double-store ' +
        'traces and the bill double-counts them (audit G-2).',
    );
  }
};
