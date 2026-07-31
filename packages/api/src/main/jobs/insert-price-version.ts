import { parseArgs } from 'node:util';
import { makeDatabase } from '../factories/database-factory.js';
import { makeRegisterPriceVersionUseCase } from '../factories/price-factory.js';
import {
  TOKEN_TYPES,
  TokenType,
} from '../../domain/models/price-version-model.js';
import { brlToMicrocents } from '../../common/helpers/money/money.js';
import { DuplicatePriceVersionError } from '../../domain/errors/duplicate-price-version-error.js';

/**
 * T4 runbook (v1 has no admin UI): registers a NEW price version — always
 * an insert, never an update. Used by the demo to change a price and to
 * register a missing price before reprocessing pending traces.
 *
 * Usage:
 *   npm run price:insert -- --model <model> --token-type <input|output|cache_read|cache_write> \
 *     --price-brl <e.g. 3.10> --effective-from <ISO date>
 */
const { values } = parseArgs({
  options: {
    'model': { type: 'string' },
    'token-type': { type: 'string' },
    'price-brl': { type: 'string' },
    'effective-from': { type: 'string' },
  },
});

const model = values['model'];
const tokenType = values['token-type'] as TokenType | undefined;
const priceBrl = values['price-brl'];
const effectiveFromRaw = values['effective-from'];

if (!model || !tokenType || !priceBrl || !effectiveFromRaw) {
  console.error(
    'Usage: npm run price:insert -- --model <model> --token-type <type> --price-brl <amount> --effective-from <ISO date>',
  );
  process.exit(1);
}

if (!TOKEN_TYPES.includes(tokenType)) {
  console.error(
    `Invalid --token-type "${tokenType}". Expected one of: ${TOKEN_TYPES.join(', ')}.`,
  );
  process.exit(1);
}

const effectiveFrom = new Date(effectiveFromRaw);

if (Number.isNaN(effectiveFrom.getTime())) {
  console.error(`Invalid --effective-from date: "${effectiveFromRaw}".`);
  process.exit(1);
}

const database = makeDatabase();

await database.connect();

try {
  // Same single path as POST /prices (canonical model key + immediate
  // reprocess, decisions 82/57) — the two doors cannot diverge.
  const registered = await makeRegisterPriceVersionUseCase().register({
    model,
    tokenType,
    priceMicrocentsPerMillion: brlToMicrocents(priceBrl),
    effectiveFrom,
  });

  console.log(
    `Price version registered: ${registered.model} ${tokenType} R$ ${priceBrl}/million effective from ${effectiveFrom.toISOString()}.`,
  );
} catch (error) {
  if (error instanceof DuplicatePriceVersionError) {
    console.error(error.message);
    // exitCode (not process.exit) so the finally block still disconnects.
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await database.disconnect();
}
