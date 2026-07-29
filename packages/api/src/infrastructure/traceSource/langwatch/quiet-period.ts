import { SyncWindow } from '../../../application/interfaces/trace-source-client.js';

/** Decision 61's default: 15 min of source silence before ingestion. */
export const DEFAULT_QUIET_PERIOD_MS = 900_000;

/**
 * Windowed sync must respect the same quiet period the continuous loop
 * does (decision 61/79): a trace still being built has partial token
 * counts, and the price stamp is immutable — ingesting it mid-flight
 * freezes an undercharged stamp forever. The window's upper bound is
 * therefore clamped to `now − quietPeriod`; a window entirely inside the
 * quiet zone yields nothing (null) rather than partial traces.
 *
 * Applies to REAL sources only — fixture-backed fakes serve static,
 * settled data and take no clamp.
 */
export const clampWindowToQuietPeriod = (
  window: SyncWindow,
  quietPeriodMs: number,
  now: Date = new Date(),
): { window: SyncWindow; clamped: boolean } | null => {
  const safeTo = new Date(now.getTime() - quietPeriodMs);

  if (window.to.getTime() <= safeTo.getTime()) {
    return { window, clamped: false };
  }

  if (window.from.getTime() >= safeTo.getTime()) {
    return null;
  }

  return { window: { from: window.from, to: safeTo }, clamped: true };
};
