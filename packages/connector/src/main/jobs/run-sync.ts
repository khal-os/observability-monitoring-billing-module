import { parseArgs } from 'node:util';
import { makeSyncTracesUseCase } from '../factories/sync-factory.js';
import { makeDatabase } from '../factories/database-factory.js';
import {
  RUNBOOK_DATE_FORMAT_HINT,
  parseRunbookDate,
} from '@observability/core/common/helpers/parse-runbook-date.js';
import { assertIngestionIndexes } from '@observability/core/infrastructure/database/mongodb/helpers/assert-ingestion-indexes.js';

/**
 * T2-lite sync job. Windows are half-open [from, to) and idempotent:
 * re-running any window never double-counts.
 *
 * Usage: npm run sync -- --from 2026-06-01 --to 2026-06-15
 */
const { values } = parseArgs({
  options: {
    'from': { type: 'string' },
    'to': { type: 'string' },
  },
});

if (!values['from'] || !values['to']) {
  console.error('Usage: npm run sync -- --from <ISO date> --to <ISO date>');
  process.exit(1);
}

// The SAME border the price door uses (B-8, decision 123): a bare
// `new Date()` here accepted `01/07/2026` as 7 January, so a window an
// operator read as "July" silently synced one day of a month the source
// may no longer retain — on the only manual backfill door into the
// permanent archive, and the one the dead-letter runbook sends you to
// before telling you to delete the row (invariant 6).
const from = parseRunbookDate(values['from']);
const to = parseRunbookDate(values['to']);

// Diagnosed separately, and the price door spells it the same way: folding
// the two into one message told an operator who typed `--from 01/07/2026
// --to 15/07/2026` that "--from must be strictly before --to" — dates that
// ARE ordered in the reading that produced them, so the message sends them
// to inspect the wrong thing on the very door decision 123 exists to keep
// from misleading them about dates.
if (!from) {
  console.error(
    `Invalid --from "${values['from']}". ${RUNBOOK_DATE_FORMAT_HINT}`,
  );
  process.exit(1);
}

if (!to) {
  console.error(`Invalid --to "${values['to']}". ${RUNBOOK_DATE_FORMAT_HINT}`);
  process.exit(1);
}

if (from >= to) {
  console.error('Sync: --from must be strictly before --to.');
  process.exit(1);
}

const database = makeDatabase();

await database.connect();

try {
  // Same guard as the worker (audit G-2): a backfill into a store whose
  // unique traceId index is missing double-stores every re-read trace,
  // and this door is exactly where an operator lands BEFORE remembering
  // `make migrate` — refuse loudly instead of double-counting quietly.
  await assertIngestionIndexes();
  await makeSyncTracesUseCase().sync({ from, to });
} finally {
  await database.disconnect();
}
