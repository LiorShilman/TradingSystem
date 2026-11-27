import { describe, expect, it } from 'vitest';
import { Decimal } from './money';
import { evaluateLevel, evaluatePlanPrice, type PlanAlertState } from './alerts';

const long = { symbol: 'FX:EURUSD', assetClass: 'forex' as const, direction: 'long' as const, entryLow: '1.0800', entryHigh: '1.0810', stopLoss: '1.0780' };

/** Feed prices in order; collect what fired. */
function run(p: Parameters<typeof evaluatePlanPrice>[0], prices: string[], approachPips = 10) {
  let s: PlanAlertState | null = null;
  return prices.map((px) => {
    const r = evaluatePlanPrice(p, px, s, approachPips);
    s = r.state;
    return r.fire;
  });
}

describe('plan price alerts', () => {
  it('approach → zone, each once, while price drifts down into a long zone', () => {
    expect(run(long, ['1.0850', '1.0819', '1.0818', '1.0815', '1.0808', '1.0805', '1.0812'])).toEqual([
      null, 'plan_approach', null, null, 'plan_zone', null, null,
    ]);
  });

  it('jumping straight into the zone fires only "zone"', () => {
    expect(run(long, ['1.0850', '1.0805'])).toEqual([null, 'plan_zone']);
  });

  it('hovering at the approach edge does not spam; re-arms after moving clearly away (> 15 pips)', () => {
    expect(run(long, ['1.0819', '1.0821', '1.0819', '1.0824', '1.0819', '1.0826', '1.0819'])).toEqual([
      'plan_approach', null, null, null, null, null, 'plan_approach',
    ]);
  });

  it('stop before entry wins over everything; fires once', () => {
    expect(run(long, ['1.0805', '1.0779', '1.0775', '1.0781'])).toEqual(['plan_zone', 'plan_stop', null, null]);
  });

  it('short plan: zone above the price, stop above the zone', () => {
    const short = { ...long, direction: 'short' as const, entryLow: '1.0900', entryHigh: '1.0910', stopLoss: '1.0930' };
    expect(run(short, ['1.0850', '1.0892', '1.0905', '1.0931'])).toEqual([null, 'plan_approach', 'plan_zone', 'plan_stop']);
  });

  it('JPY pairs use 0.01 pips', () => {
    const jpy = { ...long, symbol: 'FX:USDJPY', entryLow: '150.00', entryHigh: '150.20', stopLoss: '149.50' };
    expect(run(jpy, ['150.50', '150.29'])).toEqual([null, 'plan_approach']);
  });

  it('changing the levels re-arms', () => {
    let s = evaluatePlanPrice(long, '1.0805', null, 10).state;
    expect(evaluatePlanPrice(long, '1.0805', s, 10).fire).toBeNull();
    s = evaluatePlanPrice({ ...long, entryLow: '1.0801' }, '1.0805', s, 10).state;
    expect(s.zone).toBe(true);
    expect(evaluatePlanPrice({ ...long, entryLow: '1.0802' }, '1.0805', s, 10).fire).toBe('plan_zone');
  });

  it('non-forex: no "approach", zone and stop still work', () => {
    const stock = { ...long, symbol: 'NASDAQ:AAPL', assetClass: 'stock' as const, entryLow: '200', entryHigh: '201', stopLoss: '195' };
    expect(run(stock, ['201.5', '200.5', '194'])).toEqual([null, 'plan_zone', 'plan_stop']);
  });
});

describe('level crossings', () => {
  const buf = new Decimal('0.0005'); // 5 pips
  function feed(prices: string[]) {
    let s: Parameters<typeof evaluateLevel>[2] = null;
    return prices.map((px) => {
      const r = evaluateLevel('1.0900', px, s, buf);
      s = r.state;
      return r.fire;
    });
  }

  it('first observation never fires; a cross does', () => {
    expect(feed(['1.0950', '1.0899'])).toEqual([null, 'down']);
  });

  it('chop around the level fires once until the price moves 5 pips away', () => {
    expect(feed(['1.0880', '1.0901', '1.0899', '1.0902', '1.0898', '1.0906', '1.0899'])).toEqual([null, 'up', null, null, null, null, 'down']);
  });

  it('starting right at the level is disarmed until it gets away', () => {
    expect(feed(['1.0901', '1.0899', '1.0890', '1.0905'])).toEqual([null, null, null, 'up']);
  });
});
