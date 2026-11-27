import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ASSET_CLASSES,
  ASSET_CLASS_LABELS,
  DIRECTIONS,
  DIRECTION_LABELS,
  ORDER_TYPES,
  ORDER_TYPE_LABELS,
  PLAN_STATUS_LABELS,
  TRADE_STATUS_LABELS,
  convert,
  effectiveRates,
  israelLocalToUtcIso,
  normalizeDecInput,
  planIssues,
  planMetrics,
  positionSize,
  utcIsoToIsraelLocal,
  type Account,
  type AssetClass,
  type BrokerSnapshot,
  type Direction,
  type FxSnapshot,
  type OrderType,
  type Plan,
  type PlanStatus,
  type Settings,
  type Trade,
  type InstrumentSpec,
} from '@trading/shared';
import { NewTradeForm } from '../components/NewTradeForm';
import { NotesTimeline } from '../components/Notes';
import { WebhookSetup } from './AlertsPage';
import { ScreenshotGallery } from '../components/Screenshots';
import { SymbolInput, TagsInput } from '../components/SymbolInput';
import { TradingViewChart } from '../components/TradingViewChart';
import { ErrorBox, Field, Money } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useQuotes, zoneDistance } from '../lib/plan';
import { SaveIndicatorText, useAutosave } from '../lib/useAutosave';
import { useAsync } from '../lib/useAsync';

export function PlanPage() {
  const { id = '' } = useParams();
  const plan = useAsync(() => api<Plan>(`/plans/${id}`), [id]);
  if (plan.error) return <ErrorBox message={plan.error} />;
  if (!plan.data) return <p className="text-sm text-slate-500">טוען…</p>;
  return <PlanEditor key={plan.data.id} initial={plan.data} />;
}

interface Form {
  symbol: string;
  assetClass: AssetClass;
  accountId: string;
  direction: Direction;
  timeframe: string;
  entryLow: string;
  entryHigh: string;
  stopLoss: string;
  targets: Array<{ price: string; sizePct: string }>;
  orderType: OrderType;
  riskPct: string;
  entryConditions: string;
  invalidation: string;
  expires: string;
  tags: string[];
}

const toForm = (p: Plan): Form => ({
  symbol: p.symbol,
  assetClass: p.assetClass,
  accountId: p.accountId ?? '',
  direction: p.direction,
  timeframe: p.timeframe,
  entryLow: p.entryLow ?? '',
  entryHigh: p.entryHigh ?? '',
  stopLoss: p.stopLoss ?? '',
  targets: p.targets.length ? p.targets : [{ price: '', sizePct: '100' }],
  orderType: p.orderType,
  riskPct: p.riskPct,
  entryConditions: p.entryConditions,
  invalidation: p.invalidation,
  expires: p.expiresAt ? utcIsoToIsraelLocal(p.expiresAt) : '',
  tags: p.tags,
});

type FieldErrors = Partial<Record<string, string>>;

/** Form strings → API payload (decimal strings). Collects per-field errors instead of throwing. */
function toPayload(f: Form): { payload: Omit<Plan, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'ideaId'>; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const price = (key: string, s: string): string | null => {
    if (!s.trim()) return null;
    const n = normalizeDecInput(s);
    if (n === null) errors[key] = 'מספר לא תקין';
    return n;
  };
  const targets = f.targets
    .map((t, i) => ({ i, price: price(`target${i}`, t.price), sizePct: normalizeDecInput(t.sizePct || '0') }))
    .filter((t) => t.price !== null)
    .map((t) => {
      if (t.sizePct === null) errors[`size${t.i}`] = 'אחוז לא תקין';
      return { price: t.price!, sizePct: t.sizePct ?? '0' };
    });
  const riskPct = normalizeDecInput(f.riskPct);
  if (riskPct === null) errors.riskPct = 'מספר לא תקין';
  const expiresAt = f.expires ? israelLocalToUtcIso(f.expires) : null;
  return {
    payload: {
      symbol: f.symbol,
      assetClass: f.assetClass,
      accountId: f.accountId || null,
      direction: f.direction,
      timeframe: f.timeframe,
      entryLow: price('entryLow', f.entryLow),
      entryHigh: price('entryHigh', f.entryHigh),
      stopLoss: price('stopLoss', f.stopLoss),
      targets,
      orderType: f.orderType,
      riskPct: riskPct ?? '1',
      entryConditions: f.entryConditions,
      invalidation: f.invalidation,
      expiresAt,
      tags: f.tags,
    },
    errors,
  };
}

