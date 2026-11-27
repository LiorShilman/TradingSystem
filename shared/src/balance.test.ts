import { describe, expect, it } from 'vitest';
import { computeBalance, convert, portfolioTotal } from './balance';
import { cashflowCreateSchema } from './schemas';

describe('balance', () => {
  it('deposit 10,000 and withdraw 1,500.25 → 8,499.75', () => {
    expect(
      computeBalance([
        { type: 'deposit', amount: '10000' },
        { type: 'withdrawal', amount: '1500.25' },
      ]),
    ).toBe('8499.75');
  });

  it('fees subtract, interest adds, adjustment is signed', () => {
    expect(
      computeBalance([
        { type: 'deposit', amount: '100' },
        { type: 'fee', amount: '2.5' },
        { type: 'interest', amount: '0.1' },
        { type: 'adjustment', amount: '-7.6' },
      ]),
    ).toBe('90');
  });

  it('converts via USD and refuses to invent a missing rate', () => {
    expect(convert('100', 'USD', 'ILS', { ILS: '3.65' })).toBe('365');
    expect(convert('365', 'ILS', 'USD', { ILS: '3.65' })).toBe('100');
    expect(convert('100', 'EUR', 'ILS', { ILS: '3.65' })).toBeNull();
  });

  it('portfolio total reports missing rates and skips archived accounts', () => {
    const accounts = [
      { balance: '1000', baseCurrency: 'USD' as const },
      { balance: '500', baseCurrency: 'EUR' as const },
      { balance: '99999', baseCurrency: 'GBP' as const, isArchived: true },
    ];
    expect(portfolioTotal(accounts, 'ILS', { ILS: '3.65' })).toEqual({ total: null, missing: ['EUR'] });
    expect(portfolioTotal(accounts, 'USD', { EUR: '0.5' })).toEqual({ total: '2000', missing: [] });
  });
});

describe('cashflow validation', () => {
  const base = { accountId: 'a1', occurredAt: '2026-11-27T06:00:00.000Z' };
  it('rejects negative deposit and zero amount, allows negative adjustment', () => {
    expect(cashflowCreateSchema.safeParse({ ...base, type: 'deposit', amount: '-5' }).success).toBe(false);
    expect(cashflowCreateSchema.safeParse({ ...base, type: 'deposit', amount: '0' }).success).toBe(false);
    expect(cashflowCreateSchema.safeParse({ ...base, type: 'deposit', amount: '' }).success).toBe(false);
    expect(cashflowCreateSchema.safeParse({ ...base, type: 'adjustment', amount: '-5' }).success).toBe(true);
  });
});
