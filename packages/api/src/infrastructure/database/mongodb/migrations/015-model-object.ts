import { Migration } from '../helpers/migration-runner.js';
import { parseModelRef } from '../../../../domain/models/model-ref.js';
import { TRACES_COLLECTION } from '../collections.js';

/**
 * Structural rewrite (the ONE exception so far to decision 74's
 * indexes-only chain, logged as its own decision): traces stored before
 * the model became a structured ref carry `model` as the raw source
 * string. Rewrites them to the canonical `{ id, provider }` block with
 * the same parse rule ingestion applies, so readers never meet both
 * shapes. Touches ONLY the model field — the price stamp is immutable
 * (invariant 1) and is not re-derived here.
 *
 * Idempotent by construction: the filter matches string models only, so
 * a re-run (or a crash-replay) finds nothing left to rewrite.
 */
export const modelObject: Migration = {
  id: '015-model-object',

  async run(db) {
    const traces = db.collection(TRACES_COLLECTION);

    const cursor = traces.find(
      { model: { $type: 'string' } },
      { projection: { _id: 1, model: 1 } },
    );

    for await (const document of cursor) {
      await traces.updateOne(
        { _id: document['_id'] },
        { $set: { model: parseModelRef(document['model'] as string) } },
      );
    }
  },
};
