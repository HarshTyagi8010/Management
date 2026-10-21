import type { DocumentDefinition } from 'pdfmake';

/**
 * Printed sales documents (FR-DOC-01, gst.md §4): tax invoice, bill of supply,
 * quotation, proforma invoice and delivery challan. One layout, with the
 * particulars each document needs. The input is built only from the document's
 * frozen snapshot, never from current master data, so a document renders the
 * same whenever it is rendered (AC-DOC-1).
 *
 * Template versions are recorded on the document; a change to the layout gets
 * a new version and leaves documents printed earlier as they were.
 */
export const SALES_INVOICE_TEMPLATE = 'sales-invoice-1';
export const QUOTATION_TEMPLATE = 'quotation-1';
export const DELIVERY_CHALLAN_TEMPLATE = 'delivery-challan-1';

export interface SalesPrintParty {
  name: string;
  legalName: string;
  gstin: string | null;
  address: string | null;
  state: string | null;
}

export interface SalesPrintLine {
  name: string;
  sku: string;
  hsnSac: string;
  qty: string;
  uqc: string;
  unitPrice: string;
  discount: string;
  taxable: string;
  taxRate: string | null;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  total: string;
  reverseCharge: boolean;
}

export interface SalesPrint {
  title: string;
  number: string;
  docDate: string;
  /** Rows under the number and date, e.g. ["Valid until", "30-11-2026"]. */
  facts: Array<[string, string]>;
  seller: { legalName: string; tradeName: string; gstin: string; pan: string; address: string; state: string; contact: string };
  logo: { dataUrl: string } | null;
  billTo: SalesPrintParty;
  /** Printed when it differs from the billing address. */
  shipTo: SalesPrintParty | null;
  /** "Maharashtra (27)" */
  placeOfSupply: string;
  supply: 'intra' | 'inter';
  /** "SGST" or "UTGST" for intra-state supplies. */
  stateTaxLabel: string;
  /** Shown for tax documents (Rule 46(p)). */
  reverseCharge: 'Yes' | 'No' | null;
  /** No tax columns (bill of supply). */
  taxColumns: boolean;
  lines: SalesPrintLine[];
  totals: Array<[string, string]>;
  grand: string;
  amountInWords: string;
  hsnSummary: Array<{ hsnSac: string; taxable: string; rate: string; cgst: string; sgst: string; igst: string; cess: string; tax: string }>;
  bank: string | null;
  notes: string;
  terms: string;
  /** Statements printed above the signature (e.g. "This is not a tax invoice"). */
  declarations: string[];
  /** One copy per label (Rule 48 / Rule 55): "Original for recipient"… */
  copies: string[];
  footer: string;
  signatory: string;
}

const grey = '#555555';
const small = 7.5;

