/**
 * Display formatting for decimal strings. Pure string manipulation: values are
 * never converted to binary floating point, so what is shown is exactly what the
 * server computed (docs/architecture/financial-policy.md §5).
 */

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Indian digit grouping: last three digits, then groups of two (12,34,567). */
function groupIndian(integer: string): string {
  if (integer.length <= 3) return integer;
  const last3 = integer.slice(-3);
  const rest = integer.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

function parts(value: string): { negative: boolean; integer: string; fraction: string } {
  const match = DECIMAL.exec(value);
  if (!match) throw new RangeError(`Not a decimal string: ${JSON.stringify(value)}`);
  const integer = (match[2] ?? '0').replace(/^0+(?=\d)/, '');
  const fraction = match[3] ?? '';
  const isZero = /^0*$/.test(integer) && /^0*$/.test(fraction);
  return { negative: match[1] === '-' && !isZero, integer, fraction };
}

/**
 * Formats a money decimal string as INR with 2 decimals, e.g. "1234567.5" → "₹12,34,567.50".
 * Inputs with more than 2 decimals are rejected rather than rounded: rounding is a server concern.
 */
export function formatINR(value: string, options: { symbol?: boolean } = {}): string {
  const { negative, integer, fraction } = parts(value);
  if (fraction.length > 2) throw new RangeError('Money must have at most 2 decimal places');
  const body = `${groupIndian(integer)}.${fraction.padEnd(2, '0')}`;
  const symbol = options.symbol === false ? '' : '₹';
  return `${negative ? '−' : ''}${symbol}${body}`;
}

/**
 * Compact INR for KPI cards: lakh (L) and crore (Cr), truncated (not rounded) to 2 decimals,
 * so a compact figure never overstates the exact value shown in its tooltip.
 */
export function formatINRCompact(value: string): string {
  const { negative, integer } = parts(value);
  const sign = negative ? '−' : '';
  const scale = (digits: number, unit: string) => {
    const whole = integer.slice(0, integer.length - digits);
    const decimals = integer.slice(integer.length - digits, integer.length - digits + 2).replace(/0+$/, '');
    return `${sign}₹${groupIndian(whole)}${decimals ? `.${decimals}` : ''} ${unit}`;
  };
  if (integer.length > 7) return scale(7, 'Cr');
  if (integer.length > 5) return scale(5, 'L');
  return `${sign}₹${groupIndian(integer)}`;
}

/** Formats a quantity decimal string with Indian grouping, keeping its given precision. */
export function formatQuantity(value: string): string {
  const { negative, integer, fraction } = parts(value);
  return `${negative ? '−' : ''}${groupIndian(integer)}${fraction ? `.${fraction}` : ''}`;
}

/** Business date "YYYY-MM-DD" → "DD-MM-YYYY" (display convention, NFR-I18N-01). */
export function formatBusinessDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Not a business date: ${JSON.stringify(value)}`);
  return `${match[3]}-${match[2]}-${match[1]}`;
}
