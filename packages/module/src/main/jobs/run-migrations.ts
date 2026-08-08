import {
  makeDatabase,
  makeMigrationRunner,
} from '../factories/database-factory.js';

const database = makeDatabase();

await database.connect();

try {
  const applied = await makeMigrationRunner().run();

  if (applied.length === 0) {
    console.log('Migrations: nothing to apply, database is up to date.');
  } else {
    console.log(`Migrations: applied ${applied.join(', ')}.`);
  }
} finally {
  await database.disconnect();
}
