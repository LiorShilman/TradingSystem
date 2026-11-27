import { useCallback, useEffect, useState } from 'react';
import { dec, decStr, formatIsrael, type Account, type BrokerSnapshot, type FxcmgrConfig } from '@trading/shared';
import { api, ApiError } from '../lib/api';
import { ErrorBox, Field, Money } from './ui';

const POLL_MS = 60_000;

/** Read-only broker link for one account: connect / switch on-off / edit / disconnect, plus live data. */
export function BrokerSection({ account, onChanged }: { account: Account; onChanged: () => void }) {
  const cfg = account.integration ?? null;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: FxcmgrConfig | null) {
    setError(null);
    try {
      await api(`/accounts/${account.id}`, { method: 'PATCH', body: { integration: next } });
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    }
  }

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">חיבור לברוקר</h2>
          <p className="text-xs text-slate-500">FXCMgr · קריאה בלבד — המערכת לא שולחת פקודות</p>
        </div>
        {cfg && !editing && (
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-sky-600" checked={cfg.enabled} onChange={(e) => save({ ...cfg, enabled: e.target.checked })} />
              {cfg.enabled ? 'פעיל' : 'כבוי'}
            </label>
            <button className="btn-ghost px-3 py-1" onClick={() => setEditing(true)}>
              הגדרות
            </button>
            <button className="btn-danger px-3 py-1" onClick={() => confirm('לנתק את החיבור לברוקר?') && save(null)}>
              נתק
            </button>
          </div>
        )}
      </div>
      <ErrorBox message={error} />

      {!cfg && !editing && (
        <button className="btn-ghost" onClick={() => setEditing(true)}>
          + חבר ל-FXCMgr
        </button>
      )}
      {editing && <ConnectForm initial={cfg} onSave={(c) => save(c)} onCancel={() => setEditing(false)} />}
      {cfg?.enabled && !editing && <LivePanel account={account} />}
    </section>
  );
}

function ConnectForm({ initial, onSave, onCancel }: { initial: FxcmgrConfig | null; onSave: (c: FxcmgrConfig) => void; onCancel: () => void }) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [hostHeader, setHost] = useState(initial?.hostHeader ?? '');
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldErr, setFieldErr] = useState<string | undefined>();

  useEffect(() => {
    if (initial) return;
    api<{ fxcmgrUrl: string; fxcmgrHost: string }>('/integrations/fxcmgr/defaults')
      .then((d) => {
        setBaseUrl((v) => v || d.fxcmgrUrl);
        setHost((v) => v || d.fxcmgrHost);
      })
      .catch(() => undefined);
  }, [initial]);

  async function runTest() {
    setBusy(true);
    setTest(null);
    setFieldErr(undefined);
    try {
      const r = await api<{ equity: string; positions: number }>('/integrations/fxcmgr/test', { method: 'POST', body: { baseUrl, hostHeader } });
      setTest({ ok: true, text: `✓ מחובר · Equity ${r.equity} · ${r.positions} פוזיציות פתוחות` });
    } catch (e) {
      if (e instanceof ApiError && e.issues.length) setFieldErr(e.field('baseUrl'));
      else setTest({ ok: false, text: e instanceof Error ? e.message : 'החיבור נכשל' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="כתובת FXCMgr" error={fieldErr} hint="אותו מחשב: http://localhost:11000">
          <input className="input" dir="ltr" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </Field>
        <Field label="Host (אופציונלי)" hint="השם ש-FXCMgr רשום עליו, אם הוא לא מקבל localhost">
          <input className="input" dir="ltr" value={hostHeader} onChange={(e) => setHost(e.target.value)} />
        </Field>
      </div>
      {test && <p className={`text-sm ${test.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{test.text}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-ghost" onClick={runTest} disabled={busy || !baseUrl}>
          {busy ? 'בודק…' : 'בדוק חיבור'}
        </button>
        <button type="button" className="btn-primary" onClick={() => onSave({ kind: 'fxcmgr', enabled: initial?.enabled ?? true, baseUrl: baseUrl.trim(), hostHeader: hostHeader.trim() })} disabled={!baseUrl}>
          שמור
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          ביטול
        </button>
      </div>
    </div>
  );
}

function LivePanel({ account }: { account: Account }) {
  const [snap, setSnap] = useState<BrokerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSnap(await api<BrokerSnapshot>(`/accounts/${account.id}/broker`));
      setError(null);
    } catch (e) {
      setSnap(null); // never show stale numbers as current
      setError(e instanceof Error ? e.message : 'FXCMgr לא זמין');
    }
  }, [account.id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (error)
    return (
      <div className="space-y-2">
        <ErrorBox message={error} />
        <button className="btn-ghost px-3 py-1" onClick={load}>
          נסה שוב
        </button>
      </div>
    );
  if (!snap) return <p className="text-sm text-slate-500">מתחבר ל-FXCMgr…</p>;

  const cur = account.baseCurrency;
  const diff = decStr(dec(snap.balanceApprox).minus(dec(account.balance)));
  const matches = dec(diff).abs().lt(0.01);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Equity בברוקר">
          <Money value={snap.equity} currency={cur} />
        </Stat>
        <Stat label="רווח/הפסד יומי">
          <Money value={snap.dayPL} currency={cur} colored />
        </Stat>
        <Stat label="רווח/הפסד פתוח">
          <Money value={snap.openPL} currency={cur} colored />
        </Stat>
      </div>

      <div className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
        <div className="mb-2 font-medium">התאמה מול היומן</div>
        <div className="grid gap-1 sm:grid-cols-3">
          <div>
            יתרה לפי היומן: <Money value={account.balance} currency={cur} />
          </div>
          <div title="Equity פחות רווח/הפסד פתוח">
            יתרה בברוקר (משוערת): <Money value={snap.balanceApprox} currency={cur} />
          </div>
          <div className={matches ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
            {matches ? '✓ תואם' : <>הפרש: <Money value={diff} currency={cur} /></>}
          </div>
        </div>
        {!matches && <p className="mt-2 text-xs text-slate-500">הפרש אומר שיש הפקדה, משיכה או עסקה שלא תועדו ביומן. המערכת לא משנה את היומן לבד.</p>}
      </div>

      <div>
        <div className="mb-2 text-sm font-medium">פוזיציות פתוחות ({snap.positions.length})</div>
        {snap.positions.length === 0 ? (
          <p className="text-sm text-slate-500">אין פוזיציות פתוחות.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500">
                <tr className="text-right">
                  <th className="py-1 font-medium">נכס</th>
                  <th className="py-1 font-medium">כיוון</th>
                  <th className="py-1 font-medium">גודל</th>
                  <th className="py-1 font-medium">TP</th>
                  <th className="py-1 font-medium">רווח/הפסד</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {snap.positions.map((p, i) => (
                  <tr key={i}>
                    <td className="py-1.5" dir="ltr">{p.instrument}</td>
                    <td className="py-1.5">{p.direction === 'long' ? 'קנייה' : p.direction === 'short' ? 'מכירה' : '?'}</td>
                    <td className="py-1.5" dir="ltr">{p.amountK}K</td>
                    <td className="py-1.5" dir="ltr">{p.takeProfit ?? '—'}</td>
                    <td className="py-1.5">
                      <Money value={p.grossPL} currency={cur} colored />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          עודכן <span dir="ltr">{formatIsrael(snap.fetchedAt, 'HH:mm:ss')}</span> · מתרענן כל דקה
        </span>
        <button className="text-sky-600 hover:underline" onClick={load}>
          רענן
        </button>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg font-bold">{children}</div>
    </div>
  );
}
