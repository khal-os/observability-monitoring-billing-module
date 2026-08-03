import { z } from 'zod';

/**
 * THE date border of the platform (decision 123 / B-8): date-only = UTC
 * midnight, or an OFFSET-CARRYING ISO-8601 datetime; a timezone-less local
 * datetime is refused — "2026-07-01T00:00:00" would read in the SERVER's
 * timezone and shift the immutable stamp boundary.
 *
 * One definition, three doors: the HTTP list endpoints (`isoDateParam`),
 * POST /prices' `effective_from`, and every runbook job that takes a date
 * (`parseRunbookDate`). Re-spelling the rule per door is exactly how it
 * broke, twice — see parse-runbook-date.ts for the postmortems.
 */
export const isoDateRule = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform((value) => new Date(value))
  .refine((date) => !Number.isNaN(date.getTime()));
