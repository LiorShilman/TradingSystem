import { describe, expect, it } from 'vitest';
import { tradeCreateSchema, tradeDerived, tradeIssues, tradeStats, unrealizedPnl, withComputedPnl, type TradeInput } from './journal';

const T0 = '2026-11-27T08:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60000).toISOString();
let n = 0;
const fill = (kind: 'entry' | 'exit', price: string, quantity: string, min: number, extra: Record<string, unknown> = {}) => ({ id: `f${++n}`, kind, price, quantity, at: at(min), ...extra });

/** The acceptance example: EURUSD long in a USD account of $10,000. */
function example(over: Partial<Record<string, unknown>> = {}): TradeInput {
  return tradeCreateSchema.parse({
    symbol: 'FX:EURUSD',
    accountId: 'acc',
    direction: 'long',
    initialStop: '1.0780',
    equityAtEntry: '10000',
    fills: [fill('entry', '1.0800', '50000', 0), fill('entry', '1.0810', '50000', 5), fill('exit', '1.0845', '50000', 60), fill('exit', '1.0825', '50000', 90, { fee: '4' })],
    ...over,
  });
}

describe('trade stats', () => {
  it('scale in/out: average entry, P&L per exit, net, R and % of account', () => {
    const t = withComputedPnl(example(), 'USD', { USD: '1' });
    expect(t.fills.filter((f) => f.kind === 'exit').map((f) => f.pnl)).toEqual(['200', '100']);
    const s = tradeStats(t);
    expect(s).toMatchObject({ avgEntry: '1.0805', openQty: '0', status: 'closed', grossPnl: '300', fees: '4', netPnl: '296', r: '1.2', pct: '2.96' });
    expect(tradeDerived(t)).toMatchObject({ status: 'closed', openedAt: at(0), closedAt: at(90), netPnl: '296', r: '1.2' });
  });

  it('open trade: still open, entry fee already counts, unrealized P&L at the live price', () => {
    const t = withComputedPnl(example({ fills: [fill('entry', '1.0800', '100000', 0, { fee: '2' })] }), 'USD', { USD: '1' });
    expect(tradeStats(t)).toMatchObject({ status: 'open', openQty: '100000', netPnl: '-2', r: null });
    expect(unrealizedPnl(t, '1.0790', 'USD', { USD: '1' })).toEqual({ amount: '-100', r: '-0.5' });
  });

  it('short in a USD account on USDJPY: P&L converted at the exit price; manual broker P&L wins', () => {
    const base = tradeCreateSchema.parse({
      symbol: 'FX:USDJPY',
      accountId: 'acc',
      direction: 'short',
      initialStop: '160.00',
      fills: [fill('entry', '159.00', '100000', 0), fill('exit', '158.00', '100000', 60)],
    });
    const t = withComputedPnl(base, 'USD', { USD: '1' });
    expect(t.fills[1]!.pnl).toBe('632.91'); // 1.00 JPY × 100,000 / 158
    expect(tradeStats(t).r).toBe('1');
    const manual = withComputedPnl({ ...base, fills: [base.fills[0]!, { ...base.fills[1]!, pnl: '630.5', pnlManual: true }] }, 'USD', { USD: '1' });
    expect(tradeStats(manual).netPnl).toBe('630.5');
  });

  it('cross pair needs a rate: unknown P&L stays null instead of a guess', () => {
    const t = withComputedPnl(example({ symbol: 'FX:EURGBP', initialStop: '0.83', fills: [fill('entry', '0.84', '1000', 0), fill('exit', '0.85', '1000', 1)] }), 'USD', { USD: '1' });
    expect(tradeStats(t).netPnl).toBeNull();
    const withRate = withComputedPnl(t, 'USD', { USD: '1', GBP: '0.8' });
    expect(tradeStats(withRate).netPnl).toBe('12.5'); // 10 GBP / 0.8
  });

  it('swap/costs change the net', () => {
    const t = withComputedPnl(example({ costs: [{ id: 'c1', kind: 'swap', at: at(100), amount: '-1.5' }] }), 'USD', { USD: '1' });
    expect(tradeStats(t).netPnl).toBe('294.5');
  });
});

describe('trade issues', () => {
  it('blocks exiting more than is open, a missing entry and a stop on the wrong side', () => {
    expect(tradeIssues(example())).toEqual([]);
    expect(tradeIssues(example({ fills: [fill('entry', '1.08', '1000', 0), fill('exit', '1.09', '2000', 1)] }))).toContain('יציאה בכמות גדולה מהכמות הפתוחה באותו רגע');
    expect(tradeIssues(example({ fills: [fill('exit', '1.09', '1000', 0)] }))).toContain('חסרה כניסה');
    expect(tradeIssues(example({ initialStop: '1.0900' }))).toContain('בקנייה הסטופ ההתחלתי חייב להיות מתחת למחיר הכניסה');
  });

  it('schema: needs an account and at least one fill', () => {
    expect(tradeCreateSchema.safeParse({ symbol: 'EURUSD', direction: 'long', initialStop: '1', fills: [] }).success).toBe(false);
  });
});
