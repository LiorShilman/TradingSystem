import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ASSET_CLASSES, ASSET_CLASS_LABELS, DIRECTIONS, DIRECTION_LABELS, type Account, type AssetClass, type Direction, type Plan } from '@trading/shared';
import { SymbolInput } from '../components/SymbolInput';
import { ErrorBox, Field, PageTitle } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useActiveAccount } from '../lib/activeAccount';
import { useAsync } from '../lib/useAsync';

export function NewPlanPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const accounts = useAsync(() => api<Account[]>('/accounts'), []);
  const [symbol, setSymbol] = useState(params.get('symbol') ?? '');
  const [direction, setDirection] = useState<Direction>('long');
  const [assetClass, setAssetClass] = useState<AssetClass>('forex');
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { active: current } = useActiveAccount();
  const active = accounts.data?.filter((a) => !a.isArchived) ?? [];
  const chosen = accountId || current?.id || (active.length === 1 ? active[0]!.id : '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const p = await api<Plan>('/plans', { method: 'POST', body: { symbol, direction, assetClass, accountId: chosen || null } });
      navigate(`/plans/${p.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? (err.issues[0]?.message ?? err.message) : 'שגיאה');
    }
  }

  return (
    <div className="space-y-5">
      <PageTitle>תוכנית חדשה</PageTitle>
      <form onSubmit={submit} className="card grid gap-3 sm:grid-cols-2">
        <Field label="נכס">
          <SymbolInput value={symbol} onChange={setSymbol} autoFocus />
        </Field>
        <Field label="כיוון">
          <div className="flex gap-2">
            {DIRECTIONS.map((d) => (
              <button
                type="button"
                key={d}
                onClick={() => setDirection(d)}
                className={`btn flex-1 border ${direction === d ? (d === 'long' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-red-600 bg-red-600 text-white') : 'border-slate-300 dark:border-slate-700'}`}
              >
                {DIRECTION_LABELS[d]}
              </button>
            ))}
          </div>
        </Field>
        <Field label="סוג נכס">
          <select className="input" value={assetClass} onChange={(e) => setAssetClass(e.target.value as AssetClass)}>
            {ASSET_CLASSES.map((c) => (
              <option key={c} value={c}>
                {ASSET_CLASS_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="חשבון" hint="משמש לחישוב גודל הפוזיציה">
          <select className="input" value={chosen} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">— ללא —</option>
            {active.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.baseCurrency})
              </option>
            ))}
          </select>
        </Field>
        <div className="space-y-2 sm:col-span-2">
          <ErrorBox message={error} />
          <button className="btn-primary" disabled={!symbol.trim()}>
            צור טיוטה ←
          </button>
        </div>
      </form>
    </div>
  );
}
