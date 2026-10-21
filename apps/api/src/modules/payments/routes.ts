import { Router, type Request, type Response } from 'express';
import {
  allocatePaymentSchema,
  createCreditNoteSchema,
  createDebitNoteSchema,
  createExpenseSchema,
  createPaymentSchema,
  createRefundSchema,
  expenseListQuerySchema,
  fifoAllocateSchema,
  noteListQuerySchema,
  objectIdSchema,
  partyStatementQuerySchema,
  paymentListQuerySchema,
  reversePaymentSchema,
  type Permission,
} from '@bizmgmt/contracts';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { requestMeta, requireAuth, requirePermission, tenantContext } from '../../middleware/auth.js';
import type { Models } from '../../models.js';
import { idempotent } from '../../platform/idempotency.js';
import type { IdentityService } from '../identity/identity.js';
import type { TenancyService, TenantContext } from '../tenancy/tenancy.js';
import type { PaymentService } from './payments.js';
import type { ExpenseService } from './expenses.js';
import type { NoteService } from './notes.js';
import type { StatementService } from './statements.js';

interface Deps {
  config: AppConfig;
  models: Models;
  now?: (() => Date) | undefined;
  identity: IdentityService;
  tenancy: TenancyService;
  payments: PaymentService;
  expenses: ExpenseService;
  notes: NoteService;
  statements: StatementService;
}

