import { hasUniqueTraceIdIndex } from './assert-ingestion-indexes.js';

describe('hasUniqueTraceIdIndex (audit G-2 — the index IS idempotency)', () => {
  it('MUST accept the index migration 003 creates', () => {
    expect(
      hasUniqueTraceIdIndex([
        { key: { _id: 1 } },
        { key: { traceId: 1 }, unique: true },
      ]),
    ).toBe(true);
  });

  it('MUST refuse a non-unique traceId index — it deduplicates nothing', () => {
    expect(hasUniqueTraceIdIndex([{ key: { traceId: 1 } }])).toBe(false);
  });

  it('MUST refuse a compound index starting at traceId — a second key breaks the uniqueness contract', () => {
    expect(
      hasUniqueTraceIdIndex([
        { key: { traceId: 1, startedAt: 1 }, unique: true },
      ]),
    ).toBe(false);
  });

  it('MUST refuse an empty index list (fresh database, migrations never ran)', () => {
    expect(hasUniqueTraceIdIndex([])).toBe(false);
  });
});
