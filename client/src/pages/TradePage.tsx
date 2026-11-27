import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ACCOUNT_KIND_LABELS,
  ADHERENCE,
  ADHERENCE_LABELS,
  COST_KINDS,
  COST_KIND_LABELS,
  DIRECTION_LABELS,
  FILL_KIND_LABELS,
  TRADE_STATUS_LABELS,
  dec,
  formatIsrael,
  israelLocalToUtcIso,
  normalizeDecInput,
  nowUtcIso,
  planMetrics,
  tradeStats,
  unrealizedPnl,
  utcIsoToIsraelLocal,
  type Adherence,
  type Cost,
  type CostKind,
  type Fill,
  type FillKind,
  type Plan,
  type Trade,
} from '@trading/shared';
import { NotesTimeline } from '../components/Notes';
import { ScreenshotGallery } from '../components/Screenshots';
import { TagsInput } from '../components/SymbolInput';
import { TradingViewChart } from '../components/TradingViewChart';
import { ErrorBox, Field, Money } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useQuotes } from '../lib/plan';
import { fmtPx, fmtQty, isCurrencyPair, newId, parseQty, useAccounts, useRates } from '../lib/trades';
import { useAsync } from '../lib/useAsync';
import { SaveIndicatorText, useAutosave } from '../lib/useAutosave';

export function TradePage() {
  const { id = '' } = useParams();
  const trade = useAsync(() => api<Trade>(`/trades/${id}`), [id]);
  if (trade.error) return <ErrorBox message={trade.error} />;
  if (!trade.data) return <p className="text-sm text-slate-500">טוען…</p>;
  return <TradeView key={trade.data.id} initial={trade.data} />;
}

const errText = (e: unknown) => (e instanceof ApiError ? (e.details[0] ?? e.issues[0]?.message ?? e.message) : e instanceof Error ? e.message : 'שגיאה');

