import { makeDatabase, makePocPriceSeeder } from '../factories/database-factory.js';

// DEV-ONLY job (decision 74 — formerly migration 002): seeds the PoC demo
// price table. Production price tables are maintained EXCLUSIVELY via
// `make price` (invariant 9). The dev-only gate lives in the Makefile
// target (`make seed-prices` refuses clients without demo-data/ fixtures —
// the same discriminator `make sync` uses): in-container ENVIRONMENT is
// always `production` (compose.module.yml), so it cannot distinguish.

const database = makeDatabase();

await database.connect();

try {
  const { inserted, total } = await makePocPriceSeeder().run();

  console.log(
    `Seed: ${inserted} PoC price version(s) inserted, ${total - inserted} already present.`,
  );
} finally {
  await database.disconnect();
}
