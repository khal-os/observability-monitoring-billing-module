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
setupV1Routes(server.app);
// LAST: 404 catch-all + JSON error boundary must trail every route.
setupErrorHandling(server.app);

export { server };
