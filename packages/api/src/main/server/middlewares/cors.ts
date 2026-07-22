import { NextFunction, Request, Response } from 'express';

export const corsMiddleware = (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  res.set('access-control-allow-origin', '*');
  res.set('access-control-allow-methods', 'GET,POST');
  res.set('access-control-allow-headers', 'Content-Type, Authorization');

  next();
};
