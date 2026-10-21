import { Router } from 'express';
import type { DependencyStatus, HealthResponse, ReadinessResponse } from '@bizmgmt/contracts';
import { AppError } from '../errors.js';

export type ReadinessCheck = () => Promise<DependencyStatus>;

export function healthRouter(options: { version: string; checks: Record<string, ReadinessCheck> }): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const body: HealthResponse = {
      status: 'ok',
      service: 'api',
      version: options.version,
      time: new Date().toISOString(),
    };
    res.json(body);
  });

  router.get('/ready', async (_req, res) => {
    const entries = await Promise.all(
      Object.entries(options.checks).map(async ([name, check]) => {
        try {
          return [name, await check()] as const;
        } catch {
          return [name, 'down'] as const;
        }
      }),
    );
    const checks = Object.fromEntries(entries);
    if (Object.values(checks).includes('down')) {
      // Dependency names are not sensitive; their connection details are never included.
      throw new AppError('NOT_READY', 'Service is not ready', entries
        .filter(([, status]) => status === 'down')
        .map(([name]) => ({ path: name, message: 'down' })));
    }
    const body: ReadinessResponse = { status: 'ready', checks };
    res.json(body);
  });

  return router;
}
