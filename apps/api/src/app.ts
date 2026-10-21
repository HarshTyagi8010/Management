import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import { AppError } from './errors.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { resolveRequestId } from './middleware/request-id.js';
import { requireJson } from './middleware/require-json.js';
import { healthRouter, type ReadinessCheck } from './routes/health.js';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  readinessChecks: Record<string, ReadinessCheck>;
  /** Module routers mounted under /api/v1 (business modules are added here from Phase 3). */
  routers?: Router[];
}

export function createApp({ config, logger, readinessChecks, routers = [] }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('query parser', 'simple');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = resolveRequestId(req);
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // Log method, path and status only: no headers, query strings or bodies (may carry PII).
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );

  // The API serves JSON only, so its CSP can be fully locked down. The SPA's CSP is set where it is hosted.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
      },
      strictTransportSecurity: config.nodeEnv === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  const allowedOrigins = new Set(config.corsOrigins);
  app.use(
    cors({
      origin: (origin, callback) => {
        // Same-origin and non-browser requests carry no Origin header.
        if (!origin || allowedOrigins.has(origin)) return callback(null, true);
        callback(new AppError('FORBIDDEN', 'Origin not allowed'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'If-Match', 'X-Tenant-Id', 'X-Legal-Entity-Id', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
      maxAge: 600,
    }),
  );

  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use(requireJson);
  app.use(express.json({ limit: config.bodyLimit, strict: true, type: 'application/json' }));

  const v1 = express.Router();
  v1.use(healthRouter({ version: config.version, checks: readinessChecks }));
  for (const router of routers) v1.use(router);
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
