import { isoDateRule } from './iso-date-rule.js';

/**
 * The ONE date border for every runbook door — `--effective-from` of the
 * price job, `--from`/`--to` of the sync job, and whatever comes next.
 *
 * It does NOT restate the rule: it reuses `isoDateRule` — the ONE
 * definition (date-only = UTC midnight, or an OFFSET-CARRYING ISO-8601
 * datetime; a timezone-less local datetime is refused, B-8) that POST
 * /prices validates `effective_from` with and `isoDateParam` gives the
 * HTTP list endpoints.
 *
 * Re-spelling the rule per door is exactly how it broke, twice. The price
 * job used a bare `new Date()`, so the pt-BR spelling `01/07/2026` parsed
 * as US m/d/y and registered a price effective 7 January — and the
 * immediate reprocess (decision 57) then stamped six months of pending
 * traces with a price nobody contracted for them; stamps are immutable
 * (invariant 1), so the remedy was a month reopen plus manual surgery.
 * The sync job kept the same constructor for four more audit iterations:
 * there the same spelling silently syncs one day in January instead of
 * July, and `make sync` is both the only manual backfill door into the
 * permanent archive and the dead-letter recovery door whose runbook then
 * says to delete the row — so a mis-spelled window can drop a trace from
 * the archive AND from its own recovery trail (invariant 6).
 *
 * Hence: one parser, no exceptions. A new job that takes a date uses this,
 * never `new Date()`.
 */
const runbookDateSchema = isoDateRule;

/** Printed next to the rejected value — the accepted spelling, up front. */
export const RUNBOOK_DATE_FORMAT_HINT =
  'Expected YYYY-MM-DD (UTC midnight) or an offset-carrying ISO-8601 datetime, e.g. "2026-07-01" or "2026-07-01T00:00:00Z".';

/** The parsed instant, or null when the spelling is not the HTTP door's. */
export const parseRunbookDate = (raw: string): Date | null => {
  const parsed = runbookDateSchema.safeParse(raw);

  return parsed.success ? parsed.data : null;
};
