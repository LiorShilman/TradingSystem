import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ACTIVE_PLAN_STATUSES, COMMON_FX_SYMBOLS, DEFAULT_FX_EXCHANGE, FX_WATCHLIST, formatIsrael, normalizeSymbol, type Plan } from '@trading/shared';
import { PairTile } from '../components/PairTile';
import { SymbolInput } from '../components/SymbolInput';
import { ErrorBox, PageTitle } from '../components/ui';
import { api } from '../lib/api';
import { zoneDistance, type Quote } from '../lib/plan';
import { useAsync } from '../lib/useAsync';

interface AssetRow {
  symbol: string;
  ideas: number;
  plans: number;
  activePlans: number;
  hasResearch: boolean;
  updatedAt: string;
}

type History = Record<string, { quote: Quote | null; points: Array<[number, string]> }>;

/** Prices + up to an hour of sparkline points, refreshed every 20s while the tab is visible. */
function useQuoteHistory(symbols: readonly string[]) {
  const [data, setData] = useState<History>({});
  const key = symbols.join(',');
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<History>(`/quotes/history?symbols=${encodeURIComponent(key)}`)
        .then((d) => alive && setData(d))
        .catch(() => undefined);
    void load();
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key]);
  return data;
}

const ALL = 'הכל';

function Watchlist({ assets, plans }: { assets: AssetRow[]; plans: Plan[] }) {
  const history = useQuoteHistory(COMMON_FX_SYMBOLS);
  const [group, setGroup] = useState(ALL);
  const [q, setQ] = useState('');

  const bySymbol = useMemo(() => new Map(assets.map((a) => [a.symbol, a])), [assets]);
  const activePlans = plans.filter((p) => ACTIVE_PLAN_STATUSES.includes(p.status));
  const live = Object.values(history).some((h) => h.quote);

  const groups = FX_WATCHLIST.filter((g) => group === ALL || g.section === group)
    .map((g) => ({ ...g, tickers: g.tickers.filter((t) => !q || t.includes(q.toUpperCase().replace('/', ''))) }))
    .filter((g) => g.tickers.length);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">רשימת מעקב</h2>
          <p className="text-xs text-slate-500">
            All Forex (FXCM) ·{' '}
            {live ? (
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> מחירים חיים מ-FXCM · גרף ושינוי של השעה האחרונה
              </span>
            ) : (
              'אין מחירים חיים — FXCMgr לא מחובר או כבוי'
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input w-36" dir="ltr" placeholder="חיפוש…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="flex flex-wrap gap-1 rounded-xl bg-slate-200/60 p-1 dark:bg-slate-800/60">
            {[ALL, ...FX_WATCHLIST.map((g) => g.section)].map((g) => (
              <button
                key={g}
                onClick={() => setGroup(g)}
                className={`rounded-lg px-3 py-1 text-sm transition ${group === g ? 'bg-white font-semibold shadow-sm dark:bg-slate-700' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}
              >
                {g}
              </button>
            ))}
          </div>
        </div>
      </div>

      {groups.map((g) => (
        <div key={g.section} className="space-y-2">
          {group === ALL && <div className="text-xs font-semibold tracking-widest text-slate-500">{g.section} PAIRS</div>}
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
            {g.tickers.map((t) => {
              const sym = `${DEFAULT_FX_EXCHANGE}:${t}`;
              const h = history[sym];
              const price = h?.quote?.price ?? null;
              const a = bySymbol.get(sym);
              const inZone = !!price && activePlans.some((p) => p.symbol === sym && zoneDistance(p, price)?.inZone);
              return <PairTile key={t} symbol={sym} price={price} points={h?.points ?? []} activePlans={a?.activePlans} ideas={a?.ideas} inZone={inZone} />;
            })}
          </div>
        </div>
      ))}
      {groups.length === 0 && <p className="text-sm text-slate-500">אין צמד שמתאים לחיפוש.</p>}
    </section>
  );
}

export function AssetsPage() {
  const navigate = useNavigate();
  const assets = useAsync(() => api<AssetRow[]>('/assets'), []);
  const plans = useAsync(() => api<Plan[]>('/plans'), []);
  const [symbol, setSymbol] = useState('');

  function open(e: FormEvent) {
    e.preventDefault();
    const s = normalizeSymbol(symbol);
    if (s) navigate(`/assets/${encodeURIComponent(s)}`);
  }

  const watch = new Set(COMMON_FX_SYMBOLS);
  const others = assets.data?.filter((a) => !watch.has(a.symbol)) ?? [];

  return (
    <div className="space-y-8">
      <PageTitle
        actions={
          <form onSubmit={open} className="flex items-center gap-2">
            <div className="w-56">
              <SymbolInput value={symbol} onChange={setSymbol} />
            </div>
            <button className="btn-primary" disabled={!symbol.trim()}>
              פתח נכס
            </button>
          </form>
        }
      >
        נכסים
      </PageTitle>

      <ErrorBox message={assets.error} />
      <Watchlist assets={assets.data ?? []} plans={plans.data ?? []} />

      {others.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-bold">נכסים נוספים</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {others.map((a) => (
              <Link key={a.symbol} to={`/assets/${encodeURIComponent(a.symbol)}`} className="card block transition hover:border-sky-400">
                <div dir="ltr" className="text-right font-semibold">{a.symbol}</div>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                  <span>{a.ideas} רעיונות</span>
                  <span>
                    {a.plans} תוכניות{a.activePlans ? ` (${a.activePlans} פעילות)` : ''}
                  </span>
                  {a.hasResearch && <span>📝 מחקר</span>}
                  <span className="ms-auto" dir="ltr">{formatIsrael(a.updatedAt, 'dd/MM')}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
