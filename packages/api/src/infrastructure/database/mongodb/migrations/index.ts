import { Migration } from '../helpers/migration-runner.js';
import { priceVersionIndexes } from './001-price-version-indexes.js';
import { seedPriceVersions } from './002-seed-price-versions.js';
import { traceIndexes } from './003-trace-indexes.js';
import { agentChannelBlocks } from './004-agent-channel-blocks.js';
import { nullOptionals } from './005-null-optionals.js';
import { embedSpans } from './006-embed-spans.js';
import { mergeSpanContents } from './007-merge-span-contents.js';
import { mergeContentIntoTraces } from './008-merge-content-into-traces.js';
import { consolidateDerivedFields } from './009-consolidate-derived-fields.js';
import { nullPendingPrice } from './010-null-pending-price.js';

/** Ordered list — the runner applies each exactly once, in this order. */
export const migrations: Migration[] = [
  priceVersionIndexes,
  seedPriceVersions,
  traceIndexes,
  agentChannelBlocks,
  nullOptionals,
  embedSpans,
  mergeSpanContents,
  mergeContentIntoTraces,
  consolidateDerivedFields,
  nullPendingPrice,
];
