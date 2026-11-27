import { describe, expect, it } from 'vitest';
import { buildBrokerSnapshot, fxcmgrConfigSchema, parseFxcmgrAccount, parseFxcmgrPositions } from './broker';

describe('FXCMgr parsing', () => {
  it('reads equity and dayPL as decimal strings', () => {
    expect(parseFxcmgrAccount({ accounts: [{ equity: 10234.56, dayPL: -12.3 }] })).toEqual({ equity: '10234.56', dayPL: '-12.3' });
  });

  it('rejects a broken Account response instead of showing zeros', () => {
    expect(() => parseFxcmgrAccount({ accounts: [] })).toThrow();
    expect(() => parseFxcmgrAccount({})).toThrow();
  });

  it('reads open positions', () => {
    const p = parseFxcmgrPositions({
      open_positions: [
        { amountK: 10, currency: 'EUR/USD', grossPL: 25.5, type: 'B', takeProfit: 1.1 },
        { amountK: 5, currency: 'USD/JPY', grossPL: -8, type: 'S', takeProfit: 0 },
      ],
    });
    expect(p).toEqual([
      { instrument: 'EUR/USD', direction: 'long', amountK: '10', grossPL: '25.5', takeProfit: '1.1' },
      { instrument: 'USD/JPY', direction: 'short', amountK: '5', grossPL: '-8', takeProfit: null },
    ]);
    expect(parseFxcmgrPositions({ open_positions: [] })).toEqual([]);
  });

  it('balanceApprox = equity − open P&L', () => {
    const s = buildBrokerSnapshot(
      { equity: '10017.5', dayPL: '5' },
      parseFxcmgrPositions({ open_positions: [{ grossPL: 25.5 }, { grossPL: -8 }] }),
      '2026-11-27T07:00:00.000Z',
    );
    expect(s.openPL).toBe('17.5');
    expect(s.balanceApprox).toBe('10000');
  });

  it('validates the connection config', () => {
    const ok = { kind: 'fxcmgr', enabled: true, baseUrl: 'http://localhost:11000', hostHeader: '' };
    expect(fxcmgrConfigSchema.safeParse(ok).success).toBe(true);
    expect(fxcmgrConfigSchema.safeParse({ ...ok, baseUrl: 'localhost' }).success).toBe(false);
    expect(fxcmgrConfigSchema.safeParse({ ...ok, baseUrl: 'ftp://x' }).success).toBe(false);
  });
});
