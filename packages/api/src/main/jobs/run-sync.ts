import { parseArgs } from 'node:util';
import { makeSyncTracesUseCase } from '../factories/sync-factory.js';
import { makeDatabase } from '../factories/database-factory.js';

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

const from = new Date(values['from']);
const to = new Date(values['to']);

if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
  console.error('Sync: --from must be a valid date strictly before --to.');
  process.exit(1);
}

const database = makeDatabase();

await database.connect();

try {
  await makeSyncTracesUseCase().sync({ from, to });
} finally {
  await database.disconnect();
}
