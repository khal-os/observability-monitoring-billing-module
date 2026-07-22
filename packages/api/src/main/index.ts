import { config } from '../infrastructure/index.js';
import { server } from './server/app.js';
import { makeDatabase } from './factories/database-factory.js';

await makeDatabase().connect();
await server.start(config);
