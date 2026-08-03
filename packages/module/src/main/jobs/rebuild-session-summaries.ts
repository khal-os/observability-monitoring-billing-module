import {
  makeDatabase,
  makeSessionSummaryRebuild,
} from '../factories/database-factory.js';

/**
 * Recomputes the sessions read-model (session_summaries, decision 80)
 * from the traces collection. Run once after restoring/backfilling a
 * deployment with pre-existing traces — ingestion maintains the
 * summaries by recompute-on-touch from then on, and any session left
 * stale by a crash heals on its next touch or on this job.
 */
const database = makeDatabase();

await database.connect();

try {
  await makeSessionSummaryRebuild().run();

  console.log('Session summaries: rebuilt from traces.');
} finally {
  await database.disconnect();
}
