import { Schema, type Types } from 'mongoose';
import type { DocumentType, TaxTreatment, TurnoverBand, Uqc, WorkflowSettings } from '@bizmgmt/contracts';
import { appendOnly, tenantScoped } from './platform/tenant-scope.js';

/**
 * Organization, catalogue and party collections (docs/database/schema.md §2).
 * Money, prices, quantities and rates are Decimal128; they cross the API as decimal strings.
 */
type Decimal = Types.Decimal128;

const objectId = Schema.Types.ObjectId;
const decimal = Schema.Types.Decimal128;
const timestamps = { timestamps: true } as const;

export interface AddressDoc {
  line1: string;
  line2: string;
  city: string;
  district: string;
  stateCode: string;
  pincode: string;
}

const addressSchema = new Schema<AddressDoc>(
  {
    line1: { type: String, required: true },
    line2: { type: String, default: '' },
    city: { type: String, required: true },
    district: { type: String, default: '' },
    stateCode: { type: String, required: true },
    pincode: { type: String, required: true },
  },
  { _id: false },
);

// ------------------------------------------------------------ organization

export interface BankAccountDoc {
  id: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  ifsc: string;
  branch: string;
  upiId: string;
  isDefault: boolean;
}

export interface LogoDoc {
  fileId: Types.ObjectId;
  contentType: 'image/png' | 'image/jpeg';
  sizeBytes: number;
  width: number;
  height: number;
}

export interface LegalEntityDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalName: string;
  tradeName: string;
  pan: string;
  constitution: string;
  address: AddressDoc;
  email: string;
  phone: string;
  fyStartMonth: 4;
  turnoverBand: TurnoverBand;
  workflow: WorkflowSettings;
  bankAccounts: BankAccountDoc[];
  /** Posting lock (FR-CO-05); enforced from Phase 6. */
  periodLockDate: string | null;
  /** Printed on documents numbered after it was set (FR-CO-01). */
  logo: LogoDoc | null;
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const legalEntitySchema = new Schema<LegalEntityDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalName: { type: String, required: true },
    tradeName: { type: String, default: '' },
    pan: { type: String, required: true },
    constitution: { type: String, required: true },
    address: { type: addressSchema, required: true },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    fyStartMonth: { type: Number, default: 4 },
    turnoverBand: { type: String, required: true },
    workflow: {
      stockOutPoint: { type: String, enum: ['dispatch', 'invoice'], required: true },
      stockInPoint: { type: String, enum: ['goods_receipt', 'supplier_bill'], required: true },
      allowNegativeStock: { type: Boolean, required: true },
      roundOffTotal: { type: Boolean, required: true },
    },
    bankAccounts: {
      type: [
        new Schema<BankAccountDoc>(
          {
            id: { type: String, required: true },
            bankName: String,
            accountName: String,
            accountNumber: String,
            ifsc: String,
            branch: { type: String, default: '' },
            upiId: { type: String, default: '' },
            isDefault: { type: Boolean, default: false },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    periodLockDate: { type: String, default: null },
    logo: {
      type: new Schema<LogoDoc>({ fileId: { type: objectId, required: true }, contentType: { type: String, required: true }, sizeBytes: { type: Number, required: true }, width: { type: Number, required: true }, height: { type: Number, required: true } }, { _id: false }),
      default: null,
    },
    archivedAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  timestamps,
);
legalEntitySchema.index({ tenantId: 1, legalName: 1 });
legalEntitySchema.index({ tenantId: 1, pan: 1 }, { unique: true, partialFilterExpression: { archivedAt: null } });
legalEntitySchema.plugin(tenantScoped);

export interface GstRegistrationDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  gstin: string;
  stateCode: string;
  registrationType: 'regular' | 'composition';
  effectiveFrom: string;
  effectiveTo: string | null;
  address: AddressDoc;
  label: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const gstRegistrationSchema = new Schema<GstRegistrationDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    gstin: { type: String, required: true },
    stateCode: { type: String, required: true },
    registrationType: { type: String, enum: ['regular', 'composition'], required: true },
    effectiveFrom: { type: String, required: true },
    effectiveTo: { type: String, default: null },
    address: { type: addressSchema, required: true },
    label: { type: String, default: '' },
    version: { type: Number, default: 0 },
  },
  timestamps,
);
gstRegistrationSchema.index({ tenantId: 1, gstin: 1 }, { unique: true });
gstRegistrationSchema.index({ tenantId: 1, legalEntityId: 1 });
gstRegistrationSchema.plugin(tenantScoped);

export interface DocumentSeriesDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  gstRegistrationId: Types.ObjectId | null;
  /** Registration id or legal entity id: the numbering scope (schema.md `sequences.scopeId`). */
  scopeId: Types.ObjectId;
  docType: DocumentType;
  name: string;
  prefix: string;
  padding: number;
  startNumber: number;
  isDefault: boolean;
  active: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const documentSeriesSchema = new Schema<DocumentSeriesDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    gstRegistrationId: { type: objectId, default: null },
    scopeId: { type: objectId, required: true },
    docType: { type: String, required: true },
    name: { type: String, required: true },
    prefix: { type: String, default: '' },
    padding: { type: Number, required: true },
    startNumber: { type: Number, default: 1 },
    isDefault: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    version: { type: Number, default: 0 },
  },
  timestamps,
);
documentSeriesSchema.index({ tenantId: 1, legalEntityId: 1, docType: 1 });
documentSeriesSchema.index({ tenantId: 1, scopeId: 1, docType: 1 });
documentSeriesSchema.plugin(tenantScoped);

