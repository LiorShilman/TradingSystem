import { describe, expect, it } from 'vitest';
import { candleFacts, candleTable, type Candle } from './advisor';

const mk = (i: number, o: number, h: number, l: number, c: number): Candle => ({ t: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`, o, h, l, c, v: 100 });

describe('candle facts', () => {
  it('ATR, extremes, change and averages from real-looking candles', () => {
    // 25 candles, each range 10 (h = c+5, l = c-5), close rising by 1.
    const cs = Array.from({ length: 25 }, (_, i) => mk(i, 100 + i, 105 + i, 95 + i, 100 + i));
    const f = candleFacts(cs)!;
    expect(f.lastClose).toBe(124);
    expect(f.atr14).toBe(10); // TR = max(10, |h-prevC| = 6, |l-prevC| = 4)
    expect(f.highAll).toEqual({ price: 129, t: cs[24]!.t });
    expect(f.lowAll).toEqual({ price: 95, t: cs[0]!.t });
    expect(f.low20).toEqual({ price: 100, t: cs[5]!.t });
    expect(f.change20Pct).toBe(19.23); // 124 vs the close 20 candles earlier (104)
    expect(f.sma20).toBe(114.5);
    expect(f.sma50).toBeNull();
  });

  it('few candles: no ATR, no change; empty → null', () => {
    const f = candleFacts([mk(0, 1, 2, 0.5, 1.5)])!;
    expect(f).toMatchObject({ count: 1, atr14: null, change20Pct: null, sma20: null });
    expect(candleFacts([])).toBeNull();
  });

  it('compact table', () => {
    expect(candleTable([{ t: '2026-11-27T13:00:00Z', o: 3669.42, h: 3671.04, l: 3641.19, c: 3644.04, v: 63367 }])).toBe('2026-11-27 13:00 3669.42 3671.04 3641.19 3644.04 63367');
  });
});
