import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FONT_FILES, renderPdf } from './render.js';
import { stockTransferDocument, type StockTransferPrint } from './templates/stock-transfer.js';

/**
 * ADR-006 spike, kept as a regression suite: page breaks with 1, 30 and 200
 * lines, repeating table headers, the ₹ glyph, deterministic output, and no
 * network or file access from document content.
 */
const sample = (n: number): StockTransferPrint => ({
  number: 'TRF-000001',
  docDate: '2026-10-20',
  entity: { legalName: 'Example Traders Private Limited (test)', gstin: '27ZZZCE2001Z1Z5' },
  from: { code: 'MAIN', name: 'Main godown (test)', address: '1 Test Estate, Mumbai 400001' },
  to: { code: 'CITY', name: 'City shop (test)', address: null },
  note: 'Synthetic test data',
  dispatchedAt: new Date('2026-10-20T06:00:00Z'),
  lines: Array.from({ length: n }, (_, i) => ({ sku: `SKU-${i + 1}`, name: `Synthetic item ${i + 1} (₹ test)`, hsnSac: '7318', qty: String(i + 1), unit: 'PCS' })),
});

const meta = { title: 'Stock transfer note', createdAt: new Date('2026-10-20T06:00:00Z') };
const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;

/** Text runs that occur exactly `times` times in an uncompressed PDF. */
function runsOccurring(pdf: Buffer, times: number): number {
  const counts = new Map<string, number>();
  for (const m of pdf.toString('latin1').matchAll(/\[(<[0-9a-f]+>[^\]]*)\] TJ/g)) counts.set(m[1] ?? '', (counts.get(m[1] ?? '') ?? 0) + 1);
  return [...counts.values()].filter((n) => n === times).length;
}

describe('PDF rendering (ADR-006)', () => {
  it('breaks pages: 1 and 30 lines stay short, 200 lines run to several pages', async () => {
    const one = await renderPdf(stockTransferDocument(sample(1)), meta);
    const thirty = await renderPdf(stockTransferDocument(sample(30)), meta);
    const twoHundred = await renderPdf(stockTransferDocument(sample(200)), meta);
    expect(one.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(one)).toBe(1);
    expect(pageCount(thirty)).toBeLessThanOrEqual(2);
    expect(pageCount(twoHundred)).toBeGreaterThanOrEqual(4);
    expect(twoHundred.length).toBeLessThan(200_000);
  });

  it('repeats the table header on every page', async () => {
    const doc = stockTransferDocument(sample(200));
    const withHeader = await renderPdf({ ...doc, compress: false }, meta);
    const pages = pageCount(withHeader);
    const table = (doc.content as Array<{ table?: { headerRows: number } }>).find((c) => c.table);
    if (!table?.table) throw new Error('no table');
    table.table.headerRows = 0;
    const withoutHeader = await renderPdf({ ...doc, compress: false }, meta);
    expect(pageCount(withoutHeader)).toBe(pages);
    // Six header cells (#, Code, Item, HSN/SAC, Quantity, Unit) appear once per page only when the header repeats.
    expect(runsOccurring(withHeader, pages) - runsOccurring(withoutHeader, pages)).toBeGreaterThanOrEqual(6);
  });

  it('embeds Noto Sans, which has the rupee sign', async () => {
    const pdf = await renderPdf(stockTransferDocument(sample(1)), meta);
    expect(pdf.toString('latin1')).toMatch(/\/FontFile2/);
    expect(pdf.toString('latin1')).toMatch(/NotoSans/);
    const fontkit = createRequire(import.meta.url)('fontkit') as { openSync(file: string): { hasGlyphForCodePoint(cp: number): boolean } };
    expect(fontkit.openSync(FONT_FILES.regular).hasGlyphForCodePoint(0x20b9)).toBe(true);
    expect(fontkit.openSync(FONT_FILES.bold).hasGlyphForCodePoint(0x20b9)).toBe(true);
  });

  it('renders the same bytes for the same document', async () => {
    const a = await renderPdf(stockTransferDocument(sample(40)), meta);
    const b = await renderPdf(stockTransferDocument(sample(40)), meta);
    expect(a.equals(b)).toBe(true);
  });

  it('refuses to fetch URLs or read other files named in document content', async () => {
    await expect(renderPdf({ content: [{ image: 'https://example.com/logo.png' }] }, meta)).rejects.toThrow();
    const somewhere = createRequire(import.meta.url).resolve('pdfmake/package.json');
    await expect(renderPdf({ content: [{ image: somewhere }] }, meta)).rejects.toThrow();
  });
});