function TradeView({ initial }: { initial: Trade }) {
  const navigate = useNavigate();
  const [t, setT] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const accounts = useAccounts();
  const account = accounts.data?.find((a) => a.id === t.accountId);
  const plan = useAsync(() => (t.planId ? api<Plan>(`/plans/${t.planId}`) : Promise.resolve(null)), [t.planId]);
  const quote = useQuotes([t.symbol])[t.symbol];
  const rates = useRates();
  const s = tradeStats(t);
  const forex = t.assetClass === 'forex' && isCurrencyPair(t.symbol);
  const u = t.status === 'open' && quote && rates ? unrealizedPnl(t, quote.price, t.currency, rates) : null;

  /** Structural changes (fills, costs, stops) save immediately; the server re-validates and recomputes. */
  async function patch(body: Partial<Trade>): Promise<boolean> {
    setError(null);
    try {
      setT(await api<Trade>(`/trades/${t.id}`, { method: 'PATCH', body }));
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    }
  }

  async function remove() {
    if (!confirm('למחוק את העסקה, ההערות והצילומים שלה? הרווח/הפסד שלה יוצא מיתרת החשבון.')) return;
    await api(`/trades/${t.id}`, { method: 'DELETE' });
    navigate('/trades');
  }

  const needsClosingNotes = t.status === 'closed' && (!t.emotionExit || !t.followedPlan || !t.lesson.trim());

  return (
    <div className="space-y-6">
      <Link to="/trades" className="text-sm text-sky-600 hover:underline">
        → היומן
      </Link>

      {/* Header */}
      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold" dir="ltr">
            {t.symbol}
          </h1>
          <span className={`rounded-full px-2.5 py-0.5 text-sm ${t.direction === 'long' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'}`}>
            {DIRECTION_LABELS[t.direction]}
          </span>
          <span className={`rounded-full px-2.5 py-0.5 text-sm ${t.status === 'open' ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300' : 'bg-slate-200 dark:bg-slate-700'}`}>{TRADE_STATUS_LABELS[t.status]}</span>
          {account && (
            <span className="text-sm text-slate-500">
              {account.name}
              {account.kind === 'demo' && <span className="ms-1 rounded bg-slate-500/15 px-1.5 text-xs">{ACCOUNT_KIND_LABELS.demo}</span>}
            </span>
          )}
          {t.status === 'open' && quote && (
            <span className="text-sm">
              מחיר: <span dir="ltr" className="font-semibold tabular-nums">{quote.price}</span>
              {u && (
                <span className="ms-2">
                  צף: <Money value={u.amount} currency={t.currency} colored />
                  {u.r && <span dir="ltr" className="ms-1 text-slate-500">({u.r}R)</span>}
                </span>
              )}
            </span>
          )}
          <span className="ms-auto flex gap-3 text-xs">
            {t.planId && (
              <Link to={`/plans/${t.planId}`} className="text-sky-600 hover:underline">
                לתוכנית ←
              </Link>
            )}
            {!t.planId && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">לא מתוכננת</span>}
          </span>
        </div>
        <SummaryGrid t={t} />
        <ErrorBox message={error} />
      </div>

      {needsClosingNotes && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          העסקה נסגרה. כדי ללמוד ממנה — מלא למטה: <b>מצב רגשי ביציאה</b>, <b>האם עמדת בתוכנית</b>, ו<b>לקח במשפט אחד</b>.
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="min-w-0 space-y-6">
          <FillsCard t={t} forex={forex} openQty={s.openQty} onPatch={patch} />
          <CostsCard t={t} onPatch={patch} />
          {plan.data && <PlanVsActual plan={plan.data} t={t} />}
          <div className="card">
            <TradingViewChart symbol={t.symbol} timeframe={t.timeframe || 'H1'} />
          </div>
          <div className="card">
            <ScreenshotGallery parentKind="trade" parentId={t.id} symbol={t.symbol} pasteTarget defaultPhase={t.status === 'open' ? 'entry' : 'exit'} />
          </div>
          {t.planId && (
            <div className="card">
              <ScreenshotGallery parentKind="plan" parentId={t.planId} readOnly title="צילומים מהתוכנית" />
            </div>
          )}
        </div>

        <div className="space-y-6 self-start">
          <StopsCard t={t} onPatch={patch} />
          <JournalCard t={t} onSaved={setT} />
          <div className="card">
            <NotesTimeline parentKind="trade" parentId={t.id} symbol={t.symbol} title="יומן העסקה" />
          </div>
          <button className="btn-danger" onClick={remove}>
            מחק עסקה
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryGrid({ t }: { t: Trade }) {
  const s = tradeStats(t);
  const forex = t.assetClass === 'forex' && isCurrencyPair(t.symbol);
  const cell = (label: string, value: React.ReactNode, hint?: string) => (
    <div className="rounded-lg bg-slate-100 px-3 py-2 dark:bg-slate-800/60" title={hint}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="font-semibold tabular-nums" dir="ltr">
        {value}
      </div>
    </div>
  );
  return (
    <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(130px,1fr))]">
      {cell('כמות פתוחה', fmtQty(s.openQty, forex))}
      {cell('כניסה ממוצעת', fmtPx(s.avgEntry, t.symbol, t.assetClass))}
      {cell('יציאה ממוצעת', fmtPx(s.avgExit, t.symbol, t.assetClass))}
      {cell('רווח נטו (ממומש)', s.netPnl !== null ? <Money value={s.netPnl} currency={t.currency} colored /> : 'חסר שער', 'יציאות פחות עמלות, ועוד עלויות (swap וכו׳)')}
      {cell('R', s.r !== null ? `${s.r}R` : '—', 'התנועה בפועל חלקי הסיכון המקורי (כניסה ממוצעת → סטופ התחלתי)')}
      {cell('% מהחשבון', s.pct !== null ? `${s.pct}%` : '—', t.equityAtEntry ? `מתוך יתרה של ${t.equityAtEntry} בכניסה` : undefined)}
      {cell('עמלות ועלויות', <Money value={dec(s.costs).minus(dec(s.fees)).toString()} currency={t.currency} />)}
      {t.pointValue && t.pointValueCurrency && cell('שווי תזוזה של 1.0 ליחידה', <Money value={t.pointValue} currency={t.pointValueCurrency} />, 'מהמפרט של FXCM ברגע פתיחת העסקה — הרווח מחושב לפיו')}
    </div>
  );
}

// ---------- fills ----------
function FillsCard({ t, forex, openQty, onPatch }: { t: Trade; forex: boolean; openQty: string; onPatch: (b: Partial<Trade>) => Promise<boolean> }) {
  const [kind, setKind] = useState<FillKind>(t.status === 'open' ? 'exit' : 'entry');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');
  const [fee, setFee] = useState('');
  const [when, setWhen] = useState(() => utcIsoToIsraelLocal(nowUtcIso()));
  const [err, setErr] = useState<string | null>(null);
  const [editPnl, setEditPnl] = useState<{ id: string; value: string } | null>(null);
  const fills = useMemo(() => [...t.fills].sort((a, b) => a.at.localeCompare(b.at)), [t.fills]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const p = normalizeDecInput(price);
    const q = parseQty(qty || (kind === 'exit' ? openQty : ''));
    const f = fee.trim() ? normalizeDecInput(fee) : '0';
    const at = israelLocalToUtcIso(when);
    if (!p || Number(p) <= 0) return setErr('מחיר לא תקין');
    if (!q) return setErr('כמות לא תקינה');
    if (f === null || Number(f) < 0) return setErr('עמלה לא תקינה');
    if (!at) return setErr('זמן לא תקין');
    setErr(null);
    const fill: Fill = { id: newId(), kind, at, price: p, quantity: q, fee: f, pnl: null, pnlManual: false, note: '' };
    if (await onPatch({ fills: [...t.fills, fill] })) {
      setPrice('');
      setQty('');
      setFee('');
      setWhen(utcIsoToIsraelLocal(nowUtcIso()));
    }
  }

  async function savePnl(f: Fill) {
    if (!editPnl) return;
    const v = editPnl.value.trim();
    const n = v ? normalizeDecInput(v) : null;
    if (v && n === null) return setErr('סכום לא תקין');
    // Empty = back to the computed figure.
    await onPatch({ fills: t.fills.map((x) => (x.id === f.id ? { ...x, pnl: n, pnlManual: n !== null } : x)) });
    setEditPnl(null);
  }

  return (
    <div className="card space-y-3">
      <h2 className="font-semibold">ביצועים</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500">
            <tr className="border-b border-slate-200 dark:border-slate-700">
              <th className="py-1.5 text-start font-medium">זמן</th>
              <th className="text-start font-medium">סוג</th>
              <th className="text-end font-medium">מחיר</th>
              <th className="text-end font-medium">כמות</th>
              <th className="text-end font-medium">עמלה</th>
              <th className="text-end font-medium">רווח/הפסד</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {fills.map((f) => (
              <tr key={f.id} className="border-b border-slate-100 dark:border-slate-800">
                <td className="py-1.5 tabular-nums text-slate-500">
                  <span dir="ltr">{formatIsrael(f.at, 'dd/MM/yy HH:mm')}</span>
                </td>
                <td className={f.kind === 'entry' ? 'text-sky-700 dark:text-sky-300' : 'text-violet-700 dark:text-violet-300'}>{FILL_KIND_LABELS[f.kind]}</td>
                <td className="text-end tabular-nums">
                  <span dir="ltr">{fmtPx(f.price, t.symbol, t.assetClass)}</span>
                </td>
                <td className="text-end tabular-nums">
                  <span dir="ltr">{fmtQty(f.quantity, forex)}</span>
                </td>
                <td className="text-end">{Number(f.fee) ? <Money value={f.fee} currency={t.currency} /> : <span className="text-slate-400">—</span>}</td>
                <td className="text-end">
                  {f.kind === 'exit' &&
                    (editPnl?.id === f.id ? (
                      <span className="inline-flex items-center gap-1">
                        <input className="input w-24 py-0.5 text-sm" dir="ltr" autoFocus value={editPnl.value} onChange={(e) => setEditPnl({ id: f.id, value: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void savePnl(f)} />
                        <button className="text-xs text-sky-600" onClick={() => void savePnl(f)}>
                          שמור
                        </button>
                      </span>
                    ) : (
                      <button className="hover:underline" title="לחץ כדי להזין את הסכום המדויק מהברוקר (ריק = חישוב אוטומטי)" onClick={() => setEditPnl({ id: f.id, value: f.pnlManual ? (f.pnl ?? '') : '' })}>
                        {f.pnl !== null ? <Money value={f.pnl} currency={t.currency} colored /> : <span className="text-amber-600">חסר שער</span>}
                        <span className="ms-1 text-[10px] text-slate-400">{f.pnlManual ? 'ברוקר' : 'מחושב'}</span>
                      </button>
                    ))}
                </td>
                <td className="text-end">
                  <button
                    className="text-xs text-red-600"
                    aria-label="מחק ביצוע"
                    onClick={() => confirm('למחוק את הביצוע?') && void onPatch({ fills: t.fills.filter((x) => x.id !== f.id) })}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={add} className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/40">
        <Field label="סוג">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as FillKind)}>
            <option value="entry">כניסה נוספת</option>
            <option value="exit">יציאה</option>
          </select>
        </Field>
        <div className="w-28">
          <Field label="מחיר">
            <input className="input tabular-nums" dir="ltr" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
        </div>
        <div className="w-28">
          <Field label="כמות">
            <input className="input tabular-nums" dir="ltr" value={qty} onChange={(e) => setQty(e.target.value)} placeholder={kind === 'exit' ? fmtQty(openQty, forex) : forex ? '50K' : ''} />
          </Field>
        </div>
        <div className="w-24">
          <Field label="עמלה">
            <input className="input tabular-nums" dir="ltr" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0" />
          </Field>
        </div>
        <Field label="זמן (שעון ישראל)">
          <input className="input" type="datetime-local" dir="ltr" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <button className="btn-primary">+ הוסף</button>
        {kind === 'exit' && !qty && Number(openQty) > 0 && <span className="w-full text-xs text-slate-500">בלי כמות = יציאה מכל הכמות הפתוחה ({fmtQty(openQty, forex)})</span>}
        {err && <span className="w-full text-sm text-red-600">{err}</span>}
      </form>
    </div>
  );
}

// ---------- costs ----------
function CostsCard({ t, onPatch }: { t: Trade; onPatch: (b: Partial<Trade>) => Promise<boolean> }) {
  const [kind, setKind] = useState<CostKind>('swap');
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const n = normalizeDecInput(amount);
    if (n === null || Number(n) === 0) return setErr('סכום לא תקין');
    setErr(null);
    const c: Cost = { id: newId(), kind, at: nowUtcIso(), amount: n, note: '' };
    if (await onPatch({ costs: [...t.costs, c] })) setAmount('');
  }

  return (
    <details className="card" open={t.costs.length > 0}>
      <summary className="cursor-pointer font-semibold">עלויות נוספות (swap, funding…)</summary>
      <div className="mt-3 space-y-2">
        {t.costs.map((c) => (
          <div key={c.id} className="flex items-center gap-3 text-sm">
            <span className="w-20 text-slate-500">{COST_KIND_LABELS[c.kind]}</span>
            <Money value={c.amount} currency={t.currency} colored />
            <span className="text-xs text-slate-400" dir="ltr">
              {formatIsrael(c.at, 'dd/MM/yy')}
            </span>
            <button className="ms-auto text-xs text-red-600" aria-label="מחק עלות" onClick={() => void onPatch({ costs: t.costs.filter((x) => x.id !== c.id) })}>
              ✕
            </button>
          </div>
        ))}
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <select className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value as CostKind)}>
            {COST_KINDS.map((k) => (
              <option key={k} value={k}>
                {COST_KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <input className="input w-28 tabular-nums" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="-1.50" />
          <button className="btn-ghost">+ הוסף</button>
          <span className="w-full text-xs text-slate-500">השפעה על הרווח במטבע החשבון: הוצאה במינוס (‎-1.50), הכנסה בפלוס.</span>
          {err && <span className="w-full text-sm text-red-600">{err}</span>}
        </form>
      </div>
    </details>
  );
}

// ---------- stops & targets ----------
function StopsCard({ t, onPatch }: { t: Trade; onPatch: (b: Partial<Trade>) => Promise<boolean> }) {
  const px = (p: string) => fmtPx(p, t.symbol, t.assetClass);
  const [initialStop, setInitialStop] = useState(px(t.initialStop));
  const [currentStop, setCurrentStop] = useState(t.currentStop ? px(t.currentStop) : '');
  const [targets, setTargets] = useState(t.targets.map((x) => px(x.price)).join(', '));
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    const init = normalizeDecInput(initialStop);
    const cur = currentStop.trim() ? normalizeDecInput(currentStop) : null;
    const tps = targets
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((x) => normalizeDecInput(x));
    if (!init) return setErr('סטופ התחלתי לא תקין');
    if (currentStop.trim() && !cur) return setErr('סטופ נוכחי לא תקין');
    if (tps.some((x) => x === null)) return setErr('יעד לא תקין');
    setErr(null);
    const ok = await onPatch({ initialStop: init, currentStop: cur, targets: tps.map((p, i) => ({ price: p!, sizePct: t.targets[i]?.sizePct ?? '0' })) });
    setSaved(ok);
  }

  return (
    <div className="card space-y-3">
      <h2 className="font-semibold">סטופ ויעדים</h2>
      <Field label="סטופ התחלתי (קובע את 1R)">
        <input className="input tabular-nums" dir="ltr" value={initialStop} onChange={(e) => (setInitialStop(e.target.value), setSaved(false))} />
      </Field>
      <Field label="סטופ נוכחי" hint="אם הזזת את הסטופ (נקודת איזון, טריילינג). ריק = הסטופ ההתחלתי. התראות הסטופ לפי זה.">
        <input className="input tabular-nums" dir="ltr" value={currentStop} onChange={(e) => (setCurrentStop(e.target.value), setSaved(false))} placeholder={px(t.initialStop)} />
      </Field>
      <Field label="יעדים" hint="מופרדים בפסיק. התראה בטלגרם כשהמחיר מגיע ליעד.">
        <input className="input tabular-nums" dir="ltr" value={targets} onChange={(e) => (setTargets(e.target.value), setSaved(false))} />
      </Field>
      <div className="flex items-center gap-3">
        <button className="btn-ghost" onClick={() => void save()}>
          שמור
        </button>
        {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">נשמר ✓</span>}
        {err && <span className="text-sm text-red-600">{err}</span>}
      </div>
    </div>
  );
}

// ---------- journal (autosave) ----------
interface JournalForm {
  strategy: string;
  tags: string[];
  emotionEntry: Trade['emotionEntry'];
  emotionExit: Trade['emotionExit'];
  followedPlan: Adherence | null;
  deviation: string;
  lesson: string;
}

function JournalCard({ t, onSaved }: { t: Trade; onSaved: (t: Trade) => void }) {
  const [f, setF] = useState<JournalForm>({
    strategy: t.strategy,
    tags: t.tags,
    emotionEntry: t.emotionEntry,
    emotionExit: t.emotionExit,
    followedPlan: t.followedPlan,
    deviation: t.deviation,
    lesson: t.lesson,
  });
  const set = <K extends keyof JournalForm>(k: K, v: JournalForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const autosave = useAutosave(f, async (v) => {
    try {
      onSaved(await api<Trade>(`/trades/${t.id}`, { method: 'PATCH', body: v }));
    } catch (e) {
      throw new Error(errText(e));
    }
  });

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">יומן</h2>
        <SaveIndicatorText {...autosave} />
      </div>
      <Field label="אסטרטגיה / setup">
        <input className="input" value={f.strategy} onChange={(e) => set('strategy', e.target.value)} placeholder="פין בר באזור תמיכה, פריצה…" />
      </Field>
      <Field label="תגיות">
        <TagsInput value={f.tags} onChange={(v) => set('tags', v)} />
      </Field>
      <Emotion label="מצב רגשי בכניסה" value={f.emotionEntry} onChange={(v) => set('emotionEntry', v)} />
      <Emotion label="מצב רגשי ביציאה" value={f.emotionExit} onChange={(v) => set('emotionExit', v)} />
      <div className="space-y-1">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">עמדתי בתוכנית?</span>
        <div className="flex gap-1">
          {ADHERENCE.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => set('followedPlan', f.followedPlan === a ? null : a)}
              className={`rounded-lg px-3 py-1 text-sm ${f.followedPlan === a ? (a === 'yes' ? 'bg-emerald-600 text-white' : a === 'partial' ? 'bg-amber-500 text-white' : 'bg-rose-600 text-white') : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700'}`}
            >
              {ADHERENCE_LABELS[a]}
            </button>
          ))}
        </div>
      </div>
      {(f.followedPlan === 'partial' || f.followedPlan === 'no') && (
        <Field label="מה היה שונה מהתוכנית?">
          <textarea className="input min-h-16" value={f.deviation} onChange={(e) => set('deviation', e.target.value)} placeholder="נכנסתי לפני הטריגר, הזזתי סטופ, יצאתי מוקדם…" />
        </Field>
      )}
      <Field label="לקח במשפט אחד">
        <textarea className="input min-h-16" value={f.lesson} onChange={(e) => set('lesson', e.target.value)} />
      </Field>
    </div>
  );
}

const SCORE_HINT = ['', 'רע מאוד', 'לא טוב', 'בסדר', 'טוב', 'מצוין'];

function Emotion({ label, value, onChange }: { label: string; value: Trade['emotionEntry']; onChange: (v: Trade['emotionEntry']) => void }) {
  return (
    <div className="space-y-1">
      <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
      <div className="flex flex-wrap items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            title={SCORE_HINT[n]}
            onClick={() => onChange(value?.score === n ? null : { score: n, word: value?.word ?? '' })}
            className={`size-8 rounded-lg text-sm ${value?.score === n ? 'bg-sky-600 text-white' : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700'}`}
          >
            {n}
          </button>
        ))}
        <input
          className="input ms-1 w-32 py-1 text-sm"
          value={value?.word ?? ''}
          disabled={!value}
          onChange={(e) => value && onChange({ ...value, word: e.target.value })}
          placeholder={value ? 'מילה: רגוע, לחוץ…' : 'בחר ציון'}
        />
      </div>
    </div>
  );
}

