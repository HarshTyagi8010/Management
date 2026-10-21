import { z } from 'zod';

/**
 * India-specific identifiers and reference data, shared by web and API.
 * Sources (docs/compliance/gst.md §7): state codes and UQCs from the e-invoice
 * portal master codes (S10, checked 2026-10-19); GSTIN layout and check digit
 * (Luhn mod 36) and PAN holder types as implemented by python-stdnum (S11).
 * Passing these checks shows an identifier is well formed, not that it is
 * registered, active or belongs to the party.
 */

export interface IndianState {
  code: string;
  name: string;
  /** First three digits of PIN codes in the state (e-invoice master). Used for warnings only. */
  pinPrefixes: Array<[number, number]>;
  /** Kept so historic GSTINs and documents validate; not offered for new addresses. */
  legacy?: true;
}

export const INDIAN_STATES: readonly IndianState[] = [
  { code: '01', name: 'Jammu and Kashmir', pinPrefixes: [[180, 194]] },
  { code: '02', name: 'Himachal Pradesh', pinPrefixes: [[171, 177]] },
  { code: '03', name: 'Punjab', pinPrefixes: [[140, 160]] },
  { code: '04', name: 'Chandigarh', pinPrefixes: [[160, 160]] },
  { code: '05', name: 'Uttarakhand', pinPrefixes: [[244, 263]] },
  { code: '06', name: 'Haryana', pinPrefixes: [[121, 136]] },
  { code: '07', name: 'Delhi', pinPrefixes: [[110, 110]] },
  { code: '08', name: 'Rajasthan', pinPrefixes: [[301, 345]] },
  { code: '09', name: 'Uttar Pradesh', pinPrefixes: [[201, 285]] },
  { code: '10', name: 'Bihar', pinPrefixes: [[800, 855]] },
  { code: '11', name: 'Sikkim', pinPrefixes: [[737, 737]] },
  { code: '12', name: 'Arunachal Pradesh', pinPrefixes: [[790, 792]] },
  { code: '13', name: 'Nagaland', pinPrefixes: [[797, 798]] },
  { code: '14', name: 'Manipur', pinPrefixes: [[795, 795]] },
  { code: '15', name: 'Mizoram', pinPrefixes: [[796, 796]] },
  { code: '16', name: 'Tripura', pinPrefixes: [[799, 799]] },
  { code: '17', name: 'Meghalaya', pinPrefixes: [[793, 794]] },
  { code: '18', name: 'Assam', pinPrefixes: [[781, 788]] },
  { code: '19', name: 'West Bengal', pinPrefixes: [[700, 743]] },
  { code: '20', name: 'Jharkhand', pinPrefixes: [[813, 835]] },
  { code: '21', name: 'Odisha', pinPrefixes: [[751, 770]] },
  { code: '22', name: 'Chhattisgarh', pinPrefixes: [[490, 497]] },
  { code: '23', name: 'Madhya Pradesh', pinPrefixes: [[450, 488]] },
  { code: '24', name: 'Gujarat', pinPrefixes: [[360, 396]] },
  // The portal still lists 25 separately; the UT was merged into 26 in 2020.
  { code: '25', name: 'Daman and Diu', pinPrefixes: [[362, 362], [396, 396]], legacy: true },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', pinPrefixes: [[362, 362], [396, 396]] },
  { code: '27', name: 'Maharashtra', pinPrefixes: [[400, 445]] },
  { code: '29', name: 'Karnataka', pinPrefixes: [[560, 591]] },
  { code: '30', name: 'Goa', pinPrefixes: [[403, 403]] },
  { code: '31', name: 'Lakshadweep', pinPrefixes: [[682, 682]] },
  { code: '32', name: 'Kerala', pinPrefixes: [[670, 695]] },
  { code: '33', name: 'Tamil Nadu', pinPrefixes: [[600, 643]] },
  { code: '34', name: 'Puducherry', pinPrefixes: [[533, 533], [605, 605], [607, 607], [609, 609]] },
  { code: '35', name: 'Andaman and Nicobar Islands', pinPrefixes: [[744, 744]] },
  { code: '36', name: 'Telangana', pinPrefixes: [[500, 509]] },
  { code: '37', name: 'Andhra Pradesh', pinPrefixes: [[500, 535]] },
  { code: '38', name: 'Ladakh', pinPrefixes: [[194, 194]] },
];

