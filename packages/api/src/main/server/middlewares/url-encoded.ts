import { urlencoded } from 'express';

export const urlEncodedMiddleware = urlencoded({ extended: true });
