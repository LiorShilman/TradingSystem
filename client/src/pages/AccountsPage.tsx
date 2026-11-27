import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  ACCOUNT_KINDS,
  ACCOUNT_KIND_LABELS,
  CURRENCIES,
  convert,
  effectiveRates,
  portfolioTotal,
  type Account,
  type AccountKind,
  type Currency,
  type FxSnapshot,
  type Settings,
} from '@trading/shared';
import { ErrorBox, Field, Money, PageTitle } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { fxSourceLabel } from '../lib/fx';
import { useAsync } from '../lib/useAsync';

export function AccountsPage() {
  const accounts = useAsync(() => api<Account[]>('/accounts'), []);
  const settings = useAsync(() => api<Settings>('/settings'), []);
  const fx = useAsync(() => api<FxSnapshot | null>('/fx'), []);
  const [showForm, setShowForm] = useState(false);

  const active = accounts.data?.filter((a) => !a.isArchived) ?? [];
  const archived = accounts.data?.filter((a) => a.isArchived) ?? [];
  const eff = settings.data && !fx.loading ? effectiveRates(fx.data, settings.data.rates) : null;
  const total = accounts.data && settings.data && eff ? portfolioTotal(accounts.data, settings.data.displayCurrency, eff.rates) : null;
  const demos = active.filter((a) => a.kind === 'demo');
  const usesManual = !!eff && active.some((a) => eff.origin[a.baseCurrency] === 'manual' || eff.origin[settings.data!.displayCurrency] === 'manual');

  return (
    <div className="space-y-6">
      <PageTitle actions={<button className="btn-primary" onClick={() => setShowForm((s) => !s)}>{showForm ? 'סגור' : '+ חשבון חדש'}</button>}>
        חשבונות
      </PageTitle>

      {showForm && (
        <NewAccountForm
          onCreated={() => {
            setShowForm(false);
            void accounts.reload();
          }}
        />
      )}

      {total && settings.data && (
        <div className="card">
          <div className="text-sm text-slate-500">סך התיק</div>
          {total.total !== null ? (
            <>
              <div className="text-2xl font-bold">
                <Money value={total.total} currency={settings.data.displayCurrency} />
              </div>
              {demos.length > 0 && (
                <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">לא כולל {demos.length === 1 ? 'חשבון דמו' : `{demos.length} חשבונות דמו`} — הם לא כסף אמיתי</div>
              )}
              {eff && (
                <div className="mt-2 space-y-0.5 text-xs text-slate-500">
                  {[...new Set([...active.map((a) => a.baseCurrency), settings.data.displayCurrency])]
                    .filter((c) => c !== 'USD' && eff.rates[c])
                    .map((c) => (
                      <div key={c}>
                        <span dir="ltr" className="font-medium text-slate-700 tabular-nums dark:text-slate-300">
                          1$ = {eff.rates[c]} {c}
                        </span>
                        {' · '}
                        {eff.origin[c] === 'manual' ? 'ידני' : fx.data ? fxSourceLabel(fx.data) : ''}
                      </div>
                    ))}
                  {usesManual && <div>כולל שער ידני</div>}
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-amber-600 dark:text-amber-400">
              חסר שער המרה עבור {total.missing.join(', ')}. אפשר להזין אותו ב<Link className="underline" to="/settings">הגדרות</Link>.
            </div>
          )}
        </div>
      )}

      <ErrorBox message={accounts.error} />
      {accounts.loading && !accounts.data && <p className="text-sm text-slate-500">טוען…</p>}
      {accounts.data?.length === 0 && <p className="text-sm text-slate-500">עדיין אין חשבונות. צור את הראשון.</p>}

      <AccountGrid list={active} display={settings.data?.displayCurrency} rates={eff?.rates} />
      {archived.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-slate-500">ארכיון ({archived.length})</summary>
          <div className="mt-3 opacity-70">
            <AccountGrid list={archived} display={settings.data?.displayCurrency} rates={eff?.rates} />
          </div>
        </details>
      )}
    </div>
  );
}

function AccountGrid({ list, display, rates }: { list: Account[]; display?: Currency; rates?: Settings['rates'] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {list.map((a) => (
        <Link key={a.id} to={`/accounts/${a.id}`} className="card block transition hover:border-sky-400">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold">{a.name}</div>
              <div className="text-xs text-slate-500">
                {ACCOUNT_KIND_LABELS[a.kind]}
                {a.broker && ` · ${a.broker}`}
              </div>
            </div>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800">{a.baseCurrency}</span>
          </div>
          <div className="mt-3 text-lg font-bold">
            <Money value={a.balance} currency={a.baseCurrency} />
          </div>
          {(() => {
            // The same balance in the display currency (₪), so accounts in different currencies compare at a glance.
            if (!display || !rates || display === a.baseCurrency) return null;
            const v = convert(a.balance, a.baseCurrency, display, rates);
            return v === null ? (
              <div className="text-xs text-amber-600">חסר שער ל-{a.baseCurrency}</div>
            ) : (
              <div className="text-sm text-slate-500">
                ≈ <Money value={v} currency={display} />
              </div>
            );
          })()}
          {a.kind === 'demo' && !a.isArchived && <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">דמו — לא נספר בסך התיק</div>}
        </Link>
      ))}
    </div>
  );
}

function NewAccountForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AccountKind>('stocks');
  const [broker, setBroker] = useState('');
  const [baseCurrency, setCurrency] = useState<Currency>('USD');
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/accounts', { method: 'POST', body: { name, kind, broker, baseCurrency } });
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'שגיאה'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card grid gap-3 sm:grid-cols-2">
      <Field label="שם החשבון" error={err?.field('name')}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="למשל: IBKR מניות" autoFocus />
      </Field>
      <Field label="סוג">
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}>
          {ACCOUNT_KINDS.map((k) => (
            <option key={k} value={k}>
              {ACCOUNT_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="ברוקר / בורסה">
        <input className="input" value={broker} onChange={(e) => setBroker(e.target.value)} />
      </Field>
      <Field label="מטבע בסיס" hint="לא ניתן לשנות אחרי היצירה">
        <select className="input" value={baseCurrency} onChange={(e) => setCurrency(e.target.value as Currency)}>
          {CURRENCIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
      <div className="sm:col-span-2 space-y-2">
        <ErrorBox message={err && !err.issues.length ? err.message : null} />
        <button className="btn-primary" disabled={busy}>
          {busy ? 'שומר…' : 'צור חשבון'}
        </button>
      </div>
    </form>
  );
}