function PlanEditor({ initial }: { initial: Plan }) {
  const navigate = useNavigate();
  const [plan, setPlan] = useState(initial);
  const [form, setForm] = useState<Form>(() => toForm(initial));
  const [statusError, setStatusError] = useState<string[] | null>(null);
  const [opening, setOpening] = useState(false);
  const [suggestedUnits, setSuggestedUnits] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const { payload, errors } = useMemo(() => toPayload(form), [form]);
  const issues = planIssues(payload);
  const metrics = planMetrics(payload);

  const autosave = useAutosave(form, async (f) => {
    const r = toPayload(f);
    if (Object.keys(r.errors).length) throw new Error('יש שדה עם מספר לא תקין');
    try {
      setPlan(await api<Plan>(`/plans/${plan.id}`, { method: 'PATCH', body: r.payload }));
    } catch (e) {
      if (e instanceof ApiError && e.details.length) throw new Error(`התוכנית מסומנת "${PLAN_STATUS_LABELS[plan.status]}" — ${e.details[0]}`);
      if (e instanceof ApiError) throw new Error(e.issues[0]?.message ?? e.message);
      throw e;
    }
  });

  async function setStatus(status: PlanStatus) {
    setStatusError(null);
    try {
      setPlan(await api<Plan>(`/plans/${plan.id}`, { method: 'PATCH', body: { ...payload, status } }));
    } catch (e) {
      setStatusError(e instanceof ApiError && e.details.length ? e.details : [e instanceof Error ? e.message : 'שגיאה']);
    }
  }

  async function remove() {
    if (!confirm('למחוק את התוכנית, ההערות והצילומים שלה?')) return;
    await api(`/plans/${plan.id}`, { method: 'DELETE' });
    navigate('/plans');
  }

  const quotes = useQuotes([plan.symbol]);
  const quote = quotes[plan.symbol];
  const dist = quote ? zoneDistance(payload, quote.price) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to="/plans" className="text-sm text-sky-600 hover:underline">
          → כל התוכניות
        </Link>
        <SaveIndicatorText {...autosave} />
      </div>

      {/* Header + status */}
      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold" dir="ltr">{plan.symbol}</h1>
          <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-sm dark:bg-slate-700">{PLAN_STATUS_LABELS[plan.status]}</span>
          {quote && (
            <span className="text-sm">
              מחיר: <span dir="ltr" className="font-semibold tabular-nums">{quote.price}</span>
              {dist && <span className={`ms-2 ${dist.inZone ? 'font-semibold text-amber-600 dark:text-amber-400' : 'text-slate-500'}`}>{dist.text}</span>}
            </span>
          )}
        </div>
        <StatusActions status={plan.status} onSet={setStatus} onOpenTrade={() => setOpening((o) => !o)} />
        {opening && (
          <div className="rounded-xl border border-sky-300 bg-sky-50/50 p-4 dark:border-sky-800 dark:bg-sky-950/30">
            <h3 className="mb-2 font-semibold">פתחתי את העסקה — רישום ביומן</h3>
            {issues.length > 0 ? (
              <p className="text-sm text-amber-700 dark:text-amber-400">קודם השלם את התוכנית: {issues.join(' · ')}</p>
            ) : (
              <NewTradeForm
                onCancel={() => setOpening(false)}
                defaults={{
                  symbol: plan.symbol,
                  assetClass: payload.assetClass,
                  accountId: payload.accountId,
                  direction: payload.direction,
                  timeframe: payload.timeframe,
                  planId: plan.id,
                  ideaId: plan.ideaId,
                  initialStop: payload.stopLoss,
                  entryPrice: metrics?.entry ?? payload.entryLow,
                  quantity: suggestedUnits,
                  targets: payload.targets,
                  tags: payload.tags,
                }}
              />
            )}
          </div>
        )}
        {plan.status === 'opened' && <PlanTrades planId={plan.id} />}
        {statusError && (
          <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            אי אפשר לשנות סטטוס עדיין:
            <ul className="mt-1 list-disc pe-5">
              {statusError.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {plan.ideaId && (
          <Link to={`/ideas/${plan.ideaId}`} className="text-xs text-sky-600 hover:underline">
            נולדה מרעיון ←
          </Link>
        )}
      </div>

      {/* lg: form | side, media below.  2xl: form | media | side (RTL: right → left). */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] 2xl:grid-cols-[minmax(0,34rem)_minmax(0,1fr)_22rem]">
        {/* Levels */}
        <div className="card space-y-4 self-start lg:col-start-1 lg:row-start-1">
          <h2 className="font-semibold">פרטי התוכנית</h2>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="נכס">
              <SymbolInput value={form.symbol} onChange={(v) => set('symbol', v)} />
            </Field>
            <Field label="כיוון">
              <select className="input" value={form.direction} onChange={(e) => set('direction', e.target.value as Direction)}>
                {DIRECTIONS.map((d) => (
                  <option key={d} value={d}>
                    {DIRECTION_LABELS[d]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="טווח זמן">
              <input className="input" dir="ltr" list="tfs" value={form.timeframe} onChange={(e) => set('timeframe', e.target.value.toUpperCase())} placeholder="H4" />
              <datalist id="tfs">
                {['M15', 'H1', 'H4', 'D', 'W'].map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </Field>
            <Field label="סוג פקודה">
              <select className="input" value={form.orderType} onChange={(e) => set('orderType', e.target.value as OrderType)}>
                {ORDER_TYPES.map((o) => (
                  <option key={o} value={o}>
                    {ORDER_TYPE_LABELS[o]}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="כניסה — מ" error={errors.entryLow}>
              <NumInput value={form.entryLow} onChange={(v) => set('entryLow', v)} />
            </Field>
            <Field label="כניסה — עד (אופציונלי)" error={errors.entryHigh}>
              <NumInput value={form.entryHigh} onChange={(v) => set('entryHigh', v)} />
            </Field>
            <Field label="סטופ לוס" error={errors.stopLoss}>
              <NumInput value={form.stopLoss} onChange={(v) => set('stopLoss', v)} />
            </Field>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium">יעדים</div>
            {form.targets.map((t, i) => (
              <div key={i} className="flex flex-wrap items-start gap-2">
                <span className="mt-2 w-10 text-sm text-slate-500">TP{i + 1}</span>
                <div className="w-36">
                  <NumInput value={t.price} onChange={(v) => set('targets', form.targets.map((x, j) => (j === i ? { ...x, price: v } : x)))} placeholder="מחיר" />
                  {errors[`target${i}`] && <span className="text-xs text-red-600">{errors[`target${i}`]}</span>}
                </div>
                <div className="flex w-24 items-center gap-1">
                  <NumInput value={t.sizePct} onChange={(v) => set('targets', form.targets.map((x, j) => (j === i ? { ...x, sizePct: v } : x)))} placeholder="%" />
                  <span className="text-sm text-slate-500">%</span>
                </div>
                <span className="mt-2 text-sm tabular-nums text-slate-600 dark:text-slate-300" dir="ltr">
                  {metrics?.targets.find((m) => m.price === normalizeDecInput(t.price))?.r ?? '—'}R
                </span>
                {form.targets.length > 1 && (
                  <button type="button" className="mt-1.5 text-sm text-red-600" onClick={() => set('targets', form.targets.filter((_, j) => j !== i))} aria-label="הסר יעד">
                    ✕
                  </button>
                )}
              </div>
            ))}
            {form.targets.length < 5 && (
              <button type="button" className="text-sm text-sky-600 hover:underline" onClick={() => set('targets', [...form.targets, { price: '', sizePct: '' }])}>
                + יעד
              </button>
            )}
          </div>

          <Field label="תנאי כניסה">
            <textarea className="input min-h-20" value={form.entryConditions} onChange={(e) => set('entryConditions', e.target.value)} placeholder="מה צריך לקרות כדי שאכנס? (נר היפוך ב-H1 באזור, סגירה מעל…)" />
          </Field>
          <Field label="נקודת ביטול">
            <textarea className="input min-h-16" value={form.invalidation} onChange={(e) => set('invalidation', e.target.value)} placeholder="מה יגרום לי לוותר על העסקה?" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="בתוקף עד (שעון ישראל)">
              <input className="input" type="datetime-local" dir="ltr" value={form.expires} onChange={(e) => set('expires', e.target.value)} />
            </Field>
            <Field label="סוג נכס">
              <select className="input" value={form.assetClass} onChange={(e) => set('assetClass', e.target.value as AssetClass)}>
                {ASSET_CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {ASSET_CLASS_LABELS[c]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="תגיות">
              <TagsInput value={form.tags} onChange={(v) => set('tags', v)} />
            </Field>
          </div>
        </div>

        {/* Side: readiness + sizing */}
        <div className="space-y-4 self-start lg:col-start-2 lg:row-start-1 2xl:sticky 2xl:top-20 2xl:col-start-3">
          <div className="card space-y-2">
            <h2 className="font-semibold">מוכנות</h2>
            {issues.length === 0 ? (
              <p className="text-sm text-emerald-600 dark:text-emerald-400">✓ התוכנית שלמה</p>
            ) : (
              <ul className="space-y-1 text-sm text-amber-700 dark:text-amber-400">
                {issues.map((s) => (
                  <li key={s}>• {s}</li>
                ))}
              </ul>
            )}
            {metrics && (
              <div className="border-t border-slate-200 pt-2 text-sm dark:border-slate-700">
                R:R ממוצע: <span className="font-bold">{metrics.avgR}R</span>
                <span className="text-xs text-slate-500"> (מאמצע האזור {metrics.entry})</span>
              </div>
            )}
          </div>
          <SizingCard form={form} setForm={setForm} entry={metrics?.entry ?? null} stop={payload.stopLoss} riskError={errors.riskPct} onUnits={setSuggestedUnits} />
        </div>

        {/* Media: chart, screenshots, notes */}
        <div className="min-w-0 space-y-6 lg:col-span-2 lg:row-start-2 2xl:col-span-1 2xl:col-start-2 2xl:row-start-1">
      <div className="card">
        <TradingViewChart symbol={plan.symbol} timeframe={form.timeframe || 'H4'} />
      </div>
      <div className="card">
        <ScreenshotGallery parentKind="plan" parentId={plan.id} symbol={plan.symbol} pasteTarget />
      </div>
      {plan.ideaId && (
        <div className="card">
          <ScreenshotGallery parentKind="idea" parentId={plan.ideaId} readOnly title="צילומים מהרעיון" />
        </div>
      )}
      <div className="card">
        <NotesTimeline parentKind="plan" parentId={plan.id} symbol={plan.symbol} />
      </div>
      <details className="group">
        <summary className="cursor-pointer text-sm text-sky-600 hover:underline">📡 התראת TradingView לתוכנית הזו</summary>
        <div className="mt-3">
          <WebhookSetup planId={plan.id} />
        </div>
      </details>
        </div>
      </div>

      <div className="flex gap-2">
        <Link to={`/assets/${encodeURIComponent(plan.symbol)}`} className="btn-ghost">
          דף הנכס
        </Link>
        <button className="btn-danger" onClick={remove}>
          מחק תוכנית
        </button>
      </div>
    </div>
  );
}

function NumInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input className="input tabular-nums" dir="ltr" inputMode="decimal" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

/** Trades opened from this plan. */
function PlanTrades({ planId }: { planId: string }) {
  const trades = useAsync(() => api<Trade[]>(`/trades?planId=${encodeURIComponent(planId)}`), [planId]);
  if (!trades.data) return null;
  if (!trades.data.length) return <p className="text-sm text-slate-500">התוכנית מסומנת "נפתחה", אבל אין לה עסקה ביומן.</p>;
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      {trades.data.map((t) => (
        <Link key={t.id} to={`/trades/${t.id}`} className="rounded-lg bg-sky-500/10 px-3 py-1.5 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300">
          לעסקה ביומן ({TRADE_STATUS_LABELS[t.status]}
          {t.netPnl !== null && t.status === 'closed' ? (
            <>
              {' · '}
              <Money value={t.netPnl} currency={t.currency} colored />
            </>
          ) : null}
          ) ←
        </Link>
      ))}
    </div>
  );
}

function StatusActions({ status, onSet, onOpenTrade }: { status: PlanStatus; onSet: (s: PlanStatus) => void; onOpenTrade: () => void }) {
  const actions: Array<{ to: PlanStatus; label: string; primary?: boolean; danger?: boolean }> = {
    draft: [
      { to: 'ready' as const, label: 'סמן כמוכנה ✓', primary: true },
      { to: 'cancelled' as const, label: 'בטל', danger: true },
    ],
    ready: [
      { to: 'waiting' as const, label: 'ממתינה לטריגר ⏳', primary: true },
      { to: 'draft' as const, label: 'חזרה לטיוטה' },
      { to: 'cancelled' as const, label: 'בטל', danger: true },
    ],
    waiting: [
      { to: 'ready' as const, label: 'חזרה למוכנה' },
      { to: 'cancelled' as const, label: 'בטל', danger: true },
    ],
    opened: [],
    cancelled: [{ to: 'draft' as const, label: 'החזר לטיוטה' }],
    expired: [{ to: 'draft' as const, label: 'החזר לטיוטה (עדכן תוקף)' }],
  }[status];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {(status === 'ready' || status === 'waiting') && (
        <button className="btn-primary" onClick={onOpenTrade}>
          פתחתי את העסקה ▶
        </button>
      )}
      {actions.map((a) => (
        <button key={a.to} className={a.danger ? 'btn-danger' : a.primary && status === 'draft' ? 'btn-primary' : 'btn-ghost'} onClick={() => onSet(a.to)}>
          {a.label}
        </button>
      ))}
    </div>
  );
}

function SizingCard({
  form,
  setForm,
  entry,
  stop,
  riskError,
  onUnits,
}: {
  form: Form;
  setForm: React.Dispatch<React.SetStateAction<Form>>;
  entry: string | null;
  stop: string | null;
  riskError?: string;
  /** Suggested size (units, rounded to what the broker trades) for opening the trade. */
  onUnits?: (units: string | null) => void;
}) {
  const accounts = useAsync(() => api<Account[]>('/accounts'), []);
  const settings = useAsync(() => api<Settings>('/settings'), []);
  const fx = useAsync(() => api<FxSnapshot | null>('/fx'), []);
  // CFD (gold, oil, indices): the broker's contract spec decides the size.
  const spec = useAsync(() => (form.symbol ? api<InstrumentSpec | null>(`/instruments/spec?symbol=${encodeURIComponent(form.symbol)}`) : Promise.resolve(null)), [form.symbol]);
  const account = accounts.data?.find((a) => a.id === form.accountId) ?? null;
  const [broker, setBroker] = useState<BrokerSnapshot | null>(null);

  useEffect(() => {
    setBroker(null);
    if (!account?.integration?.enabled) return;
    api<BrokerSnapshot>(`/accounts/${account.id}/broker`)
      .then(setBroker)
      .catch(() => setBroker(null));
  }, [account?.id, account?.integration?.enabled]);

  const equity = broker?.equity ?? account?.balance ?? null;
  const rates = settings.data ? effectiveRates(fx.data ?? null, settings.data.rates).rates : null;
  const riskPct = normalizeDecInput(form.riskPct);

  const result =
    account && equity && entry && stop && riskPct && rates
      ? positionSize({ assetClass: form.assetClass, symbol: form.symbol, spec: spec.data, entry, stop, riskPct, equity, accountCurrency: account.baseCurrency, rates })
      : null;
  const units = result?.ok ? (result.value.amountK !== undefined ? String(Number(result.value.amountK) * 1000) : result.value.units) : null;
  useEffect(() => onUnits?.(units && Number(units) > 0 ? units : null), [units, onUnits]);
  const riskIls = result?.ok && account && rates ? convert(result.value.roundedRisk, account.baseCurrency, 'ILS', rates) : null;

  return (
    <div className="card space-y-3">
      <h2 className="font-semibold">גודל פוזיציה</h2>
      <Field label="חשבון">
        <select className="input" value={form.accountId} onChange={(e) => setForm((f) => ({ ...f, accountId: e.target.value }))}>
          <option value="">— בחר חשבון —</option>
          {accounts.data
            ?.filter((a) => !a.isArchived)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.baseCurrency})
              </option>
            ))}
        </select>
      </Field>
      <Field label="סיכון מהחשבון (%)" error={riskError}>
        <input className="input" dir="ltr" inputMode="decimal" value={form.riskPct} onChange={(e) => setForm((f) => ({ ...f, riskPct: e.target.value }))} />
      </Field>
      {account && equity && (
        <p className="text-xs text-slate-500">
          לפי {broker ? 'Equity חי מ-FXCM' : 'היתרה ביומן'}: <Money value={equity} currency={account.baseCurrency} />
        </p>
      )}
      {!account && <p className="text-xs text-slate-500">בחר חשבון כדי לחשב.</p>}
      {account && (!entry || !stop) && <p className="text-xs text-slate-500">מלא כניסה וסטופ תקינים כדי לחשב.</p>}
      {result && !result.ok && <p className="text-sm text-amber-600 dark:text-amber-400">{result.error}</p>}
      {result?.ok && account && (
        <dl className="space-y-1.5 text-sm">
          {result.value.pointValue !== undefined ? (
            <>
              <Row label="גודל (CFD)">
                <span className="text-lg font-bold">{result.value.units}</span> יחידות
              </Row>
              <Row label="שווי תזוזה של 1.0">
                <Money value={result.value.pointValue} currency={account.baseCurrency} /> ליחידה
              </Row>
              <Row label="מקור המפרט">FXCM {spec.data?.offer}</Row>
            </>
          ) : result.value.amountK !== undefined ? (
            <>
              <Row label="גודל (FXCM)">
                <span className="text-lg font-bold">{result.value.amountK}K</span>
              </Row>
              <Row label="לוטים">{result.value.lots}</Row>
              <Row label="מרחק סטופ">{result.value.pips} פיפס</Row>
              <Row label="ערך פיפ ללוט">
                <Money value={result.value.pipValuePerLot!} currency={account.baseCurrency} />
              </Row>
            </>
          ) : (
            <Row label="יחידות">
              <span className="text-lg font-bold">{result.value.units}</span>
            </Row>
          )}
          <Row label="סיכון בפועל">
            <Money value={result.value.roundedRisk} currency={account.baseCurrency} />
            {riskIls && account.baseCurrency !== 'ILS' && (
              <span className="text-slate-500">
                {' '}
                ≈ <Money value={riskIls} currency="ILS" />
              </span>
            )}
          </Row>
        </dl>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd dir="ltr" className="tabular-nums">
        {children}
      </dd>
    </div>
  );
}
