import { Decimal, dec, decStr } from './money';
import type { CashflowType, Currency, Settings } from './schemas';

const SIGN: Record<CashflowType, 1 | -1> = {
  deposit: 1,
  interest: 1,
  adjustment: 1, // signed by its own amount
  withdrawal: -1,
  fee: -1,
};

export function signedCashflow(type: CashflowType, amount: string): Decimal {
  return dec(amount).times(SIGN[type]);
}

export function computeBalance(cashflows: Iterable<{ type: CashflowType; amount: string }>): string {
  let total = new Decimal(0);
  for (const c of cashflows) total = total.plus(signedCashflow(c.type, c.amount));
  return decStr(total);
}

/** Convert via USD using settings.rates (units per 1 USD). Null when a rate is missing. */
export function convert(amount: string, from: Currency, to: Currency, rates: Settings['rates']): string | null {
  if (from === to) return decStr(dec(amount));
  const rFrom = from === 'USD' ? '1' : rates[from];
  const rTo = to === 'USD' ? '1' : rates[to];
  if (!rFrom || !rTo || dec(rFrom).isZero()) return null;
  return decStr(dec(amount).div(dec(rFrom)).times(dec(rTo)));
}

/**
 * Sum of real account balances in `to` — archived and demo accounts are not money you own, so they're excluded.
 * Null total (and the missing currencies) when a rate is missing.
 */
export function portfolioTotal(
  accounts: Iterable<{ balance: string; baseCurrency: Currency; isArchived?: boolean; kind?: string }>,
  to: Currency,
  rates: Settings['rates'],
): { total: string | null; missing: Currency[] } {
  let total = new Decimal(0);
  const missing = new Set<Currency>();
  for (const a of accounts) {
    if (a.isArchived || a.kind === 'demo') continue;
    const v = convert(a.balance, a.baseCurrency, to, rates);
    if (v === null) {
      if (a.baseCurrency !== 'USD' && !rates[a.baseCurrency]) missing.add(a.baseCurrency);
      if (to !== 'USD' && !rates[to]) missing.add(to);
    } else total = total.plus(dec(v));
  }
  return { total: missing.size ? null : decStr(total), missing: [...missing] };
}
