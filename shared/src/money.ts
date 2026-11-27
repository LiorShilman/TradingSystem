import Decimal from 'decimal.js';
import { z } from 'zod';

// One place for all money math. Amounts travel and are stored as decimal strings
// ("1.08453") — never through JS `number`.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -40, toExpPos: 40 });

export { Decimal };

const DEC_RE = /^-?\d+(\.\d+)?$/;

export function isDecString(s: string): boolean {
  return DEC_RE.test(s);
}

export function dec(v: string | Decimal): Decimal {
  if (v instanceof Decimal) return v;
  if (!DEC_RE.test(v)) throw new Error(`Invalid decimal string: "${v}"`);
  return new Decimal(v);
}

/** Canonical string form: no exponent, no trailing zeros, no "-0". */
export function decStr(d: Decimal): string {
  if (d.isZero()) return '0';
  return d.toFixed();
}

export function sumDec(values: Iterable<string>): string {
  let total = new Decimal(0);
  for (const v of values) total = total.plus(dec(v));
  return decStr(total);
}

/**
 * Turn what a person typed ("1,500.25", " +10 ", "3.") into a canonical decimal
 * string, or null if it is not a number.
 */
export function normalizeDecInput(raw: string): string | null {
  const s = raw.replace(/[\s,_]/g, '').replace(/^\+/, '').replace(/\.$/, '');
  if (!DEC_RE.test(s)) return null;
  return decStr(new Decimal(s));
}

/** Display with thousands separators. `decimals` rounds; omit to keep full precision. */
export function formatDec(value: string, decimals?: number): string {
  let d = dec(value);
  if (decimals !== undefined) d = d.toDecimalPlaces(decimals);
  let str = decimals !== undefined ? d.toFixed(decimals) : decStr(d);
  if (/^-0(\.0*)?$/.test(str)) str = str.slice(1);
  const neg = str.startsWith('-');
  const [intPart = '0', frac] = (neg ? str.slice(1) : str).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped + (frac !== undefined ? '.' + frac : '');
}

export const decString = z.string().trim().regex(DEC_RE, 'מספר לא תקין');
