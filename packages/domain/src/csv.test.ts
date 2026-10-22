import { describe, expect, it } from 'vitest';
import {
  escapeCsvField,
  sanitizeCsvCell,
  serializeToCsv,
  type CsvColumnDef,
} from './csv.js';

describe('CSV Formula Protection and Serialization (Batch A)', () => {
  describe('sanitizeCsvCell - Numeric Columns (Financial Safety)', () => {
    it('preserves valid negative financial decimals without quotes or apostrophes', () => {
      expect(sanitizeCsvCell('-1250.00', 'numeric')).toBe('-1250.00');
      expect(sanitizeCsvCell('-0.01', 'numeric')).toBe('-0.01');
      expect(sanitizeCsvCell(-450.75, 'numeric')).toBe('-450.75');
      expect(sanitizeCsvCell('-999999.99', 'numeric')).toBe('-999999.99');
    });

    it('preserves positive decimals and zero', () => {
      expect(sanitizeCsvCell('1250.00', 'numeric')).toBe('1250.00');
      expect(sanitizeCsvCell('0.00', 'numeric')).toBe('0.00');
      expect(sanitizeCsvCell(0, 'numeric')).toBe('0');
      expect(sanitizeCsvCell(18.5, 'numeric')).toBe('18.5');
    });

    it('falls back to 0.00 if non-numeric user text is passed to a numeric column', () => {
      // Prevents formula injection attempting to bypass via numeric column declaration
      expect(sanitizeCsvCell('=SUM(A1:B1)', 'numeric')).toBe('0.00');
      expect(sanitizeCsvCell('-cmd|/C calc', 'numeric')).toBe('0.00');
      expect(sanitizeCsvCell('NaN', 'numeric')).toBe('0.00');
      expect(sanitizeCsvCell(Number.NaN, 'numeric')).toBe('0.00');
    });

    it('handles null and undefined as empty strings', () => {
      expect(sanitizeCsvCell(null, 'numeric')).toBe('');
      expect(sanitizeCsvCell(undefined, 'numeric')).toBe('');
      expect(sanitizeCsvCell('', 'numeric')).toBe('');
    });
  });

  describe('sanitizeCsvCell - Integer Columns', () => {
    it('preserves valid negative and positive integers', () => {
      expect(sanitizeCsvCell('-5', 'integer')).toBe('-5');
      expect(sanitizeCsvCell('100', 'integer')).toBe('100');
      expect(sanitizeCsvCell(-42, 'integer')).toBe('-42');
    });

    it('falls back to 0 if non-integer or formula is passed to integer column', () => {
      expect(sanitizeCsvCell('=1+1', 'integer')).toBe('0');
      expect(sanitizeCsvCell('12.34', 'integer')).toBe('0');
    });
  });

  describe('sanitizeCsvCell - Text Columns (Untrusted Content Neutralization)', () => {
    it('neutralizes standard formula trigger characters (=, +, -, @)', () => {
      expect(sanitizeCsvCell('=SUM(A1:B1)', 'text')).toBe("'=SUM(A1:B1)");
      expect(sanitizeCsvCell('+123456789', 'text')).toBe("'+123456789");
      expect(sanitizeCsvCell('-10% Discount Promo', 'text')).toBe("'-10% Discount Promo");
      expect(sanitizeCsvCell('@username', 'text')).toBe("'@username");
      expect(sanitizeCsvCell('|calc.exe', 'text')).toBe("'|calc.exe");
      expect(sanitizeCsvCell('%username%', 'text')).toBe("'%username%");
    });

    it('neutralizes formula triggers preceded by leading whitespace or tabs', () => {
      expect(sanitizeCsvCell('   =cmd|', 'text')).toBe("'   =cmd|");
      expect(sanitizeCsvCell('\t=2+5', 'text')).toBe("'\t=2+5");
      expect(sanitizeCsvCell('\r-456', 'text')).toBe("'\r-456");
    });

    it('neutralizes full-width Unicode formula trigger variants', () => {
      expect(sanitizeCsvCell('\uFF1Dcmd', 'text')).toBe("'\uFF1Dcmd"); // ＝
      expect(sanitizeCsvCell('\uFF0Bplus', 'text')).toBe("'\uFF0Bplus"); // ＋
      expect(sanitizeCsvCell('\uFF0Dminus', 'text')).toBe("'\uFF0Dminus"); // －
      expect(sanitizeCsvCell('\uFF20at', 'text')).toBe("'\uFF20at"); // ＠
    });

    it('leaves safe text unchanged', () => {
      expect(sanitizeCsvCell('Acme Corp Pvt Ltd', 'text')).toBe('Acme Corp Pvt Ltd');
      expect(sanitizeCsvCell('Invoice for consultancy services', 'text')).toBe('Invoice for consultancy services');
      expect(sanitizeCsvCell('HSN: 998311', 'text')).toBe('HSN: 998311');
      expect(sanitizeCsvCell('123 Main Street', 'text')).toBe('123 Main Street');
    });

    it('strips null bytes from text', () => {
      expect(sanitizeCsvCell('Safe\0Text', 'text')).toBe('SafeText');
    });
  });

  describe('sanitizeCsvCell - Date and Boolean Columns', () => {
    it('formats dates as YYYY-MM-DD', () => {
      const d = new Date('2026-10-22T00:00:00.000Z');
      expect(sanitizeCsvCell(d, 'date')).toBe('2026-10-22');
      expect(sanitizeCsvCell('2026-10-22', 'date')).toBe('2026-10-22');
    });

    it('formats booleans as TRUE / FALSE', () => {
      expect(sanitizeCsvCell(true, 'boolean')).toBe('TRUE');
      expect(sanitizeCsvCell(false, 'boolean')).toBe('FALSE');
      expect(sanitizeCsvCell('true', 'boolean')).toBe('TRUE');
    });
  });

  describe('escapeCsvField (RFC 4180 Structural Escaping)', () => {
    it('leaves simple safe text unquoted', () => {
      expect(escapeCsvField('Acme')).toBe('Acme');
      expect(escapeCsvField('-1250.00')).toBe('-1250.00');
    });

    it('quotes fields containing commas', () => {
      expect(escapeCsvField('Acme, Inc.')).toBe('"Acme, Inc."');
    });

    it('quotes fields containing double quotes and escapes them as double-double-quotes', () => {
      expect(escapeCsvField('Say "Hello"')).toBe('"Say ""Hello"""');
    });

    it('quotes fields containing newlines', () => {
      expect(escapeCsvField("Line 1\nLine 2")).toBe('"Line 1\nLine 2"');
      expect(escapeCsvField("Line 1\r\nLine 2")).toBe('"Line 1\r\nLine 2"');
    });

    it('quotes fields that start with single quote (neutralized formulas)', () => {
      expect(escapeCsvField("'=SUM(A1:B1)")).toBe('"\'=SUM(A1:B1)"');
      expect(escapeCsvField("'-10% discount")).toBe('"\'--10% discount"'.replace('--', '-'));
    });
  });

  describe('serializeToCsv (Full Spreadsheet Integration)', () => {
    interface SampleRow {
      date: string;
      docNumber: string;
      customer: string;
      amount: string;
      isCredit: boolean;
      remarks: string;
    }

    const columns: CsvColumnDef<SampleRow>[] = [
      { id: 'date', header: 'Date', type: 'date' },
      { id: 'docNumber', header: 'Document #', type: 'text' },
      { id: 'customer', header: 'Customer Name', type: 'text' },
      { id: 'amount', header: 'Net Amount', type: 'numeric' },
      { id: 'isCredit', header: 'Is Credit', type: 'boolean' },
      { id: 'remarks', header: 'Remarks', type: 'text' },
    ];

    it('correctly serializes a mix of financial numbers, neutralized formulas, and escaped text', () => {
      const data: SampleRow[] = [
        {
          date: '2026-10-22',
          docNumber: 'INV-001',
          customer: 'Acme Traders, Mumbai',
          amount: '15000.00',
          isCredit: false,
          remarks: 'Regular order',
        },
        {
          date: '2026-10-22',
          docNumber: 'CN-001',
          customer: '=MaliciousCorp',
          amount: '-2500.50', // Negative financial decimal MUST NOT be neutralized
          isCredit: true,
          remarks: '-Special "Quote" Discount',
        },
      ];

      const csv = serializeToCsv(data, columns, { includeBom: false });
      const lines = csv.split('\r\n');

      expect(lines[0]).toBe('Date,Document #,Customer Name,Net Amount,Is Credit,Remarks');
      // Row 1: Comma in customer name is quoted
      expect(lines[1]).toBe('2026-10-22,INV-001,"Acme Traders, Mumbai",15000.00,FALSE,Regular order');
      // Row 2:
      // - Customer '=MaliciousCorp' neutralized to "'=MaliciousCorp" and quoted
      // - Amount '-2500.50' is strictly preserved as numeric -2500.50 without quotes or apostrophes!
      // - Remarks '-Special "Quote" Discount' neutralized to "'-Special ""Quote"" Discount"
      expect(lines[2]).toBe('2026-10-22,CN-001,"\'=MaliciousCorp",-2500.50,TRUE,"\'--Special ""Quote"" Discount"'.replace('--', '-'));
    });

    it('prepends UTF-8 BOM when requested', () => {
      const csv = serializeToCsv([], columns, { includeBom: true });
      expect(csv.startsWith('\uFEFF')).toBe(true);
    });
  });
});
