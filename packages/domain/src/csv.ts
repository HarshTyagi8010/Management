/**
 * Typed, spreadsheet-aware CSV serialization and cell protection (Batch A, FINDING-P1-04).
 *
 * Architecture and Security Constraints:
 * 1. Cell interpretation protection:
 *    - Explicitly distinguishes between validated numeric/decimal columns and untrusted text columns.
 *    - Valid negative financial numbers (e.g. -1250.00) in approved numeric columns are strictly
 *      preserved as raw numeric values so spreadsheet formulas (SUM, AVERAGE) work correctly.
 *    - Untrusted user text starting with formula triggers (=, +, -, @, \t, \r, and full-width Unicode
 *      variants \uFF1D, \uFF0B, \uFF0D, \uFF20, |, %) is neutralized with a leading single quote (').
 *    - Leading whitespace and control characters preceding formula triggers are handled.
 * 2. Structural CSV escaping (RFC 4180):
 *    - Separated cleanly from cell interpretation protection.
 *    - Values containing delimiters, quotes, newlines, or leading neutralization quotes are wrapped in
 *      double quotes with embedded quotes escaped as `""`.
 * 3. Spreadsheet compatibility, verification, and limitations:
 *    - Target applications: Microsoft Excel (Desktop/Web), LibreOffice Calc, Google Sheets, Apple Numbers.
 *    - Actually tested environments: Automated unit test suite verifying RFC 4180 structural framing,
 *      single-quote neutralization of formula triggers, delimiter collision, and negative numeric preservation.
 *    - No universal safety or import guarantee: CSV is an untyped text format governed by application-specific
 *      heuristics and client-side operating system locale settings (e.g. semicolon list separators vs decimal commas).
 *      No text-based CSV serializer can offer universal formula injection immunity across all past, current,
 *      and future spreadsheet programs.
 *    - Save/reopen limitations: If a user opens the sanitized CSV in spreadsheet software, modifies it, and saves it
 *      back to disk, the spreadsheet program may strip leading apostrophe markers, alter unquoted negative decimals,
 *      or re-evaluate cells upon subsequent opening. For immutable, tamper-resistant record distribution, PDF or
 *      signed electronic exports must be used instead.
 */

export type CsvColumnType = 'numeric' | 'integer' | 'text' | 'date' | 'boolean';

export interface CsvColumnDef<T = any> {
  id: string;
  header: string;
  type: CsvColumnType;
  accessor?: (row: T) => unknown;
}

export interface CsvSerializeOptions {
  delimiter?: string;
  rowDelimiter?: string;
  includeBom?: boolean;
}

/** Matches valid numeric representations including negative financial decimals: e.g. "123", "-123.45", "0.00" */
const NUMERIC_PATTERN = /^-?\d+(\.\d+)?$/;
const INTEGER_PATTERN = /^-?\d+$/;

/**
 * Formula execution triggers across Excel, Calc, Sheets:
 * Standard ASCII: =, +, -, @, tab (\t), carriage return (\r), pipe (|), percent (%)
 * Full-width Unicode variants: \uFF1D (＝), \uFF0B (＋), \uFF0D (－), \uFF20 (＠)
 */
const FORMULA_TRIGGERS = [
  '=',
  '+',
  '-',
  '@',
  '\t',
  '\r',
  '|',
  '%',
  '\uFF1D',
  '\uFF0B',
  '\uFF0D',
  '\uFF20',
];

/**
 * Neutralizes potentially executable formula content in a single cell based on its column type.
 *
 * @param value The raw value to format
 * @param type The declared column type
 * @returns Sanitized string representation ready for structural CSV escaping
 */
export function sanitizeCsvCell(value: unknown, type: CsvColumnType = 'text'): string {
  if (value === null || value === undefined) {
    return '';
  }

  // Boolean handling
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    const s = String(value).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' ? 'TRUE' : 'FALSE';
  }

  // Numeric and Decimal handling
  if (type === 'numeric') {
    if (typeof value === 'number') {
      if (Number.isNaN(value) || !Number.isFinite(value)) return '0.00';
      return value.toString();
    }
    const str = String(value).trim();
    if (str === '') return '';
    // Must be a strictly valid numeric string to preserve without neutralization
    if (NUMERIC_PATTERN.test(str)) {
      return str;
    }
    // If an invalid text was passed to a numeric column, fallback to 0.00 or sanitize to prevent injection
    return '0.00';
  }

  // Integer handling
  if (type === 'integer') {
    if (typeof value === 'number') {
      if (Number.isNaN(value) || !Number.isFinite(value)) return '0';
      return Math.trunc(value).toString();
    }
    const str = String(value).trim();
    if (str === '') return '';
    if (INTEGER_PATTERN.test(str)) {
      return str;
    }
    return '0';
  }

  // Date handling
  if (type === 'date') {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) return '';
      return value.toISOString().slice(0, 10);
    }
    const str = String(value).trim();
    // Validate standard YYYY-MM-DD or ISO prefix
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
      return str.slice(0, 10);
    }
    // Untrusted non-standard date text falls through to text sanitization
  }

  // Text handling: UNTRUSTED USER CONTENT
  // Strip null bytes
  let text = String(value).replace(/\0/g, '');

  // Check if trimmed text starts with any formula trigger
  const trimmed = text.trimStart();
  if (trimmed.length > 0) {
    const firstChar = trimmed[0];
    if (firstChar && FORMULA_TRIGGERS.includes(firstChar)) {
      // Neutralize formula injection with leading apostrophe
      return `'${text}`;
    }
  }

  return text;
}

/**
 * Applies standard RFC 4180 structural CSV escaping.
 *
 * Rules:
 * - Wraps in double quotes if the field contains delimiter, quote, newline, carriage return,
 *   or starts with a single quote (neutralized formula).
 * - Internal quotes are escaped as `""`.
 */
export function escapeCsvField(field: string, delimiter = ','): string {
  if (field === '') return '';

  const mustQuote =
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes('\n') ||
    field.includes('\r') ||
    field.startsWith("'");

  if (!mustQuote) {
    return field;
  }

  return `"${field.replace(/"/g, '""')}"`;
}

/**
 * Serializes an array of records to RFC 4180 CSV with formula-injection neutralization.
 *
 * @param rows Data rows to export
 * @param columns Column definitions with explicit types
 * @param options CSV serialization options
 */
export function serializeToCsv<T = Record<string, unknown>>(
  rows: T[],
  columns: CsvColumnDef<T>[],
  options: CsvSerializeOptions = {},
): string {
  const delimiter = options.delimiter ?? ',';
  const rowDelimiter = options.rowDelimiter ?? '\r\n';
  const includeBom = options.includeBom ?? true;

  // Header row
  const headerRow = columns
    .map((col) => escapeCsvField(col.header, delimiter))
    .join(delimiter);

  // Data rows
  const dataRows = rows.map((row) =>
    columns
      .map((col) => {
        const rawValue = col.accessor ? col.accessor(row) : (row as any)[col.id];
        const sanitized = sanitizeCsvCell(rawValue, col.type);
        return escapeCsvField(sanitized, delimiter);
      })
      .join(delimiter),
  );

  const csvBody = [headerRow, ...dataRows].join(rowDelimiter);
  return includeBom ? `\uFEFF${csvBody}` : csvBody;
}
