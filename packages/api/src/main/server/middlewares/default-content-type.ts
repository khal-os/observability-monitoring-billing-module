import { NextFunction, Request, Response } from 'express';

export const defaultContentTypeMiddleware = (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  res.type('application/json');

  next();
};
