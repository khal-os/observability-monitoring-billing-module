/**
 * audit C-6.2 — durable trail for source rows that fail boundary
 * validation. The skip-and-log rule (decision 62) is right for an
 * isolated malformed row, but a console.warn in a rotating container log
 * is not a recovery trail: once the source's retention expires, a skipped
 * row with no durable record is irrecoverably gone. Every skip is now
 * persisted at skip time, upserted by row id, in the same durable store
 * as the archive itself.
 */
export interface PoisonRowRecord {
  /**
   * Which boundary rejected the row — or, for `summary_salvaged`, ACCEPTED
   * it under repair: a summary whose corrupt token counts were nulled and
   * rebuilt from span-level usage (audit iteration 1). A salvage is not a
   * skip, but it is a boundary defect that reached the permanent archive,
   * so it belongs in the same durable trail: `summary_salvaged` records
   * are the only ones whose trace WAS ingested.
   */
  kind: 'summary' | 'span' | 'http-detail' | 'summary_salvaged';
  /** The row's own id (traceId for summaries/details, spanId for spans). */
  id: string;
  /** Cursor/window position of the sync when the row was seen. */
  context: string;
  /** The validation/mapping error — or, for a salvage, what was repaired. */
  error: string;
  seenAt: Date;
  /**
   * The raw row, for forensics — archived only when small (the
   * implementation drops it above ~64KB serialized; the error + id are
   * the contract, the payload is best-effort).
   */
  rawRow?: unknown;
}

export interface PoisonRowRepository {
  /** Upsert by (kind, id): repeats refresh error/context and count re-encounters. */
  record(row: PoisonRowRecord): Promise<void>;
}
