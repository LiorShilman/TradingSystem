import { describe, expect, it } from 'vitest';
import { fxPair, normalizeSymbol, planCreateSchema, planIssues, planMetrics } from './planning';
import { positionSize } from './sizing';

describe('symbols', () => {
  it('normalizes to TradingView format', () => {
    expect(normalizeSymbol('eurusd')).toBe('FX:EURUSD');
    expect(normalizeSymbol('EUR/USD')).toBe('FX:EURUSD');
    expect(normalizeSymbol('fxcm:gbpjpy')).toBe('FX:GBPJPY');
    expect(normalizeSymbol(' nasdaq:aapl ')).toBe('NASDAQ:AAPL');
    expect(normalizeSymbol('BINANCE:BTCUSDT')).toBe('BINANCE:BTCUSDT');
    expect(normalizeSymbol('apple')).toBeNull();
    expect(normalizeSymbol('')).toBeNull();
  });
  it('maps to FXCM pair names', () => {
    expect(fxPair('FX:EURUSD')).toBe('EUR/USD');
    expect(fxPair('OANDA:EURUSD')).toBe('EUR/USD');
    expect(fxPair('NASDAQ:AAPL')).toBeNull();
  });
});

const long = {
  direction: 'long' as const,
  entryLow: '1.0800',
  entryHigh: '1.0810',
  stopLoss: '1.0780',
  targets: [
    { price: '1.0865', sizePct: '50' },
    { price: '1.0905', sizePct: '50' },
  ],
  riskPct: '1',
};

describe('plan validation', () => {
  it('a complete long plan has no issues', () => {
    expect(planIssues(long)).toEqual([]);
  });
  it('flags missing levels', () => {
    const p = planCreateSchema.parse({ symbol: 'EURUSD' });
    expect(planIssues(p)).toEqual(expect.arrayContaining(['חסר אזור כניסה', 'חסר סטופ לוס', 'חסר לפחות יעד אחד']));
  });
  it('flags a stop on the wrong side and targets inside the zone', () => {
    expect(planIssues({ ...long, stopLoss: '1.0820' })).toContain('בקנייה הסטופ חייב להיות מתחת לאזור הכניסה');
    expect(planIssues({ ...long, targets: [{ price: '1.0805', sizePct: '100' }] })).toContain('יעד 1 חייב להיות מעל אזור הכניסה');
    expect(planIssues({ ...long, direction: 'short' })).toContain('במכירה הסטופ חייב להיות מעל אזור הכניסה');
    expect(planIssues({ ...long, targets: [{ price: '1.09', sizePct: '70' }, { price: '1.1', sizePct: '40' }] })).toContain('סך האחוזים ביעדים מעל 100%');
    expect(planIssues({ ...long, riskPct: '15' })).toContain('אחוז סיכון חייב להיות בין 0 ל-10');
  });
  it('R multiples from the middle of the zone', () => {
    const m = planMetrics(long)!;
    expect(m.entry).toBe('1.0805');
    expect(m.riskPerUnit).toBe('0.0025');
    expect(m.targets.map((t) => t.r)).toEqual(['2.4', '4']);
    expect(m.avgR).toBe('3.2');
    expect(planMetrics({ ...long, stopLoss: null })).toBeNull();
  });
});

describe('position size', () => {
  const base = { assetClass: 'forex' as const, riskPct: '1', equity: '10000', accountCurrency: 'USD' as const, rates: { USD: '1', GBP: '0.8' } };

  it('EURUSD, 1% of $10,000, 20-pip stop → 0.5 lot / 50K, $10 per pip per lot', () => {
    const r = positionSize({ ...base, symbol: 'OANDA:EURUSD', entry: '1.0800', stop: '1.0780' });
    expect(r).toEqual({
      ok: true,
      value: { riskAmount: '100', units: '50000', lots: '0.5', amountK: '50', pips: '20', pipValuePerLot: '10', roundedRisk: '100' },
    });
  });

  it('USDJPY in a USD account converts through the entry price', () => {
    const r = positionSize({ ...base, symbol: 'OANDA:USDJPY', entry: '150', stop: '149.5' });
    expect(r.ok && r.value).toMatchObject({ units: '30000', amountK: '30', pips: '50' });
  });

  it('EURGBP in a USD account uses the GBP rate, and refuses without one', () => {
    const r = positionSize({ ...base, symbol: 'OANDA:EURGBP', entry: '0.8500', stop: '0.8490' });
    expect(r.ok && r.value).toMatchObject({ units: '80000', amountK: '80' });
    const missing = positionSize({ ...base, rates: { USD: '1' }, symbol: 'OANDA:EURGBP', entry: '0.85', stop: '0.849' });
    expect(missing).toEqual({ ok: false, error: 'חסר שער המרה מ-GBP ל-USD' });
  });

  it('rounds FXCM size down to 1K and reports the real risk', () => {
    const r = positionSize({ ...base, symbol: 'OANDA:EURUSD', entry: '1.0800', stop: '1.0773' }); // 27 pips
    expect(r.ok && r.value).toMatchObject({ units: '37037', amountK: '37', roundedRisk: '99.9' });
  });

  it('stocks: whole shares', () => {
    const r = positionSize({ ...base, assetClass: 'stock', symbol: 'NASDAQ:AAPL', entry: '200', stop: '194' });
    expect(r.ok && r.value).toMatchObject({ units: '16', roundedRisk: '96' });
  });

  it('stop equal to entry is an error, not a division by zero', () => {
    expect(positionSize({ ...base, symbol: 'OANDA:EURUSD', entry: '1.08', stop: '1.08' }).ok).toBe(false);
  });
});
