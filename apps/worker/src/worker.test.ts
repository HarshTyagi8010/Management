import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorker, type WorkerTask } from './worker.js';

const logger = pino({ level: 'silent' });

afterEach(() => {
  vi.useRealTimers();
});

describe('createWorker', () => {
  it('polls tasks, isolates failures and stops cleanly', async () => {
    vi.useFakeTimers();
    const ok: WorkerTask = { name: 'ok', runOnce: vi.fn(async () => false) };
    const failing: WorkerTask = {
      name: 'failing',
      runOnce: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const worker = createWorker({ tasks: [failing, ok], pollMs: 1000, logger });
    worker.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(failing.runOnce).toHaveBeenCalledTimes(1);
    expect(ok.runOnce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(ok.runOnce).toHaveBeenCalledTimes(2);

    await worker.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ok.runOnce).toHaveBeenCalledTimes(2);
  });

  it('polls again immediately while a task reports work', async () => {
    // Real timers: with a 60 s poll interval, 4 calls can only happen via immediate re-polls.
    let remaining = 3;
    const task: WorkerTask = { name: 'drain', runOnce: vi.fn(async () => remaining-- > 0) };
    const worker = createWorker({ tasks: [task], pollMs: 60_000, logger });
    worker.start();
    await vi.waitFor(() => expect(task.runOnce).toHaveBeenCalledTimes(4), { timeout: 2000 });
    await worker.stop();
    expect(task.runOnce).toHaveBeenCalledTimes(4);
  });
});
