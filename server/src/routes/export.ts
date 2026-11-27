import { Router } from 'express';
import { ADHERENCE_LABELS, DEFAULT_SETTINGS, DIRECTION_LABELS, TRADE_STATUS_LABELS, formatIsrael, nowUtcIso, tradeStats, type Trade } from '@trading/shared';
import type { Store } from '../store/types';

export const EXPORT_VERSION = 3;

export function exportRouter(store: Store) {
  const r = Router();

  // Full JSON dump of every collection. Screenshot files themselves are on disk (ZIP export comes with backups).
  r.get('/', async (_req, res) => {
    const [accounts, cashflows, ideas, plans, trades, notes, screenshots, assets, settings, fx] = await Promise.all([
      store.accounts.list(),
      store.cashflows.list(),
      store.ideas.list(),
      store.plans.list(),
      store.trades.list(),
      store.notes.list(),
      store.screenshots.list(),
      store.assets.list(),
      store.settings.get(),
      store.fx.get(),
    ]);
    const exportedAt = nowUtcIso();
    const filename = `trading-export-${formatIsrael(exportedAt, 'yyyy-MM-dd_HHmm')}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json({
      app: 'trading-system',
      version: EXPORT_VERSION,
      exportedAt,
      settings: settings ?? DEFAULT_SETTINGS,
      fx,
      accounts,
      cashflows,
      ideas,
      plans,
      trades,
      notes,
      screenshots,
      assets,
    });
  });

  // Trades as CSV for Excel: UTF-8 with BOM (so Hebrew opens correctly), times in Israel time.
  r.get('/trades.csv', async (_req, res) => {
    const [trades, accounts] = await Promise.all([store.trades.list(), store.accounts.list()]);
    const names = new Map(accounts.map((a) => [a.id, a.name]));
    const rows = trades.sort((a, b) => a.openedAt.localeCompare(b.openedAt)).map((t) => tradeRow(t, names.get(t.accountId) ?? ''));
    const csv = BOM + [TRADE_CSV_HEADER, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="trades-${formatIsrael(nowUtcIso(), 'yyyy-MM-dd')}.csv"`);
    res.send(csv);
  });

  return r;
}

const BOM = String.fromCharCode(0xfeff);

const TRADE_CSV_HEADER = [
  'נפתחה',
  'נסגרה',
  'סטטוס',
  'חשבון',
  'נכס',
  'כיוון',
  'אסטרטגיה',
  'כמות',
  'כניסה ממוצעת',
  'יציאה ממוצעת',
  'סטופ התחלתי',
  'עמלות',
  'עלויות',
  'רווח נטו',
  'מטבע',
  'R',
  '% מהחשבון',
  'עמדתי בתוכנית',
  'תגיות',
  'לקח',
];

function tradeRow(t: Trade, account: string): string[] {
  const s = tradeStats(t);
  const time = (iso: string | null) => (iso ? formatIsrael(iso, 'yyyy-MM-dd HH:mm') : '');
  return [
    time(t.openedAt),
    time(t.closedAt),
    TRADE_STATUS_LABELS[t.status],
    account,
    t.symbol,
    DIRECTION_LABELS[t.direction],
    t.strategy,
    s.entryQty,
    s.avgEntry ?? '',
    s.avgExit ?? '',
    t.initialStop,
    s.fees,
    s.costs,
    t.netPnl ?? '',
    t.currency,
    t.r ?? '',
    s.pct ?? '',
    t.followedPlan ? ADHERENCE_LABELS[t.followedPlan] : '',
    t.tags.join(' '),
    t.lesson,
  ];
}

/** Quote when needed. Text starting with = + - @ (not a number) is prefixed so Excel never runs it as a formula. */
export function csvCell(v: string): string {
  let s = v ?? '';
  if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
