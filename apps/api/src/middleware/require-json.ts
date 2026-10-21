import type { RequestHandler } from 'express';
import { AppError } from '../errors.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Requests that carry a body must declare application/json; anything else is rejected with 415. */
export const requireJson: RequestHandler = (req, _res, next) => {
  if (!BODY_METHODS.has(req.method)) return next();
  const hasBody =
    req.headers['transfer-encoding'] !== undefined ||
    (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
  if (hasBody && !req.is('application/json')) {
    return next(new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
  }
  next();
};
