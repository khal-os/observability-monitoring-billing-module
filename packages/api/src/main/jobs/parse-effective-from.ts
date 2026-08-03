import { registerPriceVersionRequestSchema } from '../../presentation/controllers/prices/price-view-schemas.js';

/**
 * The `--effective-from` border of the runbook price door.
 *
 * C-2 says the two doors cannot diverge, so this does NOT restate the HTTP
 * rule — it reuses the very schema POST /prices validates with (date-only
 * = UTC midnight, or an OFFSET-CARRYING ISO-8601 datetime; a timezone-less
 * local datetime is refused, B-8). Re-spelling the rule here is exactly how
 * the divergence happened: the job used a bare `new Date()`, so the pt-BR
 * spelling `01/07/2026` parsed as US m/d/y and registered a price effective
 * 7 January — and the immediate reprocess (decision 57) then stamped six
 * months of pending traces with a price nobody contracted for them. Stamps
 * are immutable (invariant 1): the only remedy is a month reopen plus
 * manual surgery.
 */
const effectiveFromSchema =
  registerPriceVersionRequestSchema.shape.effective_from;

/** Printed next to the rejected value — the accepted spelling, up front. */
export const EFFECTIVE_FROM_FORMAT_HINT =
  'Expected YYYY-MM-DD (UTC midnight) or an offset-carrying ISO-8601 datetime, e.g. "2026-07-01" or "2026-07-01T00:00:00Z".';

/** The parsed instant, or null when the spelling is not the HTTP door's. */
export const parseEffectiveFrom = (raw: string): Date | null => {
  const parsed = effectiveFromSchema.safeParse(raw);

  return parsed.success ? parsed.data : null;
};