// ---------- plan vs actual ----------
function PlanVsActual({ plan, t }: { plan: Plan; t: Trade }) {
  const m = planMetrics(plan);
  const s = tradeStats(t);
  const px = (p: string | null | undefined) => (p ? fmtPx(p, t.symbol, t.assetClass) : null);
  const row = (label: string, planned: string | null | undefined, actual: string | null | undefined) => (
    <tr className="border-b border-slate-100 dark:border-slate-800">
      <td className="py-1.5 text-slate-500">{label}</td>
      <td className="text-end tabular-nums">
        <span dir="ltr">{planned ?? '—'}</span>
      </td>
      <td className="text-end font-medium tabular-nums">
        <span dir="ltr">{actual ?? '—'}</span>
      </td>
    </tr>
  );
  return (
    <div className="card space-y-2">
      <h2 className="font-semibold">תכננתי מול ביצעתי</h2>
      <table className="w-full text-sm">
        <thead className="text-xs text-slate-500">
          <tr>
            <th />
            <th className="text-end font-medium">תוכנית</th>
            <th className="text-end font-medium">בפועל</th>
          </tr>
        </thead>
        <tbody>
          {row('כניסה', px(m?.entry ?? plan.entryLow), px(s.avgEntry))}
          {row('סטופ', px(plan.stopLoss), px(t.initialStop))}
          {row('יעד ראשון', px(plan.targets[0]?.price), s.avgExit ? `יציאה ממוצעת ${px(s.avgExit)}` : null)}
          {row('R', m ? `${m.avgR}R` : null, s.r ? `${s.r}R` : null)}
        </tbody>
      </table>
    </div>
  );
}
