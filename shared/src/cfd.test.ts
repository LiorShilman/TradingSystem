import { describe, expect, it } from 'vitest';
import { tradeCreateSchema, tradeStats, unrealizedPnl, withComputedPnl } from './journal';
import { positionSize, specFromFxcm } from './sizing';

// Offer rows exactly as FXCMgr returned them on 27/11/2026 (models=OfferSpec:<instrument>).
const FXCM = {
  gold: { instrument: 'XAU/USD', pointSize: 0.01, pipCost: 0.01, baseUnitSize: 1, minQuantity: 1 },
  oil: { instrument: 'USOil', pointSize: 0.01, pipCost: 0.1, baseUnitSize: 1, minQuantity: 1 },
  spx: { instrument: 'SPX500F', pointSize: 0.1, pipCost: 0.1, baseUnitSize: 1, minQuantity: 1 },
  nas: { instrument: 'NAS100F', pointSize: 1.0, pipCost: 0.1, baseUnitSize: 1, minQuantity: 1 },
  eur: { instrument: 'EUR/USD', pointSize: 0.0001, pipCost: 0.1, baseUnitSize: 1000, minQuantity: 1000 },
};
const AT = '2026-11-27T12:00:00.000Z';
const spec = (sym: string, o: (typeof FXCM)[keyof typeof FXCM]) => specFromFxcm(sym, o, 'USD', AT)!;
const size = (sym: string, o: (typeof FXCM)[keyof typeof FXCM], entry: string, stop: string) =>
  positionSize({ assetClass: 'forex', symbol: sym, spec: spec(sym, o), entry, stop, riskPct: '1', equity: '10000', accountCurrency: 'USD', rates: { USD: '1' } });

describe('FXCM CFD spec', () => {
  it('value of a 1.0 move per unit, from pip cost and pip size', () => {
    expect(spec('FX:XAUUSD', FXCM.gold).pointValue).toBe('1');
    expect(spec('FX:USOIL', FXCM.oil).pointValue).toBe('10');
    expect(spec('FX:SPX500', FXCM.spx).pointValue).toBe('1');
    expect(spec('FX:NAS100', FXCM.nas).pointValue).toBe('0.1');
    expect(spec('FX:EURUSD', FXCM.eur).pointValue).toBe('1'); // sanity: matches the currency-pair math
    expect(specFromFxcm('X', { instrument: 'X', pointSize: 0, pipCost: 0.1, baseUnitSize: 1 }, 'USD', AT)).toBeNull();
  });

  it('size in contracts/units for 1% of $10,000 ($100 risk)', () => {
    expect(size('FX:XAUUSD', FXCM.gold, '3670', '3650')).toMatchObject({ ok: true, value: { units: '5', roundedRisk: '100', pointValue: '1' } }); // $20 stop → 5 oz
    expect(size('FX:USOIL', FXCM.oil, '85', '84')).toMatchObject({ ok: true, value: { units: '10', roundedRisk: '100' } }); // $1 stop × $10 → 10 contracts
    expect(size('FX:SPX500', FXCM.spx, '7300', '7270')).toMatchObject({ ok: true, value: { units: '3', roundedRisk: '90' } }); // 30 pts → 3.33 → 3
    expect(size('FX:NAS100', FXCM.nas, '26600', '26500')).toMatchObject({ ok: true, value: { units: '10', roundedRisk: '100' } }); // 100 pts × $0.10
    const tooSmall = size('FX:USOIL', FXCM.oil, '85', '70'); // $15 stop × $10 = $150 for one contract > $100
    expect(tooSmall.ok).toBe(false);
  });

  it('journal P&L uses the stored point value (oil: 10 contracts, +$1.50 = +$150)', () => {
    const t = tradeCreateSchema.parse({
      symbol: 'FX:USOIL',
      accountId: 'a',
      direction: 'long',
      initialStop: '84',
      pointValue: '10',
      pointValueCurrency: 'USD',
      fills: [
        { id: 'e', kind: 'entry', at: AT, price: '85', quantity: '10' },
        { id: 'x', kind: 'exit', at: AT, price: '86.5', quantity: '10' },
      ],
    });
    expect(tradeStats(withComputedPnl(t, 'USD', { USD: '1' }))).toMatchObject({ netPnl: '150', r: '1.5' });
    expect(unrealizedPnl({ ...t, fills: [t.fills[0]!] }, '84.5', 'USD', { USD: '1' })).toEqual({ amount: '-50', r: '-0.5' });
  });
});