/** Per-series, per-financial-year counter. Numbers are taken only inside the issuing transaction (NumberingService). */
export interface SequenceDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  seriesId: Types.ObjectId;
  fy: string;
  next: number;
  /** Numbers actually issued; any issued number locks the series format. */
  issuedCount: number;
}

export const sequenceSchema = new Schema<SequenceDoc>({
  tenantId: { type: objectId, required: true },
  seriesId: { type: objectId, required: true },
  fy: { type: String, required: true },
  next: { type: Number, required: true },
  issuedCount: { type: Number, default: 0 },
});
sequenceSchema.index({ tenantId: 1, seriesId: 1, fy: 1 }, { unique: true });
sequenceSchema.plugin(tenantScoped);

// --------------------------------------------------------------- catalogue

export interface UnitDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  code: string;
  name: string;
  uqc: Uqc;
  decimals: number;
  archivedAt: Date | null;
  version: number;
}

export const unitSchema = new Schema<UnitDoc>({
  tenantId: { type: objectId, required: true },
  code: { type: String, required: true },
  name: { type: String, required: true },
  uqc: { type: String, required: true },
  decimals: { type: Number, required: true },
  archivedAt: { type: Date, default: null },
  version: { type: Number, default: 0 },
});
unitSchema.index({ tenantId: 1, code: 1 }, { unique: true });
unitSchema.plugin(tenantScoped);

export interface CategoryDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  nameKey: string;
  archivedAt: Date | null;
  version: number;
}

export const categorySchema = new Schema<CategoryDoc>({
  tenantId: { type: objectId, required: true },
  name: { type: String, required: true },
  nameKey: { type: String, required: true },
  archivedAt: { type: Date, default: null },
  version: { type: Number, default: 0 },
});
categorySchema.index({ tenantId: 1, nameKey: 1 }, { unique: true });
categorySchema.plugin(tenantScoped);

export interface RateScheduleDoc {
  _id: Types.ObjectId;
  effectiveFrom: string;
  effectiveTo: string | null;
  gstRate: Decimal;
  cessRate: Decimal | null;
  sourceReference: string;
  verifiedBy: Types.ObjectId;
  verifiedAt: Date;
}

export interface TaxClassDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  nameKey: string;
  kind: 'goods' | 'service';
  treatment: TaxTreatment;
  reverseCharge: boolean;
  description: string;
  /** Effective-dated, non-overlapping. Embedded so the overlap check and the write are one atomic update. */
  schedules: RateScheduleDoc[];
  archivedAt: Date | null;
  version: number;
}

export const taxClassSchema = new Schema<TaxClassDoc>({
  tenantId: { type: objectId, required: true },
  name: { type: String, required: true },
  nameKey: { type: String, required: true },
  kind: { type: String, enum: ['goods', 'service'], required: true },
  treatment: { type: String, required: true },
  reverseCharge: { type: Boolean, default: false },
  description: { type: String, default: '' },
  schedules: {
    type: [
      new Schema<RateScheduleDoc>({
        effectiveFrom: { type: String, required: true },
        effectiveTo: { type: String, default: null },
        gstRate: { type: decimal, required: true },
        cessRate: { type: decimal, default: null },
        sourceReference: { type: String, required: true },
        verifiedBy: { type: objectId, required: true },
        verifiedAt: { type: Date, required: true },
      }),
    ],
    default: [],
  },
  archivedAt: { type: Date, default: null },
  version: { type: Number, default: 0 },
});
taxClassSchema.index({ tenantId: 1, nameKey: 1 }, { unique: true });
taxClassSchema.plugin(tenantScoped);

