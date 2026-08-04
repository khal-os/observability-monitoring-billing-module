import {
  makeDatabase,
  makeFilterCounterRebuild,
  makeRebuildGuard,
} from '../factories/database-factory.js';


/**
 * Recomputes the facet cube (trace_filter_counters, decision 77) from the
 * traces collection. Run once after restoring/backfilling a deployment
 * with pre-existing traces, or anytime to repair drift — the cube is a
 * derived cache, this job is its source of truth. Fresh deployments need
 * nothing: ingestion maintains the cube incrementally.
 */
const database = makeDatabase();

await database.connect();

try {
  // audit F-1: same $out-swap hazard as the session rebuild.
  let tuples = 0;
  await makeRebuildGuard()(async () => {
    tuples = await makeFilterCounterRebuild().run();
  });

  console.log(`Filter counters: rebuilt ${tuples} dimension tuples.`);
} finally {
  await database.disconnect();
}
