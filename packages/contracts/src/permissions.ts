/**
 * Action-level permissions and the system-role matrix.
 * Source of truth: docs/security/permission-matrix.md. A test parses that document
 * and fails if this file and the table disagree.
 *
 * "R" (read-only) cells in the matrix are modelled as separate view permissions:
 * `settings.view`, `tax.view` and `party.view_basic` (name and address only).
 */
export const PERMISSIONS = [
  'tenant.manage',
  'users.manage',
  'roles.manage',
  'settings.view',
  'settings.company',
  'settings.workflow',
  'period.lock',
  'period.unlock',
  'audit.view',
  'party.view_basic',
  'party.view',
  'party.edit',
  'crm.tasks',
  'item.view',
  'item.edit',
  'price.edit',
  'price.view_cost',
  'tax.view',
  'tax.manage',
  'stock.view',
  'stock.move',
  'stock.adjust',
  'stock.count.post',
  'quotation.edit',
  'quotation.issue',
  'salesorder.edit',
  'salesorder.confirm',
  'salesorder.cancel',
  'dispatch.post',
  'invoice.edit',
  'invoice.issue',
  'invoice.cancel',
  'purchase.edit',
  'purchase.issue',
  'bill.post',
  'bill.cancel',
  'receipt.post',
  'payment.post',
  'allocation.manage',
  'expense.post',
  'note.issue',
  'discount.override',
  'credit.override',
  'document.download',
  'report.financial',
  'report.sales',
  'export.csv',
  'regulatory.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);
export const isPermission = (value: string): value is Permission => PERMISSION_SET.has(value);

/** Permissions whose use requires a recent MFA verification (step-up). */
export const STEP_UP_PERMISSIONS: readonly Permission[] = [
  'users.manage',
  'roles.manage',
  'period.unlock',
  'regulatory.manage',
  'tenant.manage',
];

export const SYSTEM_ROLE_KEYS = ['owner', 'admin', 'accountant', 'sales', 'storekeeper', 'purchase', 'auditor'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export const SYSTEM_ROLE_NAMES: Record<SystemRoleKey, string> = {
  owner: 'Owner',
  admin: 'Admin',
  accountant: 'Accountant',
  sales: 'Sales',
  storekeeper: 'Storekeeper',
  purchase: 'Purchase',
  auditor: 'Auditor',
};

const ALL = PERMISSIONS.filter((p) => p !== 'tenant.manage' && p !== 'period.unlock' && p !== 'regulatory.manage');

/** Permissions granted to each system role. System roles are read-only; tenants clone them to customise. */
export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleKey, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: ALL,
  accountant: [
    'period.lock',
    'audit.view',
    'party.view_basic',
    'party.view',
    'party.edit',
    'crm.tasks',
    'item.view',
    'item.edit',
    'price.edit',
    'price.view_cost',
    'tax.view',
    'tax.manage',
    'stock.view',
    'stock.adjust',
    'stock.count.post',
    'quotation.edit',
    'quotation.issue',
    'salesorder.edit',
    'salesorder.confirm',
    'salesorder.cancel',
    'invoice.edit',
    'invoice.issue',
    'invoice.cancel',
    'purchase.edit',
    'purchase.issue',
    'bill.post',
    'bill.cancel',
    'receipt.post',
    'payment.post',
    'allocation.manage',
    'expense.post',
    'note.issue',
    'document.download',
    'report.financial',
    'report.sales',
    'export.csv',
  ],
  sales: [
    'party.view_basic',
    'party.view',
    'party.edit',
    'crm.tasks',
    'item.view',
    'stock.view',
    'quotation.edit',
    'quotation.issue',
    'salesorder.edit',
    'salesorder.confirm',
    'salesorder.cancel',
    'invoice.edit',
    'document.download',
    'report.sales',
  ],
  storekeeper: ['party.view_basic', 'item.view', 'stock.view', 'stock.move', 'dispatch.post', 'document.download'],
  purchase: [
    'party.view_basic',
    'party.view',
    'party.edit',
    'crm.tasks',
    'item.view',
    'item.edit',
    'price.view_cost',
    'stock.view',
    'stock.move',
    'purchase.edit',
    'purchase.issue',
    'document.download',
  ],
  auditor: [
    'settings.view',
    'audit.view',
    'party.view_basic',
    'party.view',
    'item.view',
    'price.view_cost',
    'tax.view',
    'stock.view',
    'document.download',
    'report.financial',
    'report.sales',
    'export.csv',
  ],
};
