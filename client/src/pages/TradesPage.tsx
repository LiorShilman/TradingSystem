import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ADHERENCE_LABELS,
  DIRECTION_LABELS,
  Decimal,
  dec,
  decStr,
  formatIsrael,
  nowUtcIso,
  tradeStats,
  unrealizedPnl,
  type Account,
  type Currency,
  type Trade,
} from '@trading/shared';
import { NewTradeForm } from '../components/NewTradeForm';
import { ErrorBox, Money, PageTitle } from '../components/ui';
import { api } from '../lib/api';
import { useQuotes } from '../lib/plan';
import { useActiveAccount } from '../lib/activeAccount';
import { fmtPx, fmtQty, isCurrencyPair, useAccounts, useRates } from '../lib/trades';
import { useAsync } from '../lib/useAsync';

type Result = 'all' | 'win' | 'loss';
type Period = 'all' | 'week' | 'month' | 'year';

const PERIOD_LABELS: Record<Period, string> = { all: 'הכל', week: '7 ימים', month: '30 יום', year: 'שנה' };
const RESULT_LABELS: Record<Result, string> = { all: 'הכל', win: 'רווחיות', loss: 'מפסידות' };
const PERIOD_DAYS: Record<Period, number> = { all: 0, week: 7, month: 30, year: 365 };

