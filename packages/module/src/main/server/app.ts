import { ExpressServer } from '../../infrastructure/index.js';
import {
  setupDocs,
  setupErrorHandling,
  setupMiddlewares,
  setupV1Routes,
} from './helpers/index.js';

const server = new ExpressServer();

// Docs come FIRST: the Swagger UI serves its own content types (html/css/js)
// and must not inherit the API-wide application/json default.
setupDocs(server.app);
setupMiddlewares(server.app);
const registeredRoutes = setupV1Routes(server.app);
// LAST: 404 catch-all + JSON error boundary must trail every route. The
// 405 table is DERIVED from the router above (audit D-4) — one spelling.
setupErrorHandling(server.app, registeredRoutes);

export { server };
