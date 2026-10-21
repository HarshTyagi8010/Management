import type { DocumentDefinition } from 'pdfmake';

export const STOCK_TRANSFER_TEMPLATE = 'stock-transfer-1';

export interface StockTransferPrint {
  number: string;
  docDate: string;
  entity: { legalName: string; gstin: string | null };
  from: { code: string; name: string; address: string | null };
  to: { code: string; name: string; address: string | null };
  note: string;
  dispatchedAt: Date;
  lines: Array<{ sku: string; name: string; hsnSac: string; qty: string; unit: string }>;
}

const ddmmyyyy = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;

/**
 * Stock transfer note between warehouses of one GST registration. Quantities
 * only: it is a movement record for the people carrying and receiving goods,
 * not a tax document, and it says so. A transfer between different GSTINs is a
 * supply and is refused before it gets here.
 */
export function stockTransferDocument(t: StockTransferPrint): DocumentDefinition {
  const place = (w: StockTransferPrint['from']) => [{ text: `${w.code} · ${w.name}`, bold: true }, ...(w.address ? [{ text: w.address, color: '#444444' }] : [])];
  return {
    header: (page: number, pages: number) => ({ text: `${t.number} · page ${page} of ${pages}`, alignment: 'right', margin: [36, 20, 36, 0], fontSize: 8, color: '#555555' }),
    footer: { text: 'Stock transfer note. This is not a tax invoice, delivery challan or e-way bill.', alignment: 'center', margin: [36, 16, 36, 0], fontSize: 8, color: '#555555' },
    content: [
      { text: 'Stock transfer note', fontSize: 16, bold: true },
      { text: [t.entity.legalName, t.entity.gstin ? ` · GSTIN ${t.entity.gstin}` : ''].join(''), margin: [0, 2, 0, 10] },
      {
        columns: [
          { stack: [{ text: 'Number', color: '#555555' }, { text: t.number, bold: true }, { text: 'Date', color: '#555555', margin: [0, 4, 0, 0] }, ddmmyyyy(t.docDate)] },
          { stack: [{ text: 'From', color: '#555555' }, ...place(t.from)] },
          { stack: [{ text: 'To', color: '#555555' }, ...place(t.to)] },
        ],
        columnGap: 16,
        margin: [0, 0, 0, 12],
      },
      {
        table: {
          // The header row repeats on every page.
          headerRows: 1,
          dontBreakRows: true,
          widths: [20, 70, '*', 50, 60, 36],
          body: [
            ['#', 'Code', 'Item', 'HSN/SAC', { text: 'Quantity', alignment: 'right' }, 'Unit'].map((h) => (typeof h === 'string' ? { text: h, bold: true } : { ...h, bold: true })),
            ...t.lines.map((l, i) => [String(i + 1), l.sku, l.name, l.hsnSac, { text: l.qty, alignment: 'right' }, l.unit]),
          ],
        },
        layout: 'lightHorizontalLines',
      },
      ...(t.note ? [{ text: `Note: ${t.note}`, margin: [0, 10, 0, 0] }] : []),
      {
        columns: [
          { text: 'Dispatched by (sign)', margin: [0, 36, 0, 0] },
          { text: 'Received by (sign and date)', margin: [0, 36, 0, 0] },
        ],
      },
    ],
  };
}
