import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ACTIVE_PLAN_STATUSES, COMMON_FX_SYMBOLS, DEFAULT_FX_EXCHANGE, FX_WATCHLIST, formatIsrael, normalizeSymbol, type Plan } from '@trading/shared';
import { Badge, PairTile, currencyMeta } from '../components/PairTile';
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

      {/* Panels size by pair count, so small currencies share a row on wide screens. */}
      <div className="flex flex-wrap gap-4">
      {groups.map((g) => {
        const meta = currencyMeta(g.section);
        const tiles = g.tickers.map((t) => {
          const sym = `${DEFAULT_FX_EXCHANGE}:${t}`;
          const h = history[sym];
          const price = h?.quote?.price ?? null;
          const a = bySymbol.get(sym);
          const inZone = !!price && activePlans.some((p) => p.symbol === sym && zoneDistance(p, price)?.inZone);
          return { t, sym, h, price, a, inZone };
        });
        const zoneCount = tiles.filter((x) => x.inZone).length;
        const planCount = tiles.reduce((n, x) => n + (x.a?.activePlans ?? 0), 0);
        return (
          <div key={g.section} style={{ flex: `${g.tickers.length} 1 ${g.tickers.length * 242 + 36}px` }} className={`min-w-0 space-y-4 rounded-2xl border border-s-4 border-y-slate-200 border-e-slate-200 bg-white/60 p-4 dark:border-y-slate-800 dark:border-e-slate-800 dark:bg-slate-900/40 ${meta.accent}`}>
            <div className="flex flex-wrap items-center gap-3">
              <Badge code={g.section} className="size-10 text-sm" />
              <div>
                <h3 className="text-lg font-bold leading-tight" dir="ltr">{g.section}</h3>
                <p className="text-xs text-slate-500">{meta.name}</p>
              </div>
              <span className="rounded-full bg-slate-500/15 px-2.5 py-0.5 text-xs font-medium text-slate-600 dark:text-slate-300">{g.tickers.length} צמדים</span>
              {planCount > 0 && <span className="rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs text-sky-600 dark:text-sky-300">{planCount} תוכניות פעילות</span>}
              {zoneCount > 0 && <span className="rounded-full bg-amber-400/20 px-2.5 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-300">🎯 {zoneCount} באזור כניסה</span>}
            </div>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]">
              {tiles.map((x) => (
                <PairTile key={x.t} symbol={x.sym} price={x.price} points={x.h?.points ?? []} activePlans={x.a?.activePlans} ideas={x.a?.ideas} inZone={x.inZone} />
              ))}
            </div>
          </div>
        );
      })}
      </div>
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