export interface ItemDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  sku: string;
  name: string;
  nameKey: string;
  description: string;
  type: 'stock' | 'non_stock' | 'service';
  categoryId: Types.ObjectId | null;
  baseUnitId: Types.ObjectId;
  altUnits: Array<{ unitId: Types.ObjectId; factor: Decimal }>;
  hsnSac: string;
  taxClassId: Types.ObjectId;
  salePrice: Decimal | null;
  purchasePrice: Decimal | null;
  reorderLevel: Decimal | null;
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const itemSchema = new Schema<ItemDoc>(
  {
    tenantId: { type: objectId, required: true },
    sku: { type: String, required: true },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    description: { type: String, default: '' },
    type: { type: String, enum: ['stock', 'non_stock', 'service'], required: true },
    categoryId: { type: objectId, default: null },
    baseUnitId: { type: objectId, required: true },
    altUnits: { type: [new Schema({ unitId: { type: objectId, required: true }, factor: { type: decimal, required: true } }, { _id: false })], default: [] },
    hsnSac: { type: String, required: true },
    taxClassId: { type: objectId, required: true },
    salePrice: { type: decimal, default: null },
    purchasePrice: { type: decimal, default: null },
    reorderLevel: { type: decimal, default: null },
    archivedAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  timestamps,
);
itemSchema.index({ tenantId: 1, sku: 1 }, { unique: true });
itemSchema.index({ tenantId: 1, nameKey: 1, _id: 1 });
itemSchema.index({ tenantId: 1, hsnSac: 1 });
itemSchema.plugin(tenantScoped);

// ----------------------------------------------------------------- parties

export interface PartyDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  nameKey: string;
  legalName: string;
  isCustomer: boolean;
  isSupplier: boolean;
  pan: string | null;
  gstins: Array<{ gstin: string; stateCode: string; addressId: string | null }>;
  addresses: Array<AddressDoc & { id: string; label: string; isBilling: boolean; isShipping: boolean }>;
  contacts: Array<{ id: string; name: string; designation: string; phone: string; phoneKey: string; email: string }>;
  creditLimit: Decimal | null;
  paymentTermsDays: number | null;
  tags: string[];
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const partySchema = new Schema<PartyDoc>(
  {
    tenantId: { type: objectId, required: true },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    legalName: { type: String, default: '' },
    isCustomer: { type: Boolean, required: true },
    isSupplier: { type: Boolean, required: true },
    pan: { type: String, default: null },
    gstins: { type: [new Schema({ gstin: String, stateCode: String, addressId: { type: String, default: null } }, { _id: false })], default: [] },
    addresses: {
      type: [
        new Schema(
          {
            id: { type: String, required: true },
            label: { type: String, default: '' },
            isBilling: { type: Boolean, default: false },
            isShipping: { type: Boolean, default: false },
            line1: String,
            line2: { type: String, default: '' },
            city: String,
            district: { type: String, default: '' },
            stateCode: String,
            pincode: String,
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    contacts: {
      type: [new Schema({ id: String, name: String, designation: { type: String, default: '' }, phone: { type: String, default: '' }, phoneKey: { type: String, default: '' }, email: { type: String, default: '' } }, { _id: false })],
      default: [],
    },
    creditLimit: { type: decimal, default: null },
    paymentTermsDays: { type: Number, default: null },
    tags: { type: [String], default: [] },
    archivedAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  timestamps,
);
partySchema.index({ tenantId: 1, nameKey: 1, _id: 1 });
partySchema.index({ tenantId: 1, 'gstins.gstin': 1 });
partySchema.index({ tenantId: 1, pan: 1 }, { partialFilterExpression: { pan: { $type: 'string' } } });
partySchema.index({ tenantId: 1, 'contacts.phoneKey': 1 });
partySchema.plugin(tenantScoped);

export interface CrmNoteDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  partyId: Types.ObjectId;
  body: string;
  authorId: Types.ObjectId;
  createdAt: Date;
}

export const crmNoteSchema = new Schema<CrmNoteDoc>({
  tenantId: { type: objectId, required: true },
  partyId: { type: objectId, required: true },
  body: { type: String, required: true },
  authorId: { type: objectId, required: true },
  createdAt: { type: Date, required: true },
});
crmNoteSchema.index({ tenantId: 1, partyId: 1, _id: -1 });
crmNoteSchema.plugin(tenantScoped);
// Notes are a record of what was said; corrections are added as new notes.
crmNoteSchema.plugin(appendOnly);

export interface CrmTaskDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  partyId: Types.ObjectId;
  title: string;
  details: string;
  dueDate: string;
  assigneeId: Types.ObjectId;
  status: 'open' | 'done' | 'cancelled';
  createdBy: Types.ObjectId;
  completedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const crmTaskSchema = new Schema<CrmTaskDoc>(
  {
    tenantId: { type: objectId, required: true },
    partyId: { type: objectId, required: true },
    title: { type: String, required: true },
    details: { type: String, default: '' },
    dueDate: { type: String, required: true },
    assigneeId: { type: objectId, required: true },
    status: { type: String, enum: ['open', 'done', 'cancelled'], default: 'open' },
    createdBy: { type: objectId, required: true },
    completedAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  timestamps,
);
crmTaskSchema.index({ tenantId: 1, assigneeId: 1, status: 1, dueDate: 1 });
crmTaskSchema.index({ tenantId: 1, partyId: 1, dueDate: 1 });
crmTaskSchema.plugin(tenantScoped);
