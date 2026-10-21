import type { DocumentDefinition } from 'pdfmake';

export const PURCHASE_ORDER_TEMPLATE = 'purchase-order-1';

export interface PurchaseOrderParty {
  name: string;
  legalName?: string | null;
  gstin: string | null;
  address: string | null;
  state: string | null;
}

export interface PurchaseOrderPrintLine {
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
}

export interface PurchaseOrderPrint {
  title: string;
  number: string;
  docDate: string;
  expectedDate: string | null;
  buyer: { legalName: string; tradeName?: string; gstin: string; pan: string; address: string; state: string };
  supplier: PurchaseOrderParty;
  shipToWarehouse: { name: string; code?: string; address: string | null };
  logo: { dataUrl: string } | null;
  supply: 'intra' | 'inter';
  stateTaxLabel: string;
  lines: PurchaseOrderPrintLine[];
  totals: Array<[string, string]>;
  grand: string;
  amountInWords: string;
  hsnSummary: Array<{ hsnSac: string; taxable: string; rate: string; cgst: string; sgst: string; igst: string; cess: string; tax: string }>;
  notes: string;
  terms: string;
  signatory: string;
}

const grey = '#555555';
const small = 7.5;

export function purchaseOrderDocument(p: PurchaseOrderPrint): DocumentDefinition {
  const cell = (text: string, extra: Record<string, unknown> = {}) => ({ text, fontSize: small, ...extra });
  const right = (text: string) => cell(text, { alignment: 'right' });
  const party = (heading: string, x: PurchaseOrderParty) => ({
    stack: [
      { text: heading, color: grey },
      { text: x.name, bold: true },
      ...(x.legalName && x.legalName !== x.name ? [{ text: x.legalName }] : []),
      ...(x.address ? [{ text: x.address }] : []),
      ...(x.state ? [{ text: `State: ${x.state}` }] : []),
      { text: x.gstin ? `GSTIN: ${x.gstin}` : 'Unregistered (no GSTIN)' },
    ],
  });

  const taxHeads = p.supply === 'intra' ? ['CGST', p.stateTaxLabel] : ['IGST'];
  const showCess = p.lines.some((l) => l.cess !== '0.00');
  const header = ['#', 'Item', 'HSN/SAC', 'Qty', 'Unit', 'Rate', 'Discount', 'Taxable value', 'GST %', ...taxHeads, ...(showCess ? ['Cess'] : []), 'Total'];
  const widths = [12, '*', 34, 34, 22, 40, 34, 46, 24, ...taxHeads.map(() => 38), ...(showCess ? [32] : []), 48];
  const body = [
    header.map((h, i) => cell(h, { bold: true, alignment: i >= 3 && h !== 'Unit' ? 'right' : 'left' })),
    ...p.lines.map((l, i) => [
      cell(String(i + 1)),
      cell(`${l.name}\n${l.sku}`),
      cell(l.hsnSac),
      right(l.qty),
      cell(l.uqc),
      right(l.unitPrice),
      right(l.discount),
      right(l.taxable),
      right(l.taxRate ?? '—'),
      ...(p.supply === 'intra' ? [right(l.cgst), right(l.sgst)] : [right(l.igst)]),
      ...(showCess ? [right(l.cess)] : []),
      right(l.total),
    ]),
  ];

  const hsnHead = ['HSN/SAC', 'Taxable value', 'GST %', ...(p.supply === 'intra' ? ['CGST', p.stateTaxLabel] : ['IGST']), ...(showCess ? ['Cess'] : []), 'Total tax'];
  const hsnTable = p.hsnSummary.length
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

  const content = [
    {
      columns: [
        ...(p.logo ? [{ image: p.logo.dataUrl, fit: [90, 48], width: 96 }] : []),
        {
          stack: [
            { text: p.buyer.tradeName || p.buyer.legalName, fontSize: 13, bold: true },
            ...(p.buyer.tradeName && p.buyer.tradeName !== p.buyer.legalName ? [{ text: p.buyer.legalName }] : []),
            { text: p.buyer.address },
            { text: `GSTIN: ${p.buyer.gstin} · PAN: ${p.buyer.pan} · State: ${p.buyer.state}` },
          ],
        },
        { stack: [{ text: p.title, fontSize: 15, bold: true, alignment: 'right' }], width: 170 },
      ],
      columnGap: 12,
    },
    {
      columns: [
        {
          stack: [
            { text: [{ text: 'PO Number: ', color: grey }, { text: p.number, bold: true }] },
            { text: [{ text: 'Date: ', color: grey }, p.docDate] },
            ...(p.expectedDate ? [{ text: [{ text: 'Expected Delivery: ', color: grey }, p.expectedDate] }] : []),
          ],
        },
        {
          stack: [
            { text: [{ text: 'Ship To Warehouse: ', color: grey }, { text: p.shipToWarehouse.name, bold: true }] },
            ...(p.shipToWarehouse.address ? [{ text: p.shipToWarehouse.address }] : []),
          ],
        },
      ],
      columnGap: 12,
      margin: [0, 10, 0, 8],
    },
    {
      columns: [
        party('Supplier', p.supplier),
      ],
      columnGap: 12,
      margin: [0, 0, 0, 10],
    },
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
    ...(p.notes ? [{ text: [{ text: 'Notes: ', color: grey }, p.notes], margin: [0, 6, 0, 0] }] : []),
    ...(p.terms ? [{ text: [{ text: 'Terms: ', color: grey }, p.terms], margin: [0, 6, 0, 0] }] : []),
    { text: `For ${p.buyer.legalName}`, alignment: 'right', margin: [0, 24, 0, 28] },
    { text: p.signatory, alignment: 'right' },
  ];

  return {
    header: (page: number, pages: number) => ({ text: `${p.title} ${p.number} · page ${page} of ${pages}`, alignment: 'right', margin: [36, 20, 36, 0], fontSize: 8, color: grey }),
    footer: { text: 'Computer generated document', alignment: 'center', margin: [36, 16, 36, 0], fontSize: 7.5, color: grey },
    content,
  };
}
