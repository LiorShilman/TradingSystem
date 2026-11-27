import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ALERT_KIND_LABELS, formatIsrael, type AlertConfig, type AlertEvent, type AlertKind } from '@trading/shared';
import { ErrorBox, Field, PageTitle } from '../components/ui';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';

const KIND_STYLE: Record<AlertKind, string> = {
  plan_approach: 'bg-amber-400/15 text-amber-700 dark:text-amber-300',
  plan_zone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  plan_stop: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  level_cross: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  idea_reminder: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  plan_expiring: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  plan_expired: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
  tv_webhook: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
  trade_target: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  trade_stop_near: 'bg-amber-400/15 text-amber-700 dark:text-amber-300',
  trade_stop: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
};

export function AlertsPage() {
  const log = useAsync(() => api<AlertEvent[]>('/alerts?limit=300'), []);
  const [kind, setKind] = useState<AlertKind | 'all'>('all');

  // Refresh while the page is open.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && void log.reload(), 30_000);
    return () => clearInterval(t);
  }, [log.reload]);

  const list = (log.data ?? []).filter((a) => kind === 'all' || a.kind === kind);
  const kinds = [...new Set((log.data ?? []).map((a) => a.kind))];

  return (
    <div className="space-y-6">
      <PageTitle>התראות</PageTitle>
      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_30rem]">
        <section className="card min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">יומן התראות</h2>
            <div className="flex flex-wrap gap-1">
              {(['all', ...kinds] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`rounded-lg px-2.5 py-1 text-xs ${kind === k ? 'bg-sky-600 text-white' : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700'}`}
                >
                  {k === 'all' ? 'הכל' : ALERT_KIND_LABELS[k]}
                </button>
              ))}
            </div>
          </div>
          <ErrorBox message={log.error} />
          {log.data && list.length === 0 && <p className="text-sm text-slate-500">עדיין אין התראות. הן יופיעו כאן ובטלגרם.</p>}
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {list.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start gap-3 py-2.5">
                <span className="w-28 shrink-0 text-xs text-slate-500 tabular-nums" dir="ltr">
                  {formatIsrael(a.createdAt, 'dd/MM HH:mm:ss')}
                </span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${KIND_STYLE[a.kind]}`}>{ALERT_KIND_LABELS[a.kind]}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{a.title}</div>
                  {a.body && <div className="text-xs text-slate-500">{a.body}</div>}
                  <div className="mt-0.5 flex flex-wrap gap-3 text-xs">
                    {a.tradeId && (
                      <Link className="text-sky-600 hover:underline" to={`/trades/${a.tradeId}`}>
                        לעסקה
                      </Link>
                    )}
                    {a.planId && (
                      <Link className="text-sky-600 hover:underline" to={`/plans/${a.planId}`}>
                        לתוכנית
                      </Link>
                    )}
                    {a.ideaId && (
                      <Link className="text-sky-600 hover:underline" to={`/ideas/${a.ideaId}`}>
                        לרעיון
                      </Link>
                    )}
                    {a.symbol && (
                      <Link className="text-sky-600 hover:underline" dir="ltr" to={`/assets/${encodeURIComponent(a.symbol)}`}>
                        {a.symbol}
                      </Link>
                    )}
                  </div>
                </div>
                <span className={`shrink-0 text-xs ${a.delivered ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`} title={a.deliveryError ?? ''}>
                  {a.delivered ? '✓ נשלח לטלגרם' : `⚠ לא נשלח${a.deliveryError ? `: ${a.deliveryError}` : ''}`}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <div className="space-y-6 self-start">
          <AlertSettings />
          <WebhookSetup />
        </div>
      </div>
    </div>
  );
}

function AlertSettings() {
  const cfg = useAsync(() => api<AlertConfig>('/alerts/config'), []);
  const [c, setC] = useState<AlertConfig | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setC(cfg.data), [cfg.data]);
  if (!c) return <section className="card"><ErrorBox message={cfg.error} /></section>;

  async function save(next: AlertConfig) {
    setC(next);
    setError(null);
    setMsg(null);
    try {
      await api('/alerts/config', { method: 'PUT', body: next });
      setMsg('נשמר ✓');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    }
  }

  const toggle = (key: 'plans' | 'levels' | 'reminders' | 'trades', label: string, hint: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={c[key]} onChange={(e) => void save({ ...c, [key]: e.target.checked })} />
      <span>
        {label}
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
    </label>
  );

  return (
    <section className="card space-y-3">
      <h2 className="font-semibold">הגדרות התראות</h2>
      <ErrorBox message={error} />
      {toggle('plans', 'מחיר מול תוכניות', 'תוכניות "מוכנה" ו"ממתינה לטריגר": מתקרב לאזור, נכנס לאזור, סטופ לפני כניסה')}
      {toggle('trades', 'עסקאות פתוחות', 'מחיר הגיע ליעד, מתקרב לסטופ (הנוכחי), הגיע לסטופ')}
      {toggle('levels', 'חציית רמות מפתח 🔔', 'רמות שסימנת בפעמון בדף הנכס')}
      {toggle('reminders', 'תזכורות ותוקף', 'תזכורות לרעיונות, ותוכנית שעומדת לפוג (שעתיים לפני) או שפגה')}
      <Field label="מרחק 'מתקרב לאזור' (פיפס)" hint="ההתראה חוזרת רק אחרי שהמחיר התרחק פי 1.5 מהמרחק הזה">
        <input
          className="input w-28"
          type="number"
          min={1}
          max={500}
          dir="ltr"
          value={c.approachPips}
          onChange={(e) => setC({ ...c, approachPips: Number(e.target.value) })}
          onBlur={() => c.approachPips >= 1 && c.approachPips <= 500 && void save({ ...c, approachPips: Math.round(c.approachPips) })}
        />
      </Field>
      <p className="text-xs text-slate-500">
        מחירים חיים זמינים כרגע לצמדי מט"ח: מ-FXCM, ומ-TradingView לצמדים ש-FXCM לא מעדכן. התראה נשלחת רק כשהמחיר באמת זז ב-15 הדקות האחרונות — צמד "קפוא" לא מתריע.
      </p>
      {msg && <p className="text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}
    </section>
  );
}

interface WebhookInfo {
  configured: boolean;
  path: string;
  url: string | null;
  template: string | null;
}

export function WebhookSetup({ planId }: { planId?: string }) {
  const info = useAsync(() => api<WebhookInfo>(`/alerts/webhook${planId ? `?planId=${encodeURIComponent(planId)}` : ''}`), [planId]);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const w = info.data;

  return (
    <section className="card space-y-3">
      <h2 className="font-semibold">Webhook מ-TradingView</h2>
      <ErrorBox message={info.error} />
      {w && !w.configured && (
        <p className="text-sm text-slate-500">
          חסר <code dir="ltr">WEBHOOK_SECRET</code> ב-<code dir="ltr">server/.env</code> (הרץ <code dir="ltr">npm run gen:admin-key</code> והפעל מחדש את השרת).
        </p>
      )}
      {w?.configured && (
        <>
          <div className="text-sm">
            כתובת:{' '}
            {w.url ? (
              <code dir="ltr" className="break-all">{w.url}</code>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">
                עדיין לא נגיש מהאינטרנט — יופעל בפריסה לשרת הביתי (HTTPS, פורט 443). נתיב: <code dir="ltr">{w.path}</code>
              </span>
            )}
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span>תבנית להודעת ההתראה (שדה Message ב-TradingView){planId ? ' — מקושרת לתוכנית הזו' : ''}</span>
              <div className="flex gap-2">
                <button className="text-xs text-sky-600 hover:underline" onClick={() => setShown((s) => !s)}>
                  {shown ? 'הסתר' : 'הצג'}
                </button>
                <button
                  className="text-xs text-sky-600 hover:underline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(w.template!);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? 'הועתק ✓' : 'העתק'}
                </button>
              </div>
            </div>
            <pre dir="ltr" className="overflow-x-auto rounded-lg bg-slate-100 p-3 text-xs dark:bg-slate-800">
              {shown ? w.template : w.template!.replace(/"secret": "[^"]+"/, '"secret": "••••••••"')}
            </pre>
          </div>
          <ul className="list-disc space-y-1 pe-5 text-xs text-slate-500">
            <li>
              ה-secret נמצא בגוף ההודעה (TradingView לא מאפשר headers משלך) — אל תשתף את התבנית.
            </li>
            <li>webhooks ב-TradingView דורשים אימות דו-שלבי (2FA) פעיל בחשבון — כדאי לוודא.</li>
            <li>בלי planId, ההתראה מקושרת לכל התוכניות הפעילות של הסימול. ההתראה מוסיפה הערה לתוכנית, ולא משנה את הסטטוס שלה.</li>
          </ul>
        </>
      )}
    </section>
  );
}