export function TradesPage() {
  const trades = useAsync(() => api<Trade[]>('/trades'), []);
  const accounts = useAccounts();
  const [params, setParams] = useSearchParams();
  const [showNew, setShowNew] = useState(params.get('new') === '1');
  const { active } = useActiveAccount();
  const [accountId, setAccountId] = useState(params.get('account') ?? active?.id ?? '');
  // Follow the account chosen in the top bar (a link with ?account= wins).
  useEffect(() => {
    if (!params.get('account')) setAccountId(active?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);
  const [result, setResult] = useState<Result>('all');
  const [period, setPeriod] = useState<Period>('all');
  const [realOnly, setRealOnly] = useState(false);
  const [q, setQ] = useState('');

  const accById = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);
  const isPractice = (a: Account | undefined) => !!a && (a.kind === 'demo' || a.isArchived);

  const filtered = (trades.data ?? []).filter((t) => {
    const a = accById.get(t.accountId);
    if (accountId && t.accountId !== accountId) return false;
    if (realOnly && isPractice(a)) return false;
    if (q && !t.symbol.toUpperCase().includes(q.toUpperCase()) && !t.strategy.includes(q) && !t.tags.some((x) => x.includes(q))) return false;
    return true;
  });
  const open = filtered.filter((t) => t.status === 'open');
  const since = PERIOD_DAYS[period] ? new Date(Date.now() - PERIOD_DAYS[period] * 86400000).toISOString() : '';
  const closed = filtered.filter(
    (t) =>
      t.status === 'closed' &&
      (!since || (t.closedAt ?? '') >= since) &&
      (result === 'all' || (t.netPnl !== null && (result === 'win' ? dec(t.netPnl).gt(0) : dec(t.netPnl).lte(0)))),
  );

  return (
    <div className="space-y-6">
      <PageTitle
        actions={
          <button
            className="btn-primary"
            onClick={() => {
              setShowNew((s) => !s);
              setParams({});
            }}
          >
            {showNew ? 'סגור' : '+ עסקה ידנית'}
          </button>
        }
      >
        יומן מסחר
      </PageTitle>

      {showNew && (
        <section className="card space-y-2">
          <h2 className="font-semibold">עסקה חדשה (בלי תוכנית)</h2>
          <p className="text-xs text-slate-500">עסקה שיש לה תוכנית — פותחים מדף התוכנית, כדי שהכל יועתק ויישמר הקישור.</p>
          <NewTradeForm onCancel={() => setShowNew(false)} />
        </section>
      )}

      <ErrorBox message={trades.error ?? accounts.error} />

      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">כל החשבונות</option>
          {(accounts.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {isPractice(a) ? (a.isArchived ? ' (ארכיון)' : ' (דמו)') : ''}
            </option>
          ))}
        </select>
        <input className="input w-40" placeholder="נכס / אסטרטגיה / תגית" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={realOnly} onChange={(e) => setRealOnly(e.target.checked)} />
          בלי דמו וארכיון
        </label>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-bold">
          פתוחות <span className="text-sm font-normal text-slate-500">({open.length})</span>
        </h2>
        {trades.data && open.length === 0 && <p className="text-sm text-slate-500">אין עסקאות פתוחות.</p>}
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {open.map((t) => (
            <OpenTradeCard key={t.id} t={t} account={accById.get(t.accountId)} />
          ))}
        </div>
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">
            סגורות <span className="text-sm font-normal text-slate-500">({closed.length})</span>
          </h2>
          <div className="flex flex-wrap gap-3">
            <Chips value={period} labels={PERIOD_LABELS} onChange={setPeriod} />
            <Chips value={result} labels={RESULT_LABELS} onChange={setResult} />
          </div>
        </div>
        {closed.length > 0 && <Summary trades={closed} />}
        {trades.data && closed.length === 0 && <p className="text-sm text-slate-500">אין עסקאות סגורות שמתאימות לסינון.</p>}
        {closed.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500">
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th className="py-2 text-start font-medium">נסגרה</th>
                  <th className="text-start font-medium">נכס</th>
                  <th className="text-start font-medium">כיוון</th>
                  <th className="text-start font-medium">חשבון</th>
                  <th className="text-start font-medium">אסטרטגיה</th>
                  <th className="text-end font-medium">רווח נטו</th>
                  <th className="text-end font-medium">R</th>
                  <th className="text-end font-medium">%</th>
                  <th className="text-center font-medium">עמדתי בתוכנית</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((t) => {
                  const a = accById.get(t.accountId);
                  const pct = tradeStats(t).pct;
                  return (
                    <tr key={t.id} className="border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40">
                      <td className="py-2 tabular-nums text-slate-500">
                        <span dir="ltr"><Link to={`/trades/${t.id}`} className="hover:underline">
                          {formatIsrael(t.closedAt ?? t.openedAt, 'dd/MM/yy HH:mm')}
                        </Link></span>
                      </td>
                      <td className="text-start font-medium">
                        <span dir="ltr"><Link to={`/trades/${t.id}`} className="text-sky-600 hover:underline">
                          {t.symbol}
                        </Link></span>
                      </td>
                      <td>{DIRECTION_LABELS[t.direction]}</td>
                      <td className="text-slate-500">
                        {a?.name ?? '—'}
                        {isPractice(a) && <span className="ms-1 rounded bg-slate-500/15 px-1 text-[10px]">{a!.isArchived ? 'ארכיון' : 'דמו'}</span>}
                      </td>
                      <td className="text-slate-500">{t.strategy || '—'}</td>
                      <td className="text-end">{t.netPnl !== null ? <Money value={t.netPnl} currency={t.currency} colored /> : <span className="text-amber-600">חסר שער</span>}</td>
                      <td className="text-end tabular-nums">
                        <span dir="ltr">{t.r ?? '—'}</span>
                      </td>
                      <td className="text-end tabular-nums">
                        <span dir="ltr">{pct ? `${pct}%` : '—'}</span>
                      </td>
                      <td className="text-center">{t.followedPlan ? ADHERENCE_LABELS[t.followedPlan] : <span className="text-slate-400">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Chips<T extends string>({ value, labels, onChange }: { value: T; labels: Record<T, string>; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 rounded-xl bg-slate-200/60 p-1 dark:bg-slate-800/60">
      {(Object.keys(labels) as T[]).map((k) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          className={`rounded-lg px-2.5 py-0.5 text-xs transition ${value === k ? 'bg-white font-semibold shadow-sm dark:bg-slate-700' : 'text-slate-600 dark:text-slate-400'}`}
        >
          {labels[k]}
        </button>
      ))}
    </div>
  );
}

/** Totals of the shown closed trades. Money is summed per account currency (never mixed). */
function Summary({ trades }: { trades: Trade[] }) {
  const withPnl = trades.filter((t) => t.netPnl !== null);
  const wins = withPnl.filter((t) => dec(t.netPnl!).gt(0)).length;
  const byCcy = new Map<Currency, Decimal>();
  for (const t of withPnl) byCcy.set(t.currency, (byCcy.get(t.currency) ?? new Decimal(0)).plus(dec(t.netPnl!)));
  const rs = trades.filter((t) => t.r !== null).map((t) => dec(t.r!));
  const sumR = rs.reduce((a, b) => a.plus(b), new Decimal(0));
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800/60">
      <span>
        עסקאות: <b>{trades.length}</b>
      </span>
      {withPnl.length > 0 && (
        <span>
          אחוז הצלחה: <b dir="ltr">{Math.round((wins / withPnl.length) * 100)}%</b> ({wins}/{withPnl.length})
        </span>
      )}
      {[...byCcy].map(([c, v]) => (
        <span key={c}>
          רווח נטו: <Money value={decStr(v)} currency={c} colored />
        </span>
      ))}
      {rs.length > 0 && (
        <span>
          סך R: <b dir="ltr">{decStr(sumR.toDecimalPlaces(2))}R</b> · ממוצע <b dir="ltr">{decStr(sumR.div(rs.length).toDecimalPlaces(2))}R</b>
        </span>
      )}
    </div>
  );
}

function OpenTradeCard({ t, account }: { t: Trade; account: Account | undefined }) {
  const quote = useQuotes([t.symbol])[t.symbol];
  const rates = useRates();
  const s = tradeStats(t);
  const u = quote && rates ? unrealizedPnl(t, quote.price, t.currency, rates) : null;
  const days = Math.floor((Date.parse(nowUtcIso()) - Date.parse(t.openedAt)) / 86400000);
  return (
    <Link to={`/trades/${t.id}`} className="card block space-y-2 transition hover:border-sky-400">
      <div className="flex items-center justify-between gap-2">
        <span className="font-bold" dir="ltr">
          {t.symbol}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t.direction === 'long' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'}`}>
          {DIRECTION_LABELS[t.direction]}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        {u ? (
          <span className="text-xl font-semibold">
            <Money value={u.amount} currency={t.currency} colored />
          </span>
        ) : (
          <span className="text-sm text-slate-500">אין מחיר חי</span>
        )}
        {u?.r && (
          <span className="text-sm tabular-nums text-slate-500" dir="ltr">
            {u.r}R
          </span>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-slate-500">
        <dt>כמות פתוחה</dt>
        <dd className="text-end tabular-nums">
          <span dir="ltr">{fmtQty(s.openQty, t.assetClass === 'forex' && isCurrencyPair(t.symbol))}</span>
        </dd>
        <dt>כניסה ממוצעת</dt>
        <dd className="text-end tabular-nums">
          <span dir="ltr">{fmtPx(s.avgEntry, t.symbol, t.assetClass)}</span>
        </dd>
        <dt>מחיר נוכחי</dt>
        <dd className="text-end tabular-nums">
          <span dir="ltr">{quote?.price ?? '—'}</span>
        </dd>
        <dt>סטופ</dt>
        <dd className="text-end tabular-nums">
          <span dir="ltr">{fmtPx(t.currentStop ?? t.initialStop, t.symbol, t.assetClass)}</span>
        </dd>
      </dl>
      <div className="flex justify-between text-[11px] text-slate-400">
        <span>
          {account?.name}
          {account?.kind === 'demo' ? ' · דמו' : ''}
        </span>
        <span>{days > 0 ? `פתוחה ${days} ימים` : 'נפתחה היום'}</span>
      </div>
    </Link>
  );
}
