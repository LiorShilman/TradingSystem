import { convert } from './balance';
import { Decimal, dec, decStr } from './money';
import { symbolTicker, type AssetClass } from './planning';
import { CURRENCIES, type Currency, type Settings } from './schemas';

/**
 * Broker spec of a CFD (from FXCM): what a 1.0 price move is worth per unit, and the tradable step.
 * EUR/USD-style currency pairs don't use it (their value depends on the quote currency, computed from rates).
 */
export interface InstrumentSpec {
  symbol: string;
  /** FXCM name, e.g. "SPX500F". */
  offer: string;
  /** Value of a 1.0 price move for 1 unit, in `currency` (= pipCost / (pointSize × baseUnitSize)). */
  pointValue: string;
  currency: Currency;
  pointSize: string;
  pipCost: string;
  /** Smallest tradable quantity and step, in units. */
  minQuantity: string;
  step: string;
  fetchedAt: string;
}

/** FXCM offer row → spec. Null when the numbers don't make sense (never guess a contract value). */
export function specFromFxcm(symbol: string, o: { instrument?: unknown; pointSize?: unknown; pipCost?: unknown; baseUnitSize?: unknown; minQuantity?: unknown }, currency: Currency, fetchedAt: string): InstrumentSpec | null {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Decimal(v) : null);
  const point = n(o.pointSize);
  const pip = n(o.pipCost);
  const base = n(o.baseUnitSize);
  if (!point || !pip || !base || typeof o.instrument !== 'string') return null;
  const min = n(o.minQuantity) ?? base;
  return {
    symbol,
    offer: o.instrument,
    pointValue: decStr(pip.div(point.times(base)).toSignificantDigits(12)),
    currency,
    pointSize: decStr(point),
    pipCost: decStr(pip),
    minQuantity: decStr(min),
    step: decStr(base),
    fetchedAt,
  };
}

export interface SizingInput {
  assetClass: AssetClass;
  symbol: string;
  /** CFD spec from the broker; when given it decides the size (contracts/units), whatever the asset class. */
  spec?: InstrumentSpec | null;
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
  /** CFD only: what a 1.0 move is worth per unit, in the account currency. */
  pointValue?: string;
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

  // CFD with a broker spec: units = risk / (stop distance × value of a 1.0 move per unit), rounded down to the step.
  if (i.spec) {
    const pv = i.spec.currency === i.accountCurrency ? dec(i.spec.pointValue) : (() => {
      const v = convert(i.spec.pointValue, i.spec.currency, i.accountCurrency, i.rates);
      return v === null ? null : dec(v);
    })();
    if (!pv || pv.lte(0)) return { ok: false, error: `חסר שער המרה מ-${i.spec.currency} ל-${i.accountCurrency}` };
    const step = dec(i.spec.step);
    const raw = riskAmount.div(dist.times(pv));
    const units = raw.div(step).floor().times(step);
    if (units.lt(dec(i.spec.minQuantity))) {
      return { ok: false, error: `הסיכון קטן מהכמות המינימלית (${i.spec.minQuantity}) — סיכון מינימלי ${decStr(dec(i.spec.minQuantity).times(dist).times(pv).toDecimalPlaces(2))}` };
    }
    return {
      ok: true,
      value: {
        riskAmount: decStr(riskAmount.toDecimalPlaces(2)),
        units: decStr(units),
        roundedRisk: decStr(units.times(dist).times(pv).toDecimalPlaces(2)),
        pointValue: decStr(pv.toSignificantDigits(8)),
      },
    };
  }

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
