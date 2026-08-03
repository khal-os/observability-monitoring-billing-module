import { NextFunction, Request, Response } from 'express';

export const defaultContentTypeMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // OPTIONS is answered by Express's default handler with a PLAIN-TEXT
  // method list ("GET,HEAD") — pre-setting JSON here would make that
  // reply lie to JSON-parsing clients. Every other request defaults to
  // the JSON type this API actually speaks.
  if (req.method !== 'OPTIONS') {
    res.type('application/json');
  }

  next();
};