export function paymentsRouter({
  config,
  models,
  now,
  identity,
  tenancy,
  payments,
  expenses,
  notes,
  statements,
}: Deps): Router {
  const router = Router();
  const scoped = [requireAuth, tenantContext(tenancy)];
  const meta = (req: Request) => requestMeta(req, identity);
  const ctx = (req: Request): TenantContext => {
    if (!req.tenant) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    return req.tenant;
  };
  const id = (req: Request) => objectIdSchema.parse(req.params.id);
  const can = (permissions: Permission | Permission[]) => requirePermission(permissions, config);
  const once = idempotent(models, now);

  // -------------------------------------------------------------------------
  // Payments & Receipts
  // -------------------------------------------------------------------------
  router.get('/payments', ...scoped, can(['payment.post', 'receipt.post', 'report.financial']), async (req, res) => {
    const query = paymentListQuerySchema.parse(req.query);
    res.json(await payments.list(ctx(req), query));
  });

  router.post('/payments', ...scoped, can(['payment.post', 'receipt.post']), async (req, res) => {
    const input = createPaymentSchema.parse(req.body);
    const created = await payments.createDraft(ctx(req), input, meta(req));
    res.status(201).json(created);
  });

  router.get('/payments/:id', ...scoped, can(['payment.post', 'receipt.post', 'report.financial']), async (req, res) => {
    res.json(await payments.get(ctx(req), id(req)));
  });

  router.post('/payments/:id/post', ...scoped, can(['payment.post', 'receipt.post']), once, async (req, res) => {
    res.json(await payments.post(ctx(req), id(req), meta(req)));
  });

  router.post('/payments/:id/allocate', ...scoped, can('allocation.manage'), once, async (req, res) => {
    const input = allocatePaymentSchema.parse(req.body);
    res.json(await payments.allocate(ctx(req), id(req), input, meta(req)));
  });

  router.post('/payments/:id/fifo-allocate', ...scoped, can('allocation.manage'), once, async (req, res) => {
    const input = fifoAllocateSchema.parse(req.body);
    res.json(await payments.fifoAllocate(ctx(req), id(req), input, meta(req)));
  });

  router.post('/payments/:id/reverse', ...scoped, can(['payment.post', 'receipt.post']), once, async (req, res) => {
    const input = reversePaymentSchema.parse(req.body);
    res.json(await payments.reverse(ctx(req), id(req), input, meta(req)));
  });

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------
  router.post('/refunds', ...scoped, can('payment.post'), once, async (req, res) => {
    const input = createRefundSchema.parse(req.body);
    const created = await payments.createRefund(ctx(req), input, meta(req));
    res.status(201).json(created);
  });

  router.get('/refunds', ...scoped, can(['payment.post', 'report.financial']), async (req, res) => {
    const query = {
      legalEntityId: req.query.legalEntityId as string | undefined,
      paymentId: req.query.paymentId as string | undefined,
      partyId: req.query.partyId as string | undefined,
    };
    res.json(await payments.listRefunds(ctx(req), query));
  });

  // -------------------------------------------------------------------------
  // Expenses
  // -------------------------------------------------------------------------
  router.get('/expenses', ...scoped, can(['expense.post', 'report.financial']), async (req, res) => {
    const query = expenseListQuerySchema.parse(req.query);
    res.json(await expenses.list(ctx(req), query));
  });

  router.post('/expenses', ...scoped, can('expense.post'), async (req, res) => {
    const input = createExpenseSchema.parse(req.body);
    const created = await expenses.createDraft(ctx(req), input, meta(req));
    res.status(201).json(created);
  });

  router.get('/expenses/:id', ...scoped, can(['expense.post', 'report.financial']), async (req, res) => {
    res.json(await expenses.get(ctx(req), id(req)));
  });

  router.post('/expenses/:id/post', ...scoped, can('expense.post'), once, async (req, res) => {
    res.json(await expenses.post(ctx(req), id(req), meta(req)));
  });

  router.post('/expenses/:id/cancel', ...scoped, can('expense.post'), once, async (req, res) => {
    const reason = typeof req.body.reason === 'string' ? req.body.reason : 'Cancelled';
    res.json(await expenses.cancel(ctx(req), id(req), reason, meta(req)));
  });

  // -------------------------------------------------------------------------
  // Credit Notes
  // -------------------------------------------------------------------------
  router.get('/credit-notes', ...scoped, can(['note.issue', 'report.financial']), async (req, res) => {
    const query = noteListQuerySchema.parse(req.query);
    res.json(await notes.listCreditNotes(ctx(req), query));
  });

  router.post('/credit-notes', ...scoped, can('note.issue'), async (req, res) => {
    const input = createCreditNoteSchema.parse(req.body);
    const created = await notes.createCreditNote(ctx(req), input, meta(req));
    res.status(201).json(created);
  });

  router.get('/credit-notes/:id', ...scoped, can(['note.issue', 'report.financial']), async (req, res) => {
    res.json(await notes.getCreditNote(ctx(req), id(req)));
  });

  router.post('/credit-notes/:id/issue', ...scoped, can('note.issue'), once, async (req, res) => {
    res.json(await notes.issueCreditNote(ctx(req), id(req), meta(req)));
  });

  router.post('/credit-notes/:id/cancel', ...scoped, can('note.issue'), once, async (req, res) => {
    const reason = typeof req.body.reason === 'string' ? req.body.reason : 'Cancelled';
    res.json(await notes.cancelCreditNote(ctx(req), id(req), reason, meta(req)));
  });

  // -------------------------------------------------------------------------
  // Debit Notes
  // -------------------------------------------------------------------------
  router.get('/debit-notes', ...scoped, can(['note.issue', 'report.financial']), async (req, res) => {
    const query = noteListQuerySchema.parse(req.query);
    res.json(await notes.listDebitNotes(ctx(req), query));
  });

  router.post('/debit-notes', ...scoped, can('note.issue'), async (req, res) => {
    const input = createDebitNoteSchema.parse(req.body);
    const created = await notes.createDebitNote(ctx(req), input, meta(req));
    res.status(201).json(created);
  });

  router.get('/debit-notes/:id', ...scoped, can(['note.issue', 'report.financial']), async (req, res) => {
    res.json(await notes.getDebitNote(ctx(req), id(req)));
  });

  router.post('/debit-notes/:id/issue', ...scoped, can('note.issue'), once, async (req, res) => {
    res.json(await notes.issueDebitNote(ctx(req), id(req), meta(req)));
  });

  router.post('/debit-notes/:id/cancel', ...scoped, can('note.issue'), once, async (req, res) => {
    const reason = typeof req.body.reason === 'string' ? req.body.reason : 'Cancelled';
    res.json(await notes.cancelDebitNote(ctx(req), id(req), reason, meta(req)));
  });

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------
  router.get('/parties/:id/statement', ...scoped, can('report.financial'), async (req, res) => {
    const partyId = id(req);
    const query = partyStatementQuerySchema.parse({
      partyId,
      legalEntityId: req.query.legalEntityId,
      from: req.query.from,
      to: req.query.to,
    });
    res.json(await statements.getPartyStatement(ctx(req), query));
  });

  return router;
}
