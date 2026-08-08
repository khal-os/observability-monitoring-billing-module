import { Migration } from '../helpers/migration-runner.js';
import { TRACES_COLLECTION } from '../collections.js';
import { PRICE_VERSIONS_COLLECTION } from '../priceVersion/mongodb-price-version-repository.js';

/**
 * Backfill for decision 102 (audit B-7): model ids are lowercased at the
 * canonicalization point (`parseModelRef`), so previously stored data must
 * meet the code's new key space. Two attribution-only rewrites:
 *
 * - `traces.model.id` (and `model.provider`, defensively — parse always
 *   lowercased it, but runbook attribution corrections took the value
 *   verbatim) → lowercase. INVARIANT 7: this touches attribution ONLY.
 *   The price stamp (stampedCosts, totalCostMicrocents, stampedAt) is
 *   immutable and is not read, re-derived, or rewritten here — the
 *   pipeline-form $set names the two model fields and nothing else.
 * - `price_versions.model` (the canonical composed `provider/id` string
 *   key) → lowercase, so registered prices match the keys ingestion now
 *   produces.
 *
 * Closed-month SNAPSHOT collections are deliberately untouched: a frozen
 * bill keeps its as-closed keys (invariant 8 — served exclusively from
 * the snapshot, never recomputed against live canonicalization).
 *
 * COLLISION RULE (documented, deterministic): two price-version rows
 * whose keys differ only by case are duplicate registrations of the same
 * real price — after lowercasing they would collide on the unique
 * (model, tokenType, effectiveFrom) index. The migration walks candidates
 * in _id order (== registration order) and lets the index adjudicate:
 * the row whose lowercase form already exists (or, among case-variants
 * only, the earliest-registered one, which is rewritten first) stays the
 * effective row; later variants are left AS STORED (mixed case — inert:
 * no lookup produces a mixed-case key anymore) and logged as a warning.
 * Nothing is deleted — price versions are immutable data
 * (invariant 9); resolving an inert duplicate is an operator decision.
 *
 * Idempotent: every filter matches documents still carrying uppercase
 * characters; a re-run finds only the deliberately skipped collision rows
 * and skips them again, modifying nothing.
 */
export const lowercaseModelIds: Migration = {
  id: '019-lowercase-model-ids',

  async run(db, logger) {
    const traces = db.collection(TRACES_COLLECTION);

    // Pipeline-form update: server-side, one pass per field, and by
    // construction unable to touch anything but the named model field.
    await traces.updateMany({ 'model.id': { $regex: /[A-Z]/ } }, [
      { $set: { 'model.id': { $toLower: '$model.id' } } },
    ]);
    await traces.updateMany({ 'model.provider': { $regex: /[A-Z]/ } }, [
      { $set: { 'model.provider': { $toLower: '$model.provider' } } },
    ]);

    const priceVersions = db.collection(PRICE_VERSIONS_COLLECTION);

    const candidates = priceVersions.find(
      { model: { $regex: /[A-Z]/ } },
      { sort: { _id: 1 } },
    );

    for await (const document of candidates) {
      const model = document['model'] as string;

      try {
        await priceVersions.updateOne(
          { _id: document['_id'] },
          { $set: { model: model.toLowerCase() } },
        );
      } catch (error) {
        // E11000 on the unique (model, tokenType, effectiveFrom) index:
        // the lowercase row already exists — this row is a case-variant
        // duplicate registration. Keep the existing row, leave this one
        // as stored (see collision rule above), and make the skip loud.
        if ((error as { code?: number }).code !== 11000) {
          throw error;
        }

        logger?.warn(
          '019-lowercase-model-ids: skipped case-variant duplicate price ' +
            'version — the lowercase form is already registered; row left ' +
            'as stored (inert)',
          {
            model,
            tokenType: document['tokenType'],
            effectiveFrom:
              (document['effectiveFrom'] as Date)?.toISOString?.() ??
              document['effectiveFrom'],
          },
        );
      }
    }
  },
};
