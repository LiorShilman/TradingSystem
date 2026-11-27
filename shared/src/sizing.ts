import { convert } from './balance';
import { Decimal, dec, decStr } from './money';
import { symbolTicker, type AssetClass } from './planning';
import { CURRENCIES, type Currency, type Settings } from './schemas';

export interface SizingInput {
  assetClass: AssetClass;
  symbol: string;
  /** Planned entry price (middle of the zone). */
  entry: string;
  stop: string;
  riskPct: string;
  equity: string;
  accountCurrency: Currency;
  rates: Settings['rates'];
}

export interface SizingResult {
  riskAmount: string;
  /** Exact units of the base asset for the chosen risk. */
  units: string;
  /** Forex only. */
  lots?: string;
  amountK?: string;
  pips?: string;
  pipValuePerLot?: string;
  /** Risk after rounding the size down to a tradable amount. */
  roundedRisk: string;
}

export type Sizing = { ok: true; value: SizingResult } | { ok: false; error: string };

const isCurrency = (c: string): c is Currency => (CURRENCIES as readonly string[]).includes(c);

/** Value in account currency of 1 unit of the pair's quote currency. */
function quoteToAccount(base: string, quote: string, entry: Decimal, acct: Currency, rates: Settings['rates']): Decimal | null {
  if (quote === acct) return new Decimal(1);
  if (base === acct) return new Decimal(1).div(entry); // e.g. USDJPY in a USD account
  if (isCurrency(quote)) {
    const v = convert('1', quote, acct, rates);
    if (v !== null) return dec(v);
  }
  return null;
}

/**
 * Position size from risk % and stop distance.
 * Forex: P&L of 1 unit per 1.0 price move is in the quote currency, converted to the account currency.
 * Stocks/crypto/other: price is assumed to be in the account currency.
 */
export function positionSize(i: SizingInput): Sizing {
  const entry = dec(i.entry);
  const dist = entry.minus(dec(i.stop)).abs();
  if (dist.isZero()) return { ok: false, error: 'הסטופ שווה למחיר הכניסה' };
  const riskAmount = dec(i.equity).times(dec(i.riskPct)).div(100);
  if (riskAmount.lte(0)) return { ok: false, error: 'אין הון בחשבון לחישוב' };

  if (i.assetClass === 'forex') {
    const t = symbolTicker(i.symbol);
    if (!/^[A-Z]{6}$/.test(t)) return { ok: false, error: 'סימול מט"ח צריך להיות זוג של 6 אותיות (למשל EURUSD)' };
    const base = t.slice(0, 3);
    const quote = t.slice(3);
    const q = quoteToAccount(base, quote, entry, i.accountCurrency, i.rates);
    if (!q) return { ok: false, error: `חסר שער המרה מ-${quote} ל-${i.accountCurrency}` };
    // base = account currency (USDJPY in USD): risk·entry/dist exactly, avoiding the rounding of 1/entry.
    const units = base === i.accountCurrency ? riskAmount.times(entry).div(dist) : riskAmount.div(dist.times(q));
    const pip = quote === 'JPY' ? new Decimal('0.01') : new Decimal('0.0001');
    const amountK = units.div(1000).floor(); // FXCM trades in 1K steps
    return {
      ok: true,
      value: {
        riskAmount: decStr(riskAmount.toDecimalPlaces(2)),
        units: decStr(units.floor()),
        lots: decStr(units.div(100000).toDecimalPlaces(2, Decimal.ROUND_DOWN)),
        amountK: decStr(amountK),
        pips: decStr(dist.div(pip).toDecimalPlaces(1)),
        pipValuePerLot: decStr(pip.times(100000).times(q).toDecimalPlaces(2)),
        roundedRisk: decStr(
          (base === i.accountCurrency ? amountK.times(1000).times(dist).div(entry) : amountK.times(1000).times(dist).times(q)).toDecimalPlaces(2),
        ),
      },
    };
  }

  const raw = riskAmount.div(dist);
  const units = i.assetClass === 'stock' ? raw.floor() : raw.toDecimalPlaces(6, Decimal.ROUND_DOWN);
  return {
    ok: true,
    value: {
      riskAmount: decStr(riskAmount.toDecimalPlaces(2)),
      units: decStr(units),
      roundedRisk: decStr(units.times(dist).toDecimalPlaces(2)),
    },
  };
}