const STATE_BY_CODE = new Map(INDIAN_STATES.map((s) => [s.code, s]));
export const stateName = (code: string): string | undefined => STATE_BY_CODE.get(code)?.name;
export const isStateCode = (code: string): boolean => STATE_BY_CODE.has(code);

/** Whether a PIN code falls in the state's published ranges (a hint, not a rule: ranges overlap at borders). */
export function pinMatchesState(pincode: string, stateCode: string): boolean {
  const state = STATE_BY_CODE.get(stateCode);
  const prefix = Number(pincode.slice(0, 3));
  return !!state && state.pinPrefixes.some(([from, to]) => prefix >= from && prefix <= to);
}

/** GST Unit Quantity Codes (e-invoice portal master, S10). */
export const UQC_CODES = {
  BAG: 'Bags',
  BAL: 'Bale',
  BDL: 'Bundles',
  BKL: 'Buckles',
  BOU: 'Billion of units',
  BOX: 'Box',
  BTL: 'Bottles',
  BUN: 'Bunches',
  CAN: 'Cans',
  CBM: 'Cubic metres',
  CCM: 'Cubic centimetres',
  CMS: 'Centimetres',
  CTN: 'Cartons',
  DOZ: 'Dozens',
  DRM: 'Drums',
  GGK: 'Great gross',
  GMS: 'Grammes',
  GRS: 'Gross',
  GYD: 'Gross yards',
  KGS: 'Kilograms',
  KLR: 'Kilolitre',
  KME: 'Kilometre',
  LTR: 'Litres',
  MLT: 'Millilitre',
  MTR: 'Metres',
  MTS: 'Metric ton',
  NOS: 'Numbers',
  OTH: 'Others',
  PAC: 'Packs',
  PCS: 'Pieces',
  PRS: 'Pairs',
  QTL: 'Quintal',
  ROL: 'Rolls',
  SET: 'Sets',
  SQF: 'Square feet',
  SQM: 'Square metres',
  SQY: 'Square yards',
  TBS: 'Tablets',
  TGM: 'Ten gross',
  THD: 'Thousands',
  TON: 'Tonnes',
  TUB: 'Tubes',
  UGS: 'US gallons',
  UNT: 'Units',
  YDS: 'Yards',
} as const;

export type Uqc = keyof typeof UQC_CODES;
export const UQC_LIST = Object.keys(UQC_CODES) as [Uqc, ...Uqc[]];

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Luhn checksum over base 36 (python-stdnum `luhn.checksum` with the GSTIN alphabet); 0 means valid. */
function luhn36(value: string): number {
  const digits = [...value].reverse().map((c) => ALPHABET.indexOf(c));
  if (digits.some((d) => d < 0)) return -1;
  let sum = 0;
  digits.forEach((d, i) => {
    if (i % 2 === 0) sum += d;
    else {
      const doubled = d * 2;
      sum += Math.floor(doubled / 36) + (doubled % 36);
    }
  });
  return sum % 36;
}

/** Computes the 15th character for a 14-character GSTIN body (used to build synthetic test data). */
export function gstinCheckCharacter(body14: string): string {
  for (const c of ALPHABET) if (luhn36(body14 + c) === 0) return c;
  throw new Error('Invalid GSTIN body');
}

/** PAN: 5 letters, 4 digits, 1 letter; the 4th letter is the holder type. */
const PAN_RE = /^[A-Z]{3}[ABCFGHLJPTK][A-Z][0-9]{4}[A-Z]$/;
export const PAN_HOLDER_TYPES: Record<string, string> = {
  A: 'Association of persons',
  B: 'Body of individuals',
  C: 'Company',
  F: 'Firm / LLP',
  G: 'Government agency',
  H: 'Hindu undivided family',
  L: 'Local authority',
  J: 'Artificial juridical person',
  P: 'Individual',
  T: 'Trust',
  K: 'Krish (trust)',
};

export function panProblem(pan: string): string | undefined {
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return 'PAN has 5 letters, 4 digits and a letter, like ABCDE1234F';
  if (!PAN_RE.test(pan)) return 'The 4th character of a PAN must be a valid holder type (for example C for a company, P for an individual)';
  return undefined;
}

/**
 * Normal-taxpayer GSTIN: state code, PAN, entity number (1–9, A–Z), "Z", check character.
 * Other GSTIN-like identifiers (UIN, TDS/TCS, non-resident) are not accepted here yet.
 */
