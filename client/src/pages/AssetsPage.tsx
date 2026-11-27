import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ACTIVE_PLAN_STATUSES, formatIsrael, normalizeSymbol, watchlistSymbols, type Plan, type Watchlist, type WatchlistSection } from '@trading/shared';
import { Badge, PairTile, currencyMeta } from '../components/PairTile';
import { SymbolInput } from '../components/SymbolInput';
import { ErrorBox, PageTitle } from '../components/ui';
import { api, ApiError } from '../lib/api';
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
    if (!key) return;
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

const ALL = '__all__';
const LIST_KEY = 'watchlistId';
const isCurrency = (name: string) => /^[A-Z]{3}$/.test(name) && currencyMeta(name).name !== name;

function WatchlistView({ list, assets, plans, onSaved }: { list: Watchlist; assets: AssetRow[]; plans: Plan[]; onSaved: (w: Watchlist) => void }) {
  const symbols = useMemo(() => watchlistSymbols(list), [list]);
  const history = useQuoteHistory(symbols);
  const [group, setGroup] = useState(ALL);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bySymbol = useMemo(() => new Map(assets.map((a) => [a.symbol, a])), [assets]);
  const activePlans = plans.filter((p) => ACTIVE_PLAN_STATUSES.includes(p.status));
  const quotes = Object.values(history).filter((h) => h.quote);
  const delayed = quotes.filter((h) => h.quote?.delayedMin).length;

  async function save(sections: WatchlistSection[], name = list.name) {
    setError(null);
    try {
      onSaved(await api<Watchlist>(`/watchlists/${list.id}`, { method: 'PATCH', body: { name, sections } }));
    } catch (e) {
      setError(e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : 'שגיאה');
    }
  }
  const remove = (secIdx: number, sym: string) => void save(list.sections.map((s, i) => (i === secIdx ? { ...s, symbols: s.symbols.filter((x) => x !== sym) } : s)));
  const add = (secIdx: number, sym: string) => {
    if (list.sections[secIdx]!.symbols.includes(sym)) return setError(`${sym} כבר ברשימה`);
    void save(list.sections.map((s, i) => (i === secIdx ? { ...s, symbols: [...s.symbols, sym] } : s)));
  };

  const needle = q.trim().toUpperCase().replace('/', '');
  const sections = list.sections
    .map((s, idx) => ({ ...s, idx, shown: s.symbols.filter((x) => !needle || x.includes(needle) || (history[x]?.quote?.name ?? '').toUpperCase().includes(needle)) }))
    .filter((s) => (group === ALL || String(s.idx) === group) && (editing || s.shown.length));

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          {quotes.length ? (
            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> מחירים מ-FXCM ומ-TradingView · גרף ושינוי של השעה האחרונה
              {delayed > 0 && <span className="text-amber-600 dark:text-amber-400"> · {delayed} באיחור (מסומנים)</span>}
            </span>
          ) : (
            'טוען מחירים…'
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input w-36" dir="ltr" placeholder="חיפוש…" value={q} onChange={(e) => setQ(e.target.value)} />
          {list.sections.length > 1 && (
            <div className="flex flex-wrap gap-1 rounded-xl bg-slate-200/60 p-1 dark:bg-slate-800/60">
              {[{ key: ALL, label: 'הכל' }, ...list.sections.map((s, i) => ({ key: String(i), label: s.name || 'ללא קבוצה' }))].map((g) => (
                <button
                  key={g.key}
                  onClick={() => setGroup(g.key)}
                  className={`rounded-lg px-3 py-1 text-sm transition ${group === g.key ? 'bg-white font-semibold shadow-sm dark:bg-slate-700' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}
                >
                  {g.label}
                </button>
              ))}
            </div>
          )}
          <button className={editing ? 'btn-primary' : 'btn-ghost'} onClick={() => setEditing((e) => !e)}>
            {editing ? 'סיום עריכה ✓' : '✎ עריכת הרשימה'}
          </button>
        </div>
      </div>
      <ErrorBox message={error} />
      {editing && <ListSettings list={list} onSave={save} />}

      {/* Panels size by symbol count, so small groups share a row on wide screens. */}
      <div className="flex flex-wrap gap-4">
        {sections.map((s) => {
          const ccy = isCurrency(s.name);
          const meta = currencyMeta(s.name);
          const tiles = s.shown.map((sym) => {
            const h = history[sym];
            const price = h?.quote?.price ?? null;
            const a = bySymbol.get(sym);
            const inZone = !!price && activePlans.some((p) => p.symbol === sym && zoneDistance(p, price)?.inZone);
            return { sym, h, price, a, inZone };
          });
          const n = Math.max(1, tiles.length);
          const zoneCount = tiles.filter((x) => x.inZone).length;
          const planCount = tiles.reduce((acc, x) => acc + (x.a?.activePlans ?? 0), 0);
          return (
            <div
              key={s.idx}
              style={{ flex: `${n} 1 ${n * 242 + 36}px` }}
              className={`min-w-0 space-y-4 rounded-2xl border border-s-4 border-y-slate-200 border-e-slate-200 bg-white/60 p-4 dark:border-y-slate-800 dark:border-e-slate-800 dark:bg-slate-900/40 ${ccy ? meta.accent : 'border-s-sky-500/60'}`}
            >
              <div className="flex flex-wrap items-center gap-3">
                {ccy && <Badge code={s.name} className="size-10 text-sm" />}
                <div>
                  <h3 className="text-lg font-bold leading-tight" dir="ltr">
                    {s.name || 'ללא קבוצה'}
                  </h3>
                  {ccy && <p className="text-xs text-slate-500">{meta.name}</p>}
                </div>
                <span className="rounded-full bg-slate-500/15 px-2.5 py-0.5 text-xs font-medium text-slate-600 dark:text-slate-300">{s.symbols.length} נכסים</span>
                {planCount > 0 && <span className="rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs text-sky-600 dark:text-sky-300">{planCount} תוכניות פעילות</span>}
                {zoneCount > 0 && <span className="rounded-full bg-amber-400/20 px-2.5 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-300">🎯 {zoneCount} באזור כניסה</span>}
              </div>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]">
                {tiles.map((x) => (
                  <PairTile
                    key={x.sym}
                    symbol={x.sym}
                    price={x.price}
                    points={x.h?.points ?? []}
                    source={x.h?.quote?.source}
                    delayedMin={x.h?.quote?.delayedMin}
                    name={x.h?.quote?.name}
                    activePlans={x.a?.activePlans}
                    ideas={x.a?.ideas}
                    inZone={x.inZone}
                    onRemove={editing ? () => remove(s.idx, x.sym) : undefined}
                    noSource={!!x.h && !x.h.quote}
                  />
                ))}
              </div>
              {editing && <AddSymbol onAdd={(sym) => add(s.idx, sym)} />}
            </div>
          );
        })}
      </div>
      {!editing && sections.length === 0 && <p className="text-sm text-slate-500">{needle ? 'אין נכס שמתאים לחיפוש.' : 'הרשימה ריקה — לחץ "עריכת הרשימה" כדי להוסיף נכסים.'}</p>}
    </section>
  );
}

function AddSymbol({ onAdd }: { onAdd: (symbol: string) => void }) {
  const [v, setV] = useState('');
  const sym = normalizeSymbol(v);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (sym) {
          onAdd(sym);
          setV('');
        }
      }}
    >
      <div className="w-56">
        <SymbolInput value={v} onChange={setV} />
      </div>
      <button className="btn-ghost" disabled={!sym}>
        + הוסף לקבוצה
      </button>
      <span className="text-xs text-slate-500">בפורמט של TradingView, למשל FX:XAUUSD, BITSTAMP:BTCUSD, NASDAQ:NVDA</span>
    </form>
  );
}

/** Rename the list, rename/add/remove groups. */
function ListSettings({ list, onSave }: { list: Watchlist; onSave: (sections: WatchlistSection[], name?: string) => Promise<void> }) {
  const [name, setName] = useState(list.name);
  const [names, setNames] = useState(list.sections.map((s) => s.name));
  useEffect(() => {
    setName(list.name);
    setNames(list.sections.map((s) => s.name));
  }, [list]);
  const dirty = name !== list.name || names.some((n, i) => n !== list.sections[i]?.name);
  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="text-sm font-medium">שם הרשימה</span>
          <input className="input w-56" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <div className="space-y-2">
        <span className="text-sm font-medium">קבוצות</span>
        <div className="flex flex-wrap gap-2">
          {names.map((n, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 dark:bg-slate-800">
              <input className="w-28 bg-transparent text-sm outline-none" dir="auto" value={n} placeholder="ללא שם" onChange={(e) => setNames(names.map((x, j) => (j === i ? e.target.value : x)))} />
              <span className="text-xs text-slate-400">({list.sections[i]?.symbols.length ?? 0})</span>
              {list.sections.length > 1 && (
                <button
                  className="text-xs text-red-600"
                  title="מחק קבוצה"
                  onClick={() => {
                    const cnt = list.sections[i]?.symbols.length ?? 0;
                    if (cnt && !confirm(`למחוק את הקבוצה ואת ${cnt} הנכסים שבה מהרשימה?`)) return;
                    void onSave(list.sections.filter((_, j) => j !== i), name);
                  }}
                >
                  ✕
                </button>
              )}
            </span>
          ))}
          <button className="text-sm text-sky-600 hover:underline" onClick={() => void onSave([...list.sections, { name: 'קבוצה חדשה', symbols: [] }], name)}>
            + קבוצה
          </button>
        </div>
      </div>
      {dirty && (
        <button className="btn-primary" onClick={() => void onSave(list.sections.map((s, i) => ({ ...s, name: names[i] ?? s.name })), name)}>
          שמור שמות
        </button>
      )}
      <p className="text-xs text-slate-500">הרשימות שמורות במערכת בלבד — שינוי כאן לא נוגע ב-TradingView וב-Trading Station.</p>
    </div>
  );
}

export function AssetsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const assets = useAsync(() => api<AssetRow[]>('/assets'), []);
  const plans = useAsync(() => api<Plan[]>('/plans'), []);
  const lists = useAsync(() => api<Watchlist[]>('/watchlists'), []);
  const [symbol, setSymbol] = useState('');
  const [error, setError] = useState<string | null>(null);

  const stored = (() => {
    try {
      return localStorage.getItem(LIST_KEY);
    } catch {
      return null;
    }
  })();
  const all = lists.data ?? [];
  const current = all.find((w) => w.id === params.get('list')) ?? all.find((w) => w.id === stored) ?? all[0] ?? null;

  function pick(id: string) {
    try {
      localStorage.setItem(LIST_KEY, id);
    } catch {
      /* private mode */
    }
    setParams({ list: id });
  }

  async function newList() {
    const name = prompt('שם לרשימה החדשה:');
    if (!name?.trim()) return;
    try {
      const w = await api<Watchlist>('/watchlists', { method: 'POST', body: { name: name.trim() } });
      lists.setData([...all, w]);
      pick(w.id);
    } catch (e) {
      setError(e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : 'שגיאה');
    }
  }

  async function deleteList(w: Watchlist) {
    if (!confirm(`למחוק את הרשימה "${w.name}"? (הנכסים עצמם, התוכניות והמחקר לא נמחקים)`)) return;
    try {
      await api(`/watchlists/${w.id}`, { method: 'DELETE' });
      lists.setData(all.filter((x) => x.id !== w.id));
      setParams({});
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'שגיאה');
    }
  }

  function open(e: FormEvent) {
    e.preventDefault();
    const s = normalizeSymbol(symbol);
    if (s) navigate(`/assets/${encodeURIComponent(s)}`);
  }

  const inLists = new Set(all.flatMap(watchlistSymbols));
  const others = assets.data?.filter((a) => !inLists.has(a.symbol)) ?? [];

  return (
    <div className="space-y-6">
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

      <ErrorBox message={error ?? assets.error ?? lists.error} />

      {/* Watchlist tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-2 dark:border-slate-800">
        {all.map((w) => (
          <button
            key={w.id}
            onClick={() => pick(w.id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${current?.id === w.id ? 'bg-sky-600 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}
          >
            {w.name} <span className="text-xs opacity-70">({watchlistSymbols(w).length})</span>
          </button>
        ))}
        <button className="rounded-lg px-3 py-1.5 text-sm text-sky-600 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => void newList()}>
          + רשימה חדשה
        </button>
        {current && all.length > 1 && (
          <button className="ms-auto text-xs text-red-600 hover:underline" onClick={() => void deleteList(current)}>
            מחק את הרשימה
          </button>
        )}
      </div>

      {current && (
        <WatchlistView
          key={current.id}
          list={current}
          assets={assets.data ?? []}
          plans={plans.data ?? []}
          onSaved={(w) => lists.setData(all.map((x) => (x.id === w.id ? w : x)))}
        />
      )}

      {others.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-bold">נכסים נוספים (עם רעיונות, תוכניות או מחקר, מחוץ לרשימות)</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {others.map((a) => (
              <Link key={a.symbol} to={`/assets/${encodeURIComponent(a.symbol)}`} className="card block transition hover:border-sky-400">
                <div dir="ltr" className="text-right font-semibold">
                  {a.symbol}
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                  <span>{a.ideas} רעיונות</span>
                  <span>
                    {a.plans} תוכניות{a.activePlans ? ` (${a.activePlans} פעילות)` : ''}
                  </span>
                  {a.hasResearch && <span>📝 מחקר</span>}
                  <span className="ms-auto" dir="ltr">
                    {formatIsrael(a.updatedAt, 'dd/MM')}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
