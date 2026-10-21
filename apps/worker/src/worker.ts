import type { Logger } from 'pino';

/**
 * A unit of background work (the outbox consumer, scheduled jobs); each
 * task must be idempotent because a crash between work and acknowledgement
 * causes it to run again.
 */
export interface WorkerTask {
  name: string;
  /** Returns true if it did work (the loop then polls again immediately). */
  runOnce(signal: AbortSignal): Promise<boolean>;
}

export interface Worker {
  start(): void;
  stop(): Promise<void>;
}

export function createWorker(options: { tasks: WorkerTask[]; pollMs: number; logger: Logger }): Worker {
  const { tasks, pollMs, logger } = options;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  async function tick(): Promise<void> {
    let didWork = false;
    for (const task of tasks) {
      if (controller.signal.aborted) return;
      try {
        didWork = (await task.runOnce(controller.signal)) || didWork;
      } catch (err) {
        // A failing task must not stop the others; retries/backoff are the task's responsibility.
        logger.error({ err, task: task.name }, 'task failed');
      }
    }
    schedule(didWork ? 0 : pollMs);
  }

  function schedule(delay: number) {
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      running = tick();
    }, delay);
  }

  return {
    start() {
      logger.info({ tasks: tasks.map((t) => t.name), pollMs }, 'worker started');
      schedule(0);
    },
    async stop() {
      controller.abort();
      if (timer) clearTimeout(timer);
      await running;
      logger.info('worker stopped');
    },
  };
}
