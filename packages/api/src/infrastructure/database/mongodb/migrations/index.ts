import { Migration } from '../helpers/migration-runner.js';
import { priceVersionIndexes } from './001-price-version-indexes.js';
import { traceIndexes } from './003-trace-indexes.js';
import { traceFilterIndexes } from './012-trace-filter-indexes.js';
import { sortAlignedTraceIndexes } from './013-sort-aligned-trace-indexes.js';
import { sessionSummaryIndexes } from './014-session-summary-indexes.js';
import { modelObject } from './015-model-object.js';
import { billingPeriodIndexes } from './017-billing-period-indexes.js';

/**
 * Ordered list — the runner applies each exactly once, in this order.
 *
 * Decision 74: the chain carries ONLY deterministic bootstrap (indexes).
 * Data seeds are explicit dev-only jobs (`make seed-prices`); structural
 * rewrites and null-backfills of earlier layouts were pruned — deployments
 * start fresh, there is no pre-convention data to migrate. Historical ids
 * (002, 004–011, 016) stay retired: never reuse them for new migrations
 * (016 was a domain→topic $rename, reverted before shipping — decision 86).
 * Exception: 015 rewrites pre-structured `model` strings into the
 * canonical `{ id, provider }` block — deployments that ingested before
 * that change DO carry old-layout data (see the migration's own doc).
 */
export const migrations: Migration[] = [
  priceVersionIndexes,
  traceIndexes,
  traceFilterIndexes,
  sortAlignedTraceIndexes,
  sessionSummaryIndexes,
  modelObject,
  billingPeriodIndexes,
];
