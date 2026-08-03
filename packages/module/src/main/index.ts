import { config } from '../infrastructure/index.js';
import { server } from './server/app.js';
import { makeDatabase } from './factories/database-factory.js';

const database = makeDatabase();

await database.connect();
await server.start(config);

/**
 * Graceful shutdown (C-5.4): docker stop / ^C must drain in-flight
 * requests (server.stop() awaits open connections) and close the Mongo
 * pool — not die mid-write. A hard-kill timer guards the drain: past 10s
 * the process exits non-zero rather than hang the deploy.
 */
const HARD_KILL_TIMEOUT_MS = 10_000;

// Idempotence: SIGTERM followed by ^C must NOT run two concurrent
// shutdowns — the second server.stop() would throw ERR_SERVER_NOT_RUNNING
// and race exit(1) against the first drain's exit(0).
let shuttingDown = false;

const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) {
    console.log(`${signal} received: shutdown already in progress.`);
    return;
  }
  shuttingDown = true;

  console.log(`${signal} received: shutting down…`);

  // unref: the timer must never keep an otherwise-finished process alive.
  const hardKill = setTimeout(() => {
    console.error(
      `Shutdown did not finish within ${HARD_KILL_TIMEOUT_MS}ms — exiting hard.`,
    );
    process.exit(1);
  }, HARD_KILL_TIMEOUT_MS);
  hardKill.unref();

  void (async () => {
    try {
      await server.stop();
      await database.disconnect();
      clearTimeout(hardKill);
      process.exit(0);
    } catch (error) {
      console.error('Shutdown error:', error);
      process.exit(1);
    }
  })();
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