function copy(p: SalesPrint, label: string, last: boolean) {
  const cell = (text: string, extra: Record<string, unknown> = {}) => ({ text, fontSize: small, ...extra });
  const right = (text: string) => cell(text, { alignment: 'right' });
  const party = (heading: string, x: SalesPrintParty) => ({
    stack: [
      { text: heading, color: grey },
      { text: x.name, bold: true },
      ...(x.legalName && x.legalName !== x.name ? [{ text: x.legalName }] : []),
      ...(x.address ? [{ text: x.address }] : []),
      ...(x.state ? [{ text: `State: ${x.state}` }] : []),
      { text: x.gstin ? `GSTIN: ${x.gstin}` : 'Unregistered (no GSTIN)' },
    ],
  });

  const taxHeads = !p.taxColumns ? [] : p.supply === 'intra' ? ['CGST', p.stateTaxLabel] : ['IGST'];
  const showCess = p.taxColumns && p.lines.some((l) => l.cess !== '0.00');
  const header = ['#', 'Item', 'HSN/SAC', 'Qty', 'Unit', 'Rate', 'Discount', 'Taxable value', ...(p.taxColumns ? ['GST %'] : []), ...taxHeads, ...(showCess ? ['Cess'] : []), 'Total'];
  const widths = [12, '*', 34, 34, 22, 40, 34, 46, ...(p.taxColumns ? [24] : []), ...taxHeads.map(() => 38), ...(showCess ? [32] : []), 48];
  const body = [
    header.map((h, i) => cell(h, { bold: true, alignment: i >= 3 && h !== 'Unit' ? 'right' : 'left' })),
    ...p.lines.map((l, i) => [
      cell(String(i + 1)),
      cell(`${l.name}\n${l.sku}${l.reverseCharge ? ' · reverse charge' : ''}`),
      cell(l.hsnSac),
      right(l.qty),
      cell(l.uqc),
      right(l.unitPrice),
      right(l.discount),
      right(l.taxable),
      ...(p.taxColumns ? [right(l.taxRate ?? '—')] : []),
      ...(p.taxColumns ? (p.supply === 'intra' ? [right(l.cgst), right(l.sgst)] : [right(l.igst)]) : []),
      ...(showCess ? [right(l.cess)] : []),
      right(l.total),
    ]),
  ];

  const hsnHead = ['HSN/SAC', 'Taxable value', 'GST %', ...(p.supply === 'intra' ? ['CGST', p.stateTaxLabel] : ['IGST']), ...(showCess ? ['Cess'] : []), 'Total tax'];
  const hsnTable = p.taxColumns && p.hsnSummary.length
    ? [
        { text: 'Tax summary by HSN/SAC', bold: true, margin: [0, 10, 0, 4] },
        {
          table: {
            headerRows: 1,
            dontBreakRows: true,
            widths: ['*', 70, 40, ...(p.supply === 'intra' ? [60, 60] : [60]), ...(showCess ? [50] : []), 60],
            body: [
              hsnHead.map((h, i) => cell(h, { bold: true, alignment: i === 0 ? 'left' : 'right' })),
              ...p.hsnSummary.map((r) => [cell(r.hsnSac), right(r.taxable), right(r.rate), ...(p.supply === 'intra' ? [right(r.cgst), right(r.sgst)] : [right(r.igst)]), ...(showCess ? [right(r.cess)] : []), right(r.tax)]),
            ],
          },
          layout: 'lightHorizontalLines',
        },
      ]
    : [];

  return [
    {
      columns: [
        ...(p.logo ? [{ image: p.logo.dataUrl, fit: [90, 48], width: 96 }] : []),
        {
          stack: [
            { text: p.seller.tradeName || p.seller.legalName, fontSize: 13, bold: true },
            ...(p.seller.tradeName && p.seller.tradeName !== p.seller.legalName ? [{ text: p.seller.legalName }] : []),
            { text: p.seller.address },
            { text: `GSTIN: ${p.seller.gstin} · PAN: ${p.seller.pan} · State: ${p.seller.state}` },
            ...(p.seller.contact ? [{ text: p.seller.contact, color: grey }] : []),
          ],
        },
        { stack: [{ text: p.title, fontSize: 15, bold: true, alignment: 'right' }, { text: label, alignment: 'right', color: grey }], width: 170 },
      ],
      columnGap: 12,
    },
    {
      columns: [
        {
          stack: [
            { text: [{ text: 'Number: ', color: grey }, { text: p.number, bold: true }] },
            { text: [{ text: 'Date: ', color: grey }, p.docDate] },
            ...p.facts.map(([k, v]) => ({ text: [{ text: `${k}: `, color: grey }, v] })),
          ],
        },
        {
          stack: [
            { text: [{ text: 'Place of supply: ', color: grey }, p.placeOfSupply] },
            ...(p.reverseCharge ? [{ text: [{ text: 'Tax payable on reverse charge: ', color: grey }, p.reverseCharge] }] : []),
          ],
        },
      ],
      columnGap: 12,
      margin: [0, 10, 0, 8],
    },
    { columns: [party('Bill to', p.billTo), ...(p.shipTo ? [party('Ship to', p.shipTo)] : [{ text: '' }])], columnGap: 12, margin: [0, 0, 0, 10] },
    // The header row repeats on every page (FR-DOC-05).
    { table: { headerRows: 1, dontBreakRows: true, widths, body }, layout: 'lightHorizontalLines' },
    {
      columns: [
        { stack: [{ text: 'Amount in words', color: grey }, { text: p.amountInWords, bold: true }], margin: [0, 8, 0, 0] },
        {
          width: 200,
          margin: [0, 8, 0, 0],
          table: {
            widths: ['*', 80],
            body: [...p.totals.map(([k, v]) => [{ text: k }, { text: v, alignment: 'right' }]), [{ text: 'Total', bold: true }, { text: p.grand, bold: true, alignment: 'right' }]],
          },
          layout: 'noBorders',
        },
      ],
      columnGap: 12,
    },
    ...hsnTable,
    ...(p.bank ? [{ text: [{ text: 'Bank details: ', color: grey }, p.bank], margin: [0, 10, 0, 0] }] : []),
    ...(p.notes ? [{ text: [{ text: 'Notes: ', color: grey }, p.notes], margin: [0, 6, 0, 0] }] : []),
    ...(p.terms ? [{ text: [{ text: 'Terms: ', color: grey }, p.terms], margin: [0, 6, 0, 0] }] : []),
    ...p.declarations.map((d) => ({ text: d, margin: [0, 6, 0, 0], bold: true })),
    { text: `For ${p.seller.legalName}`, alignment: 'right', margin: [0, 24, 0, 28] },
    { text: p.signatory, alignment: 'right', ...(last ? {} : { pageBreak: 'after' }) },
  ];
}

export function salesDocument(p: SalesPrint): DocumentDefinition {
  return {
    header: (page: number, pages: number) => ({ text: `${p.title} ${p.number} · page ${page} of ${pages}`, alignment: 'right', margin: [36, 20, 36, 0], fontSize: 8, color: grey }),
    footer: { text: p.footer, alignment: 'center', margin: [36, 16, 36, 0], fontSize: 7.5, color: grey },
    content: p.copies.flatMap((label, i) => copy(p, label, i === p.copies.length - 1)),
  };
}
