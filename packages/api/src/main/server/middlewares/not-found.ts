import { Request, Response } from 'express';
import { NotFoundError } from '../../../presentation/errors/index.js';

/**
 * Catch-all registered AFTER every route: an unknown path answers in the
 * same {name, msg} JSON error shape as the controllers — never Express's
 * HTML "Cannot GET" page.
 */
export const notFoundMiddleware = (req: Request, res: Response): void => {
  res.status(404).json(new NotFoundError(`${req.method} ${req.path}`));
};
