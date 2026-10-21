import { randomBytes } from 'node:crypto';
import { trusted, type Types } from 'mongoose';
import type { Logger } from 'pino';
import type { IntegrityCheck } from '@bizmgmt/contracts';
import type { Models } from '../models.js';
import { isDuplicateKey } from '../platform/values.js';
import { reconcileJournals } from '../modules/finance/journals.js';
import { reconcileStock } from '../modules/inventory/reconciliation.js';
import { QuotationService } from '../modules/sales/quotations.js';
import { todayIST } from '../platform/values.js';
import type { WorkerTask } from './outbox.js';

export interface ScheduledJob {
  name: string;
  /** Time between the end of one run and the start of the next. */
  intervalMs: number;
  /** Returns a short summary for the lock record and logs. */
  run(): Promise<string>;
}

const RUN_LEASE_MS = 30 * 60_000;

/**
 * Scheduled jobs with a distributed lock (architecture §9): the lock document's
 * `lockedUntil` is both the lease while running and "not before" afterwards,
 * so across any number of worker instances each job runs once per interval.
 */
export function scheduler(deps: { models: Models; logger: Logger; jobs: ScheduledJob[]; now?: () => Date; owner?: string }): WorkerTask {
  const now = () => deps.now?.() ?? new Date();
  const owner = deps.owner ?? `worker-${randomBytes(4).toString('hex')}`;
  const acquire = async (job: ScheduledJob) => {
    const at = now();
    try {
      const lock = await deps.models.JobLock.findOneAndUpdate(
        { _id: job.name, lockedUntil: trusted({ $lte: at }) },
        { $set: { owner, lockedUntil: new Date(at.getTime() + RUN_LEASE_MS), lastStartedAt: at } },
        { upsert: true, returnDocument: 'after' },
      ).lean();
      return lock?.owner === owner;
    } catch (err) {
      // The lock exists and is held (or not due): the upsert collided with it.
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  };
  return {
    name: 'scheduler',
    async runOnce(signal) {
      let ran = false;
      for (const job of deps.jobs) {
        if (signal.aborted) break;
        if (!(await acquire(job))) continue;
        ran = true;
        let result: string;
        try {
          result = await job.run();
        } catch (err) {
          result = `failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`;
          deps.logger.error({ job: job.name, err: result }, 'scheduled job failed');
        }
        const finished = now();
        await deps.models.JobLock.updateOne({ _id: job.name, owner }, { $set: { owner: null, lockedUntil: new Date(finished.getTime() + job.intervalMs), lastFinishedAt: finished, lastResult: result } });
      }
      return ran;
    },
  };
}

async function saveCheck(models: Models, tenantId: Types.ObjectId, check: Omit<IntegrityCheck, 'checkedAt'>, at: Date) {
  await models.IntegrityCheck.updateOne({ tenantId, kind: check.kind }, { $set: { checkedAt: at, ok: check.ok, issueCount: check.issueCount, summary: check.summary } }, { upsert: true });
}

/** Daily integrity checks over every business (FR-INV-09, AC-INV-2, AC-JRN-1). Drift is logged at error level for alerting. */
export function integrityJobs(deps: { models: Models; logger: Logger; intervalMs: number; now?: () => Date }): ScheduledJob[] {
  const now = () => deps.now?.() ?? new Date();
  const tenants = () => deps.models.Tenant.find({ status: 'active' }, { _id: 1 }).lean();
  return [
    {
      name: 'stock-reconciliation',
      intervalMs: deps.intervalMs,
      async run() {
        let drift = 0;
        const list = await tenants();
        for (const { _id: tenantId } of list) {
          const r = await reconcileStock(deps.models, tenantId, 'all');
          drift += r.issues.length;
          await saveCheck(deps.models, tenantId, { kind: 'stock', ok: r.issues.length === 0, issueCount: r.issues.length, summary: r.issues.length ? `${r.issues.length} difference(s) between stock balances and the stock ledger` : `${r.balancesChecked} balances and ${r.valuationsChecked} valuations agree with the ledger` }, now());
          if (r.issues.length) deps.logger.error({ tenantId: tenantId.toHexString(), issues: r.issues.length }, 'stock reconciliation drift');
        }
        return `${list.length} businesses, ${drift} difference(s)`;
      },
    },
    {
      name: 'journal-reconciliation',
      intervalMs: deps.intervalMs,
      async run() {
        let problems = 0;
        const list = await tenants();
        for (const { _id: tenantId } of list) {
          const r = await reconcileJournals(deps.models, tenantId);
          problems += r.issues.length;
          await saveCheck(deps.models, tenantId, { kind: 'journals', ok: r.issues.length === 0, issueCount: r.issues.length, summary: r.issues.length ? `${r.issues.length} problem(s): ${[...new Set(r.issues.map((i) => i.kind))].join(', ')}` : `${r.journalsChecked} journals balance and the inventory account matches stock` }, now());
          if (r.issues.length) deps.logger.error({ tenantId: tenantId.toHexString(), issues: r.issues.length }, 'journal reconciliation problems');
        }
        return `${list.length} businesses, ${problems} problem(s)`;
      },
    },
  ];
}

/** Daily sales housekeeping: sent quotations past their validity become expired (workflows.md §1). */
export function salesJobs(deps: { models: Models; logger: Logger; intervalMs: number; now?: () => Date }): ScheduledJob[] {
  const now = () => deps.now?.() ?? new Date();
  return [
    {
      name: 'quotation-expiry',
      intervalMs: deps.intervalMs,
      async run() {
        let expired = 0;
        const list = await deps.models.Tenant.find({ status: 'active' }, { _id: 1 }).lean();
        for (const { _id: tenantId } of list) expired += await QuotationService.expire(deps.models, tenantId, todayIST(now()));
        if (expired) deps.logger.info({ expired }, 'quotations expired');
        return `${list.length} businesses, ${expired} quotation(s) expired`;
      },
    },
  ];
}