export function gstinProblem(gstin: string): string | undefined {
  if (gstin.length !== 15) return 'A GSTIN has 15 characters';
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return 'This doesn’t look like a GSTIN (for example 27ABCDE1234F1Z5)';
  if (!isStateCode(gstin.slice(0, 2))) return 'The first two digits are not a valid GST state code';
  const pan = panProblem(gstin.slice(2, 12));
  if (pan) return 'Characters 3–12 must be a valid PAN';
  if (luhn36(gstin) !== 0) return 'The check character (last character) is wrong; check for a typing mistake';
  return undefined;
}

export const gstinStateCode = (gstin: string) => gstin.slice(0, 2);
export const gstinPan = (gstin: string) => gstin.slice(2, 12);

const upper = z.string().trim().toUpperCase();
export const gstinSchema = upper.superRefine((v, ctx) => {
  const problem = gstinProblem(v);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});
export const panSchema = upper.superRefine((v, ctx) => {
  const problem = panProblem(v);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});
export const stateCodeSchema = z.string().refine(isStateCode, 'Choose a state');

/**
 * Union Territories without a legislature, where intra-state supplies carry
 * UTGST instead of SGST (UTGST Act 2017, s.2(8)): Chandigarh, Dadra and Nagar
 * Haveli and Daman and Diu (and the old Daman and Diu code), Lakshadweep,
 * Andaman and Nicobar Islands, Ladakh. Delhi, Puducherry and Jammu and Kashmir
 * have legislatures and use SGST. Verify (gst.md GST-09).
 */
export const UTGST_STATE_CODES: readonly string[] = ['04', '25', '26', '31', '35', '38'];
export const pincodeSchema = z.string().trim().regex(/^[1-9][0-9]{5}$/, 'A PIN code has 6 digits and does not start with 0');
/** IFSC: 4 letters (bank), 0, 6 letters or digits (branch). */
export const ifscSchema = upper.pipe(z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'An IFSC has 11 characters, like HDFC0001234'));

/**
 * Phone numbers are stored as entered and also as a comparison key: digits only,
 * with a leading +91 / 91 / 0 removed from 10-digit Indian numbers.
 */
export function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}
export const phoneSchema = z
  .string()
  .trim()
  .max(20)
  .regex(/^\+?[0-9 ()-]{6,20}$/, 'Enter a phone number using digits, spaces, + or -')
  .refine((p) => phoneKey(p).length >= 6 && phoneKey(p).length <= 15, 'Enter a phone number with 6 to 15 digits');

/** HSN for goods: 4, 6 or 8 digits. SAC for services: 6 digits starting 99. */
export const hsnSacSchema = z.string().trim().regex(/^(\d{4}|\d{6}|\d{8})$/, 'HSN/SAC has 4, 6 or 8 digits');
export const isSac = (code: string) => /^99\d{4}$/.test(code);

/**
 * Declared aggregate annual turnover band (FR-CO-06), driving HSN digits (GST-04,
 * Notification 78/2020) and e-invoice notices (GST-06/07). Declared by the user, not computed.
 */
export const TURNOVER_BANDS = ['up_to_5cr', 'above_5cr_below_10cr', '10cr_or_more'] as const;
export type TurnoverBand = (typeof TURNOVER_BANDS)[number];
export const TURNOVER_BAND_LABELS: Record<TurnoverBand, string> = {
  up_to_5cr: 'Up to ₹5 crore',
  above_5cr_below_10cr: 'More than ₹5 crore and less than ₹10 crore',
  '10cr_or_more': '₹10 crore or more',
};

export function turnoverRules(band: TurnoverBand) {
  return {
    /** Minimum HSN digits on tax invoices (B2C supplies of smaller businesses have a separate exemption; see gst.md GST-04). */
    hsnMinDigits: band === 'up_to_5cr' ? 4 : 6,
    /** E-invoicing applies (GST-06); this system does not generate e-invoices yet. */
    eInvoiceApplicable: band !== 'up_to_5cr',
    /** E-invoices must be reported to the IRP within 30 days (GST-07). */
    irpThirtyDayLimit: band === '10cr_or_more',
  };
}

/**
 * Indian financial year (April–March) of a business date, e.g. 2026-10-19 → "2026-27".
 * GST document numbering restarts each financial year (GST-01).
 */
export function financialYear(businessDate: string): string {
  const [y, m] = businessDate.split('-').map(Number);
  if (!y || !m) throw new Error('Invalid business date');
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** "2026-27" → "26-27" (the {FY} token in document series). */
export const shortFinancialYear = (fy: string) => `${fy.slice(2, 4)}-${fy.slice(5, 7)}`;
