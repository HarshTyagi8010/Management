import { describe, expect, it } from 'vitest';
import { itemInputSchema, rateScheduleInputSchema } from './catalogue.js';
import {
  financialYear,
  gstinCheckCharacter,
  gstinProblem,
  INDIAN_STATES,
  panProblem,
  phoneKey,
  pinMatchesState,
  shortFinancialYear,
  turnoverRules,
  UQC_LIST,
} from './india.js';
import { formatDocumentNumber, gstRegistrationInputSchema, seriesCapacity, seriesInputSchema } from './organization.js';
import { partyInputSchema } from './parties.js';

/** Synthetic GSTIN with a correct check character (test data only). */
const synthetic = (state: string, pan: string, entity = '1') => {
  const body = `${state}${pan}${entity}Z`;
  return body + gstinCheckCharacter(body);
};

describe('GSTIN', () => {
  it('accepts the python-stdnum reference GSTIN and rejects a wrong check character', () => {
    expect(gstinProblem('27AAPFU0939F1ZV')).toBeUndefined();
    expect(gstinProblem('27AAPFU0939F1ZW')).toMatch(/check character/);
  });

  it('rejects bad length, layout, state code and PAN holder type', () => {
    expect(gstinProblem('27AAPFU0939F1Z')).toMatch(/15 characters/);
    expect(gstinProblem('27AAPFU0939F1XV')).toMatch(/look like a GSTIN/);
    expect(gstinProblem('27AAPFU0939F0ZV')).toMatch(/look like a GSTIN/);
    expect(gstinProblem(synthetic('28', 'AAPFU0939F'))).toMatch(/state code/);
    expect(gstinProblem(synthetic('27', 'AAPXU0939F'))).toMatch(/valid PAN/);
  });

  it('detects every single-character typo in a valid GSTIN', () => {
    const valid = synthetic('29', 'AABCT1234Q');
    expect(gstinProblem(valid)).toBeUndefined();
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let i = 0; i < 15; i += 1) {
      for (const c of alphabet) {
        if (c === valid[i]) continue;
        const typo = valid.slice(0, i) + c + valid.slice(i + 1);
        expect(gstinProblem(typo), typo).toBeDefined();
      }
    }
  });
});

describe('PAN, PIN, phone', () => {
  it('validates PAN layout and holder type', () => {
    expect(panProblem('AAPFU0939F')).toBeUndefined();
    expect(panProblem('AAPXU0939F')).toMatch(/holder type/);
    expect(panProblem('AAPF0939FU')).toMatch(/5 letters/);
  });

  it('checks PIN prefixes against state ranges from the e-invoice master', () => {
    expect(pinMatchesState('400001', '27')).toBe(true);
    expect(pinMatchesState('560001', '27')).toBe(false);
    expect(pinMatchesState('194101', '38')).toBe(true);
  });

  it('normalises Indian phone numbers for duplicate checks', () => {
    expect(phoneKey('+91 98765 43210')).toBe('9876543210');
    expect(phoneKey('09876543210')).toBe('9876543210');
    // A landline with its 0 trunk prefix and the same number with +91 compare equal.
    expect(phoneKey('022-2345 6789')).toBe('2223456789');
    expect(phoneKey('+91 22 2345 6789')).toBe('2223456789');
  });

  it('lists 37 states (no 28) and 45 UQCs, as on the e-invoice portal', () => {
    expect(INDIAN_STATES).toHaveLength(37);
    expect(INDIAN_STATES.some((s) => s.code === '28')).toBe(false);
    expect(UQC_LIST).toHaveLength(45);
  });
});

describe('financial year and document numbers', () => {
  it('uses April–March', () => {
    expect(financialYear('2026-03-31')).toBe('2025-26');
    expect(financialYear('2026-04-01')).toBe('2026-27');
    expect(financialYear('2099-12-31')).toBe('2099-00');
    expect(shortFinancialYear('2026-27')).toBe('26-27');
  });

  it('formats numbers and computes capacity within 16 characters', () => {
    const format = { prefix: 'INV/{FY}/', padding: 4 };
    expect(formatDocumentNumber(format, 12, '2026-27')).toBe('INV/26-27/0012');
    expect(seriesCapacity(format)).toBe(999_999);
    expect(formatDocumentNumber(format, seriesCapacity(format), '2026-27')).toHaveLength(16);
    expect(seriesCapacity({ prefix: 'ABCDEFGHIJKLMN', padding: 3 })).toBe(0);
  });

  const base = { legalEntityId: 'a'.repeat(24), name: 'Tax invoices', padding: 4 };
  it('rejects series that cannot fit 16 characters or use bad characters', () => {
    expect(seriesInputSchema.safeParse({ ...base, docType: 'tax_invoice', gstRegistrationId: 'b'.repeat(24), prefix: 'INV/{FY}/' }).success).toBe(true);
    expect(seriesInputSchema.safeParse({ ...base, docType: 'tax_invoice', gstRegistrationId: 'b'.repeat(24), prefix: 'INVOICE/{FY}/X' }).success).toBe(false);
    expect(seriesInputSchema.safeParse({ ...base, docType: 'tax_invoice', gstRegistrationId: 'b'.repeat(24), prefix: 'INV #' }).success).toBe(false);
  });

  it('requires a registration only for GST documents', () => {
    expect(seriesInputSchema.safeParse({ ...base, docType: 'tax_invoice', prefix: 'INV-' }).success).toBe(false);
    expect(seriesInputSchema.safeParse({ ...base, docType: 'quotation', prefix: 'QT-' }).success).toBe(true);
    expect(seriesInputSchema.safeParse({ ...base, docType: 'quotation', gstRegistrationId: 'b'.repeat(24), prefix: 'QT-' }).success).toBe(false);
  });
});

