import {
  PoisonRowRepository,
  SalvageablePoisonKind,
} from '../../application/interfaces/poison-row-repository.js';
import {
  SourceTrace,
  TokenCounts,
} from '../../application/interfaces/trace-source-client.js';
import { Logger } from '@observability/core/common/logging/logger.js';
import { nullLogger } from '@observability/core/common/logging/null-logger.js';

/**
 * A token count the SOURCE declared and the boundary REJECTED (negative,
 * fractional, ...) — nulled there so the span-level usage sums get a
 * chance to rebuild it, and reported here so this gate can decide the
 * row's fate.
 */
export interface CorruptTokenCount {
  /** The source's own field name — forensics for the durable record. */
  field: string;
  /** The vendor-neutral token type the count feeds. */
  tokenType: keyof TokenCounts;
}

/** How each boundary names its rows in the sync log. */
const ROW_LABEL: Record<SalvageablePoisonKind, string> = {
  summary: 'summary row',
  'http-detail': 'trace detail',
};

/**
 * Which corrupt counts the span-level usage sums did NOT rebuild — the
 * mapped trace carries no real number for that token type, so its usage is
 * UNKNOWN, not zero.
 *
 * // QA19: this is the salvage half of the stamping rule. A non-empty
 * result means the row must stay POISON: with the corrupt type absent
 * from `tokens`, the stamper sees it as unused, finds no missing price
 * for it and mints an IMMUTABLE stamp that prices it at zero (R$ 0,00
 * outright when NO type survives) — exactly what invariant 2 forbids, and
 * unreachable by any later reprocess. Empty means every corrupt count came
 * back from the span-level usage sums and the trace is priced on measured
 * usage.
 */
export const unreconstructedTokenCounts = (
  trace: SourceTrace,
  corrupt: CorruptTokenCount[],
): CorruptTokenCount[] =>
  corrupt.filter((count) => (trace.tokens[count.tokenType] ?? 0) <= 0);

/**
 * THE invariant-2 gate on token counts, shared by EVERY source adapter
 * (re-audit iteration 2): the rule used to live inside one of the two
 * TraceSourceClient adapters, so the guarantee held only for whichever one
 * happened to be wired — the sibling ingested the same corrupt row and
 * stamped its unknown usage at R$ 0,00, immutably. Each adapter now
 * reports WHICH counts its boundary rejected and crosses this one gate.
 *
 * The trace may only proceed when the span-level usage sums rebuilt EVERY
 * corrupt count. Otherwise the usage behind those counts is unknown and
 * letting the trace through stamps it — immutably — as if that usage were
 * zero (R$ 0,00 outright when nothing survives, a silently zero-priced
 * type on partial corruption), which no reprocess can ever undo.
 *
 * Either way the outcome is recorded durably at decision time: a safe
 * salvage as `${kind}_salvaged` (a console.warn is not a trail — C-6.2), a
 * refused one as ordinary poison. The caller then skips the row like any
 * other poison row (decision 62).
 */
export const tokenSalvageIsSafe = async (args: {
  trace: SourceTrace;
  corrupt: CorruptTokenCount[];
  /** The boundary's poison kind; a salvage lands under `${kind}_salvaged`. */
  kind: SalvageablePoisonKind;
  /** Cursor/window position of the sync, for the durable record. */
  context: string;
  rawRow: unknown;
  poisonRowRepository?: PoisonRowRepository;
  logger?: Logger;
}): Promise<boolean> => {
  const { trace, corrupt, kind, context, rawRow } = args;
  const logger = args.logger ?? nullLogger;
  const label = ROW_LABEL[kind];
  const corruptFields = corrupt.map((count) => count.field).join(', ');
  const unreconstructed = unreconstructedTokenCounts(trace, corrupt);

  if (unreconstructed.length > 0) {
    const error =
      `invalid token counts (${corruptFields}) with no span-level usage to ` +
      `rebuild ${unreconstructed.map((count) => count.field).join(', ')} — ` +
      'the real usage is unknown, so the trace is NOT salvaged: ingesting ' +
      'it would stamp that usage at R$ 0,00 immutably (invariant 2).';

    logger.warn(`Sync: poison ${label} skipped: ${error}`, {
      traceId: trace.traceId,
    });
    await args.poisonRowRepository?.record({
      kind,
      id: trace.traceId,
      context,
      error,
      seenAt: new Date(),
      rawRow,
    });

    return false;
  }

  const note =
    `invalid token counts nulled (${corruptFields}) and rebuilt from the ` +
    'span-level usage sums; the trace proceeds with content preserved ' +
    '(audit C-6.2).';

  logger.warn(`Sync: ${label} salvaged: ${note}`, { traceId: trace.traceId });
  await args.poisonRowRepository?.record({
    kind: `${kind}_salvaged`,
    id: trace.traceId,
    context,
    error: note,
    seenAt: new Date(),
    rawRow,
  });

  return true;
};
