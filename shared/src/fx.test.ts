import { describe, expect, it } from 'vitest';
import { effectiveRates, fxcmgrRates, parseBoiRates, parseFrankfurter, parseFxcmgrQuote, parseTvScan, type FxSnapshot } from './fx';

describe('FXCMgr quotes', () => {
  it('cleans float noise from the bridge', () => {
    expect(parseFxcmgrQuote({ pairs: [{ Updated: 0, Rates: [1.0973799999999998] }] })).toBe('1.09738');
    expect(parseFxcmgrQuote({ pairs: [{ Updated: 0, Rates: [3.29861] }] })).toBe('3.29861');
    expect(() => parseFxcmgrQuote({ pairs: [] })).toThrow();
  });
  it('inverts EUR/USD and GBP/USD into units per USD', () => {
    expect(fxcmgrRates({ 'USD/ILS': '3.29861', 'EUR/USD': '1.25', 'GBP/USD': '1.6' })).toEqual({ ILS: '3.29861', EUR: '0.8', GBP: '0.625' });
    expect(() => fxcmgrRates({ 'EUR/USD': '1.1' })).toThrow(/USD\/ILS/);
  });
});

// Trimmed real response shape from boi.org.il (26/11/2026).
const BOI = {
  exchangeRates: [
    { key: 'USD', currentExchangeRate: 3.334, currentChange: -1.36, unit: 1, lastUpdate: '2026-11-26T13:23:04.3435834Z' },
    { key: 'GBP', currentExchangeRate: 4.3695, currentChange: -1.02, unit: 1, lastUpdate: '2026-11-26T13:23:04.3435834Z' },
    { key: 'JPY', currentExchangeRate: 2.0932, currentChange: -1.31, unit: 100, lastUpdate: '2026-11-26T13:23:04.3435834Z' },
    { key: 'EUR', currentExchangeRate: 3.6594, currentChange: -1.04, unit: 1, lastUpdate: '2026-11-26T13:23:04.3435834Z' },
  ],
};

describe('parseBoiRates', () => {
  it('turns ILS-per-unit quotes into units-per-USD', () => {
    const p = parseBoiRates(BOI);
    expect(p.rates.ILS).toBe('3.334');
    expect(p.rates.EUR).toBe('0.9110783189'); // 3.334 / 3.6594 = 0.91107831885…
    expect(p.rates.GBP).toBe('0.7630163634'); // 3.334 / 4.3695
    expect(p.asOf).toBe('2026-11-26T13:23:04.343Z');
    expect(p.asOfHasTime).toBe(true);
  });

  it('divides by unit (JPY is quoted per 100)', () => {
    const p = parseBoiRates({
      exchangeRates: [
        { key: 'USD', currentExchangeRate: 3.334, unit: 1, lastUpdate: '2026-11-26T13:23:04Z' },
        { key: 'EUR', currentExchangeRate: 366, unit: 100, lastUpdate: '2026-11-26T13:23:04Z' },
      ],
    });
    expect(p.rates.EUR).toBe('0.9109289617'); // 3.334 / 3.66
  });

  it('throws on a broken response instead of guessing', () => {
    expect(() => parseBoiRates({})).toThrow();
    expect(() => parseBoiRates({ exchangeRates: [{ key: 'EUR', currentExchangeRate: 3.6, unit: 1 }] })).toThrow(/USD/);
  });
});

describe('parseFrankfurter', () => {
  it('reads USD-based rates and the date', () => {
    const p = parseFrankfurter({ amount: 1, base: 'USD', date: '2026-11-26', rates: { EUR: 0.91116, GBP: 0.76314, ILS: 3.3273 } });
    expect(p.rates).toEqual({ ILS: '3.3273', EUR: '0.91116', GBP: '0.76314' });
    expect(p.asOfHasTime).toBe(false);
  });
  it('rejects a non-USD base', () => {
    expect(() => parseFrankfurter({ base: 'EUR', date: '2026-11-26', rates: { ILS: 4 } })).toThrow();
  });
});

describe('effectiveRates', () => {
  const auto: FxSnapshot = {
    rates: { ILS: '3.334', EUR: '0.91' },
    source: 'boi',
    asOf: '2026-11-26T13:23:04.343Z',
    asOfHasTime: true,
    fetchedAt: '2026-11-27T06:00:00.000Z',
  };
  it('manual overrides auto per currency; USDT stays missing', () => {
    const { rates, origin } = effectiveRates(auto, { USD: '1', EUR: '0.95' });
    expect(rates).toEqual({ USD: '1', ILS: '3.334', EUR: '0.95' });
    expect(origin).toEqual({ ILS: 'auto', EUR: 'manual' });
    expect(rates.USDT).toBeUndefined();
  });
  it('works with no automatic snapshot yet', () => {
    expect(effectiveRates(null, { USD: '1' }).rates).toEqual({ USD: '1' });
  });
});

describe('TradingView scanner quotes', () => {
  it('rounds to the symbol price scale, records the delay, drops other modes', () => {
    const json = {
      data: [
        { s: 'FX:GBPJPY', d: [209.25700000000001, 1000, 'streaming', 'British Pound / Japanese Yen'] },
        { s: 'FX:AUDNZD', d: [1.2169800000000001, 100000, 'streaming'] },
        { s: 'NASDAQ:AAPL', d: [355.58, 100, 'delayed_streaming_900', 'Apple Inc.'] },
        { s: 'TASE:X', d: [10, 100, 'endofday'] },
        { s: 'FX:BAD', d: [null, 100000, 'streaming'] },
      ],
    };
    expect(parseTvScan(json)).toEqual({
      'FX:GBPJPY': { price: '209.257', delayedMin: 0, name: 'British Pound / Japanese Yen' },
      'FX:AUDNZD': { price: '1.21698', delayedMin: 0, name: '' },
      'NASDAQ:AAPL': { price: '355.58', delayedMin: 15, name: 'Apple Inc.' },
    });
    expect(parseTvScan({})).toEqual({});
  });
});