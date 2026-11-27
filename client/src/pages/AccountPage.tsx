import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ACCOUNT_KIND_LABELS,
  CASHFLOW_TYPES,
  CASHFLOW_TYPE_LABELS,
  cashflowAmountError,
  formatIsrael,
  israelLocalToUtcIso,
  normalizeDecInput,
  nowUtcIso,
  signedCashflow,
  decStr,
  utcIsoToIsraelLocal,
  type Account,
  type Cashflow,
  type CashflowType,
} from '@trading/shared';
import { BrokerSection } from '../components/BrokerSection';
import { ErrorBox, Field, Money, PageTitle } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';

export function AccountPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const account = useAsync(() => api<Account>(`/accounts/${id}`), [id]);
  const flows = useAsync(() => api<Cashflow[]>(`/cashflows?accountId=${encodeURIComponent(id)}`), [id]);
  const [editing, setEditing] = useState<Cashflow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = () => {
    void account.reload();
    void flows.reload();
  };

  if (account.error) return <ErrorBox message={account.error} />;
  const a = account.data;
  if (!a) return <p className="text-sm text-slate-500">טוען…</p>;

  async function toggleArchive() {
    if (!a) return;
    try {
      await api(`/accounts/${a.id}`, { method: 'PATCH', body: { isArchived: !a.isArchived } });
      void account.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'שגיאה');
    }
  }

  async function remove() {
    if (!a || !confirm(`למחוק את החשבון "${a.name}"?`)) return;
    try {
      await api(`/accounts/${a.id}`, { method: 'DELETE' });
      navigate('/accounts');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'שגיאה');
    }
  }

  async function removeFlow(f: Cashflow) {
    if (!confirm('למחוק את התנועה?')) return;
    try {
      await api(`/cashflows/${f.id}`, { method: 'DELETE' });
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'שגיאה');
    }
  }

  return (
    <div className="space-y-6">
      <Link to="/accounts" className="text-sm text-sky-600 hover:underline">
        → חזרה לחשבונות
      </Link>
      <PageTitle
        actions={
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={toggleArchive}>
              {a.isArchived ? 'החזר מארכיון' : 'העבר לארכיון'}
            </button>
            <button className="btn-danger" onClick={remove}>
              מחק
            </button>
          </div>
        }
      >
        {a.name} {a.isArchived && <span className="text-sm font-normal text-slate-500">(בארכיון)</span>}
      </PageTitle>
      <ErrorBox message={actionError} />

      <div className="card flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-sm text-slate-500">
            {ACCOUNT_KIND_LABELS[a.kind]}
            {a.broker && ` · ${a.broker}`} · {a.baseCurrency}
          </div>
          <div className="mt-1 text-3xl font-bold">
            <Money value={a.balance} currency={a.baseCurrency} />
          </div>
        </div>
        <div className="space-y-1 text-end text-xs text-slate-500">
          <div>יתרה = הפקדות + ריבית ± התאמות − משיכות − עמלות + רווח/הפסד נטו מעסקאות ביומן</div>
          <Link to={`/trades?account=${a.id}`} className="text-sky-600 hover:underline">
            העסקאות של החשבון ←
          </Link>
        </div>
      </div>

      <BrokerSection account={a} onChanged={() => void account.reload()} />

      <CashflowForm
        key={editing?.id ?? 'new'}
        account={a}
        editing={editing}
        onDone={() => {
          setEditing(null);
          refresh();
        }}
        onCancel={() => setEditing(null)}
      />

      <section className="space-y-2">
        <h2 className="font-semibold">תנועות</h2>
        <ErrorBox message={flows.error} />
        {flows.data?.length === 0 && <p className="text-sm text-slate-500">אין עדיין תנועות.</p>}
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {flows.data?.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div>
                <div className="text-sm font-medium">{CASHFLOW_TYPE_LABELS[f.type]}</div>
                <div className="text-xs text-slate-500">
                  <span dir="ltr">{formatIsrael(f.occurredAt)}</span>
                  {f.note && ` · ${f.note}`}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-semibold">
                  <Money value={decStr(signedCashflow(f.type, f.amount))} currency={f.currency} colored />
                </span>
                <button className="text-xs text-sky-600 hover:underline" onClick={() => setEditing(f)}>
                  עריכה
                </button>
                <button className="text-xs text-red-600 hover:underline" onClick={() => removeFlow(f)}>
                  מחיקה
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function CashflowForm({
  account,
  editing,
  onDone,
  onCancel,
}: {
  account: Account;
  editing: Cashflow | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<CashflowType>(editing?.type ?? 'deposit');
  const [amount, setAmount] = useState(editing?.amount ?? '');
  const [when, setWhen] = useState(utcIsoToIsraelLocal(editing?.occurredAt ?? nowUtcIso()));
  const [note, setNote] = useState(editing?.note ?? '');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    // Validate locally first — same rules as the server.
    const norm = normalizeDecInput(amount);
    const occurredAt = israelLocalToUtcIso(when);
    const next: Record<string, string | undefined> = {};
    if (norm === null) next.amount = amount.trim() ? 'מספר לא תקין' : 'חובה להזין סכום';
    else next.amount = cashflowAmountError(type, norm) ?? undefined;
    if (!occurredAt) next.occurredAt = 'תאריך לא תקין';
    setErrors(next);
    if (next.amount || next.occurredAt) return;

    setBusy(true);
    try {
      const body = { type, amount: norm, occurredAt, note };
      if (editing) await api(`/cashflows/${editing.id}`, { method: 'PATCH', body });
      else await api('/cashflows', { method: 'POST', body: { ...body, accountId: account.id } });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) setErrors({ amount: err.field('amount'), occurredAt: err.field('occurredAt') });
      else setFormError(err instanceof Error ? err.message : 'שגיאה');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-3">
      <h2 className="font-semibold">{editing ? 'עריכת תנועה' : 'תנועה חדשה'}</h2>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="סוג">
          <select className="input" value={type} onChange={(e) => setType(e.target.value as CashflowType)}>
            {CASHFLOW_TYPES.map((t) => (
              <option key={t} value={t}>
                {CASHFLOW_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`סכום (${account.baseCurrency})`} error={errors.amount} hint={type === 'adjustment' ? 'אפשר מספר שלילי' : undefined}>
          <input className="input" dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </Field>
        <Field label="תאריך ושעה (שעון ישראל)" error={errors.occurredAt}>
          <input className="input" dir="ltr" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <Field label="הערה">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <ErrorBox message={formError} />
      <div className="flex gap-2">
        <button className="btn-primary" disabled={busy}>
          {busy ? 'שומר…' : editing ? 'שמור שינויים' : 'הוסף'}
        </button>
        {editing && (
          <button type="button" className="btn-ghost" onClick={onCancel}>
            ביטול
          </button>
        )}
      </div>
    </form>
  );
}
