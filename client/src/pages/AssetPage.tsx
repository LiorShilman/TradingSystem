import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DIRECTION_LABELS, PLAN_STATUS_LABELS, normalizeDecInput, normalizeSymbol, type AssetDoc, type Idea, type Plan } from '@trading/shared';
import { NotesTimeline } from '../components/Notes';
import { ScreenshotGallery } from '../components/Screenshots';
import { TradingViewChart } from '../components/TradingViewChart';
import { ErrorBox, Field } from '../components/ui';
import { api } from '../lib/api';
import { useQuotes } from '../lib/plan';
import { SaveIndicatorText, useAutosave } from '../lib/useAutosave';
import { useAsync } from '../lib/useAsync';
import { StatusPill } from './IdeasPage';

export function AssetPage() {
  const { symbol: raw = '' } = useParams();
  const symbol = normalizeSymbol(decodeURIComponent(raw));
  if (!symbol) return <ErrorBox message="סימול לא תקין" />;
  return <AssetView key={symbol} symbol={symbol} />;
}

function AssetView({ symbol }: { symbol: string }) {
  const enc = encodeURIComponent(symbol);
  const doc = useAsync(() => api<AssetDoc>(`/assets/${enc}`), [enc]);
  const ideas = useAsync(() => api<Idea[]>(`/ideas?symbol=${enc}`), [enc]);
  const plans = useAsync(() => api<Plan[]>(`/plans?symbol=${enc}`), [enc]);
  const quote = useQuotes([symbol])[symbol];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/assets" className="text-sm text-sky-600 hover:underline">
          → נכסים
        </Link>
        <h1 className="text-xl font-bold" dir="ltr">{symbol}</h1>
        {quote && (
          <span className="text-sm">
            <span dir="ltr" className="font-semibold tabular-nums">{quote.price}</span> <span className="text-xs text-slate-500">FXCM</span>
          </span>
        )}
        <div className="ms-auto flex gap-2">
          <Link to={`/ideas?new=1&symbol=${enc}`} className="btn-ghost">
            + רעיון
          </Link>
          <Link to={`/plans/new?symbol=${enc}`} className="btn-primary">
            + תוכנית
          </Link>
        </div>
      </div>

      {/* 2xl: wide main column (chart, screenshots, notes) + research side column. Narrower: stacked. */}
      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_30rem]">
      <div className="card min-w-0 2xl:col-start-1">
        <TradingViewChart symbol={symbol} timeframe="D" />
      </div>

      <div className="grid gap-6 self-start lg:grid-cols-2 2xl:col-start-2 2xl:row-span-4 2xl:row-start-1 2xl:grid-cols-1">
        {doc.data && <Research initial={doc.data} symbol={symbol} />}
        <div className="space-y-6">
          <div className="card space-y-2">
            <h3 className="font-semibold">תוכניות ({plans.data?.length ?? 0})</h3>
            {plans.data?.length === 0 && <p className="text-sm text-slate-500">אין תוכניות לנכס הזה.</p>}
            <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {plans.data?.map((p) => (
                <li key={p.id}>
                  <Link to={`/plans/${p.id}`} className="flex items-center justify-between gap-2 py-1.5 hover:text-sky-600">
                    <span>
                      {DIRECTION_LABELS[p.direction]} {p.entryLow && <span dir="ltr">@ {p.entryLow}</span>}
                    </span>
                    <span className="text-xs text-slate-500">{PLAN_STATUS_LABELS[p.status]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div className="card space-y-2">
            <h3 className="font-semibold">רעיונות ({ideas.data?.length ?? 0})</h3>
            {ideas.data?.length === 0 && <p className="text-sm text-slate-500">אין רעיונות לנכס הזה.</p>}
            <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {ideas.data?.map((i) => (
                <li key={i.id}>
                  <Link to={`/ideas/${i.id}`} className="flex items-center justify-between gap-2 py-1.5 hover:text-sky-600">
                    <span className="truncate">{i.title}</span>
                    <StatusPill status={i.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="card min-w-0 2xl:col-start-1">
        <ScreenshotGallery parentKind="asset" parentId={symbol} symbol={symbol} pasteTarget title="צילומי מחקר" />
      </div>
      <div className="card min-w-0 2xl:col-start-1">
        <ScreenshotGallery symbol={symbol} readOnly title="כל הצילומים של הנכס (מכל הרעיונות והתוכניות)" />
      </div>
      <div className="card min-w-0 2xl:col-start-1">
        <NotesTimeline parentKind="asset" parentId={symbol} symbol={symbol} title="הערות מחקר" />
      </div>
      </div>
    </div>
  );
}

function Research({ initial, symbol }: { initial: AssetDoc; symbol: string }) {
  const [levels, setLevels] = useState(initial.levels.length ? initial.levels.map((l) => ({ ...l, alert: !!l.alert })) : [{ price: '', label: '', alert: false }]);
  const [summary, setSummary] = useState(initial.summary);
  const [badRow, setBadRow] = useState<number | null>(null);

  const autosave = useAutosave({ levels, summary }, async (v) => {
    const clean = [];
    for (const [i, l] of v.levels.entries()) {
      if (!l.price.trim()) continue;
      const p = normalizeDecInput(l.price);
      if (!p) {
        setBadRow(i);
        throw new Error('מחיר לא תקין באחת הרמות');
      }
      clean.push({ price: p, label: l.label, alert: l.alert });
    }
    setBadRow(null);
    await api(`/assets/${encodeURIComponent(symbol)}`, { method: 'PUT', body: { levels: clean, summary: v.summary } });
  });

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">מחקר ורמות</h3>
        <SaveIndicatorText {...autosave} />
      </div>
      <Field label="תמונה גדולה">
        <textarea className="input min-h-28" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="מגמה, הקשר פונדמנטלי, מה חשוב לזכור על הנכס" />
      </Field>
      <div className="space-y-2">
        <div className="text-sm font-medium">
          רמות מפתח <span className="text-xs font-normal text-slate-500">· 🔔 = התראה בטלגרם כשהמחיר חוצה את הרמה</span>
        </div>
        {levels.map((l, i) => (
          <div key={i} className="flex gap-2">
            <input
              className={`input w-32 tabular-nums ${badRow === i ? 'border-red-500' : ''}`}
              dir="ltr"
              inputMode="decimal"
              placeholder="מחיר"
              value={l.price}
              onChange={(e) => setLevels(levels.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))}
            />
            <input className="input" placeholder="למשל: התנגדות שבועית" value={l.label} onChange={(e) => setLevels(levels.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <button
              type="button"
              className={`shrink-0 rounded-lg px-2 text-base transition ${l.alert ? 'bg-amber-400/20' : 'opacity-40 grayscale hover:opacity-80'}`}
              aria-pressed={l.alert}
              title={l.alert ? 'התראה בחציית הרמה — פעילה' : 'הפעל התראה בטלגרם כשהמחיר חוצה את הרמה'}
              onClick={() => setLevels(levels.map((x, j) => (j === i ? { ...x, alert: !x.alert } : x)))}
            >
              🔔
            </button>
            <button type="button" className="text-sm text-red-600" aria-label="הסר רמה" onClick={() => setLevels(levels.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" className="text-sm text-sky-600 hover:underline" onClick={() => setLevels([...levels, { price: '', label: '', alert: false }])}>
          + רמה
        </button>
      </div>
    </div>
  );
}
