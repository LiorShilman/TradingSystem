import { z } from 'zod';
import { fxcmgrConfigSchema } from './broker';
import { dec, decString, isDecString } from './money';
import { utcIsoString } from './time';

export const CURRENCIES = ['USD', 'ILS', 'EUR', 'GBP', 'USDT'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const DISPLAY_CURRENCIES = ['ILS', 'USD'] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

export const ACCOUNT_KINDS = ['stocks', 'forex', 'crypto', 'demo'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const CASHFLOW_TYPES = ['deposit', 'withdrawal', 'fee', 'interest', 'adjustment'] as const;
export type CashflowType = (typeof CASHFLOW_TYPES)[number];

interface Stamped {
  id: string;
  createdAt: string;
  updatedAt: string;
}

// ---------- accounts ----------
// Base without defaults, so .partial() for PATCH never fills in defaults.
const accountFields = z.object({
  name: z.string().trim().min(1, 'חובה לתת שם לחשבון').max(80, 'שם ארוך מדי'),
  kind: z.enum(ACCOUNT_KINDS, 'סוג חשבון לא תקין'),
  broker: z.string().trim().max(80),
  baseCurrency: z.enum(CURRENCIES, 'מטבע לא תקין'),
  notes: z.string().max(5000),
  isArchived: z.boolean(),
  /** Optional read-only broker link; null = not connected. */
  integration: fxcmgrConfigSchema.nullable(),
});

export const accountCreateSchema = accountFields.extend({
  broker: accountFields.shape.broker.default(''),
  notes: accountFields.shape.notes.default(''),
  isArchived: accountFields.shape.isArchived.default(false),
  integration: accountFields.shape.integration.default(null),
});
// Base currency is fixed after creation (balances and movements are in it).
export const accountPatchSchema = accountFields.omit({ baseCurrency: true }).partial();

export type AccountCreate = z.input<typeof accountCreateSchema>;
export type AccountPatch = z.infer<typeof accountPatchSchema>;
export interface Account extends z.output<typeof accountCreateSchema>, Stamped {
  /** ⓢ derived: sum of cashflows (+ realized P&L from stage 1b). */
  balance: string;
}

// ---------- cashflows ----------
const cashflowFields = z.object({
  accountId: z.string().min(1, 'חסר חשבון'),
  type: z.enum(CASHFLOW_TYPES, 'סוג תנועה לא תקין'),
  amount: decString,
  occurredAt: utcIsoString,
  note: z.string().max(1000),
});

/** Hebrew error for an invalid type/amount pair, or null when fine. */
export function cashflowAmountError(type: CashflowType, amount: string): string | null {
  const a = dec(amount);
  if (a.isZero()) return 'הסכום לא יכול להיות אפס';
  if (type !== 'adjustment' && a.isNegative()) return 'הסכום חייב להיות חיובי. לתיקון שלילי בחר "התאמה"';
  return null;
}

export const cashflowCreateSchema = cashflowFields
  .extend({ note: cashflowFields.shape.note.default('') })
  .superRefine((v, ctx) => {
    // zod 4 runs refinements even when a field already failed — only check a valid number.
    if (typeof v.amount !== 'string' || !isDecString(v.amount)) return;
    const err = cashflowAmountError(v.type, v.amount);
    if (err) ctx.addIssue({ code: 'custom', path: ['amount'], message: err });
  });
// The account of a movement cannot change; the server re-checks type+amount on the merged document.
export const cashflowPatchSchema = cashflowFields.omit({ accountId: true }).partial();

export type CashflowCreate = z.input<typeof cashflowCreateSchema>;
export type CashflowPatch = z.infer<typeof cashflowPatchSchema>;
export interface Cashflow extends z.output<typeof cashflowCreateSchema>, Stamped {
  /** Copied from the account at creation. */
  currency: Currency;
}

// ---------- settings ----------
// rates: MANUAL overrides — units of the currency per 1 USD (ILS: "3.334"). Automatic rates live in
// the fx snapshot (see fx.ts); a manual entry wins for its currency. A missing rate stays missing.
export const settingsSchema = z.object({
  displayCurrency: z.enum(DISPLAY_CURRENCIES),
  rates: z.partialRecord(z.enum(CURRENCIES), decString),
});
export type Settings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS: Settings = { displayCurrency: 'ILS', rates: { USD: '1' } };

// ---------- labels ----------
export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  stocks: 'ברוקר מניות',
  forex: 'ברוקר מט"ח',
  crypto: 'בורסת קריפטו',
  demo: 'חשבון דמו',
};
export const CASHFLOW_TYPE_LABELS: Record<CashflowType, string> = {
  deposit: 'הפקדה',
  withdrawal: 'משיכה',
  fee: 'עמלה',
  interest: 'ריבית',
  adjustment: 'התאמה',
};
export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  USD: '$',
  ILS: '₪',
  EUR: '€',
  GBP: '£',
  USDT: 'USDT',
};
