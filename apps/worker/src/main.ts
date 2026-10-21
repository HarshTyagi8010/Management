import { pino } from 'pino';
import { z } from 'zod';
import { startJobRuntime } from '@bizmgmt/api/jobs';
import { createWorker } from './worker.js';

const env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    WORKER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  })
  .safeParse(process.env);

if (!env.success) {
  console.error(`Invalid configuration: ${env.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  process.exit(1);
}

const logger = pino({
  level: env.data.LOG_LEVEL,
  base: { service: 'worker' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ['*.password', '*.token', '*.secret', '*.otp'], censor: '[REDACTED]' },
});

// Tasks (outbox consumer, document rendering, scheduled integrity checks) come
// from the API package and use the same environment variables as the API.
let runtime: Awaited<ReturnType<typeof startJobRuntime>>;
try {
  runtime = await startJobRuntime(logger);
} catch (err) {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'worker could not start');
  process.exit(1);
}
const worker = createWorker({ tasks: runtime.tasks, pollMs: env.data.WORKER_POLL_MS, logger });
worker.start();

const shutdown = (signal: string) => {
  logger.info({ signal }, 'shutting down');
  worker
    .stop()
    .then(() => runtime.close())
    .then(
      () => process.exit(0),
      () => process.exit(1),
    );
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