describe('registrations, rates, items and parties', () => {
  const address = { line1: '1 Example Road', city: 'Mumbai', stateCode: '27', pincode: '400001' };
  it('requires the registration address to be in the GSTIN state', () => {
    const gstin = synthetic('27', 'AAPFU0939F');
    expect(gstRegistrationInputSchema.safeParse({ gstin, registrationType: 'regular', effectiveFrom: '2017-07-01', address }).success).toBe(true);
    expect(gstRegistrationInputSchema.safeParse({ gstin, registrationType: 'regular', effectiveFrom: '2017-07-01', address: { ...address, stateCode: '29' } }).success).toBe(false);
  });

  it('accepts only sourced rates between 0 and 100 percent, without floating point', () => {
    const rate = { effectiveFrom: '2025-09-22', gstRate: '18', sourceReference: 'Checked by CA (synthetic test)' };
    expect(rateScheduleInputSchema.safeParse(rate).success).toBe(true);
    expect(rateScheduleInputSchema.safeParse({ ...rate, gstRate: '100.0001' }).success).toBe(false);
    expect(rateScheduleInputSchema.safeParse({ ...rate, gstRate: 18 }).success).toBe(false);
    expect(rateScheduleInputSchema.safeParse({ ...rate, sourceReference: '' }).success).toBe(false);
    expect(rateScheduleInputSchema.safeParse({ ...rate, effectiveTo: '2025-01-01' }).success).toBe(false);
  });

  it('validates item codes and conversion factors', () => {
    const item = { sku: 'abc-1', name: 'Test bolt', type: 'stock', baseUnitId: 'a'.repeat(24), hsnSac: '7318', taxClassId: 'b'.repeat(24) };
    expect(itemInputSchema.parse(item).sku).toBe('ABC-1');
    expect(itemInputSchema.safeParse({ ...item, altUnits: [{ unitId: 'c'.repeat(24), factor: '0' }] }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...item, altUnits: [{ unitId: 'c'.repeat(24), factor: '12' }] }).success).toBe(true);
    expect(itemInputSchema.safeParse({ ...item, hsnSac: '731' }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...item, salePrice: 10.5 }).success).toBe(false);
  });

  it('checks party GSTINs against the PAN and requires a role', () => {
    const p = { name: 'Example Buyer (test)', isCustomer: true, isSupplier: false, pan: 'AAPFU0939F', gstins: [{ gstin: synthetic('27', 'AAPFU0939F') }] };
    expect(partyInputSchema.safeParse(p).success).toBe(true);
    expect(partyInputSchema.safeParse({ ...p, gstins: [{ gstin: synthetic('27', 'AABCT1234Q') }] }).success).toBe(false);
    expect(partyInputSchema.safeParse({ ...p, isCustomer: false }).success).toBe(false);
  });

  it('derives HSN digits and e-invoice notices from the declared turnover band', () => {
    expect(turnoverRules('up_to_5cr')).toEqual({ hsnMinDigits: 4, eInvoiceApplicable: false, irpThirtyDayLimit: false });
    expect(turnoverRules('10cr_or_more')).toEqual({ hsnMinDigits: 6, eInvoiceApplicable: true, irpThirtyDayLimit: true });
  });
});

describe('PATCH schemas', () => {
  it('never fill in defaults for omitted fields (Zod applies defaults inside .partial())', async () => {
    const { itemUpdateSchema, taxClassUpdateSchema } = await import('./catalogue.js');
    const { partyUpdateSchema } = await import('./parties.js');
    const { legalEntityUpdateSchema } = await import('./organization.js');
    expect(itemUpdateSchema.parse({ version: 1, name: 'Renamed' })).toEqual({ version: 1, name: 'Renamed' });
    expect(taxClassUpdateSchema.parse({ version: 1, name: 'Renamed' })).toEqual({ version: 1, name: 'Renamed' });
    expect(legalEntityUpdateSchema.parse({ version: 1, tradeName: 'X' })).toEqual({ version: 1, tradeName: 'X' });
    expect(partyUpdateSchema.parse({ version: 1, name: 'Renamed' })).toEqual({ version: 1, name: 'Renamed', confirmDuplicates: false });
  });
});
