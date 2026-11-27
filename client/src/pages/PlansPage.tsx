import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ACTIVE_PLAN_STATUSES,
  DIRECTION_LABELS,
  PLAN_STATUS_LABELS,
  formatIsrael,
  planMetrics,
  type Plan,
  type PlanStatus,
} from '@trading/shared';
import { ErrorBox, PageTitle } from '../components/ui';
import { api } from '../lib/api';
import { useQuotes, zoneDistance } from '../lib/plan';
import { useAsync } from '../lib/useAsync';

type Tab = 'active' | 'opened' | 'archive';
const TAB_STATUSES: Record<Tab, readonly PlanStatus[]> = {
  active: ACTIVE_PLAN_STATUSES,
  opened: ['opened'],
  archive: ['cancelled', 'expired'],
};
const TAB_LABELS: Record<Tab, string> = { active: 'פעילות', opened: 'נפתחו', archive: 'ארכיון' };
const STATUS_ORDER: PlanStatus[] = ['waiting', 'ready', 'draft', 'opened', 'expired', 'cancelled'];

export function PlansPage() {
  const plans = useAsync(() => api<Plan[]>('/plans'), []);
  const [tab, setTab] = useState<Tab>('active');
  const all = plans.data ?? [];
  const shown = all.filter((p) => TAB_STATUSES[tab].includes(p.status));
  const quotes = useQuotes(shown.map((p) => p.symbol));

  // Waiting → ready → draft; inside each, closest to the entry zone first (when there's a live price).
  const sorted = [...shown].sort((a, b) => {
    const s = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (s) return s;
    const da = quotes[a.symbol] ? zoneDistance(a, quotes[a.symbol]!.price)?.abs : undefined;
    const db = quotes[b.symbol] ? zoneDistance(b, quotes[b.symbol]!.price)?.abs : undefined;
    if (da && db) return da.cmp(db);
    if (da) return -1;
    if (db) return 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return (
    <div className="space-y-5">
      <PageTitle
        actions={
          <Link to="/plans/new" className="btn-primary">
            + תוכנית חדשה
          </Link>
        }
      >
        תוכניות עסקה
      </PageTitle>

      <div className="flex gap-1">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-full px-3 py-1 text-sm ${tab === t ? 'bg-sky-600 text-white' : 'bg-slate-200 dark:bg-slate-800'}`}>
            {TAB_LABELS[t]} ({all.filter((p) => TAB_STATUSES[t].includes(p.status)).length})
          </button>
        ))}
      </div>

      <ErrorBox message={plans.error} />
      {plans.loading && !plans.data && <p className="text-sm text-slate-500">טוען…</p>}
      {plans.data && sorted.length === 0 && (
        <p className="text-sm text-slate-500">
          אין תוכניות כאן. אפשר להתחיל מ<Link to="/ideas" className="underline">רעיון</Link> או ליצור תוכנית חדשה.
        </p>
      )}

      <div className="grid gap-2 2xl:grid-cols-2">
        {sorted.map((p) => {
          const m = planMetrics(p);
          const q = quotes[p.symbol];
          const dist = q ? zoneDistance(p, q.price) : null;
          return (
            <Link key={p.id} to={`/plans/${p.id}`} className="card flex flex-wrap items-center gap-x-6 gap-y-2 transition hover:border-sky-400">
              <div className="min-w-40">
                <div className="flex items-center gap-2">
                  <span dir="ltr" className="font-semibold">{p.symbol}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${p.direction === 'long' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'}`}>
                    {DIRECTION_LABELS[p.direction]}
                  </span>
                  {p.timeframe && <span className="text-xs text-slate-500">{p.timeframe}</span>}
                </div>
                <div className="text-xs text-slate-500">{PLAN_STATUS_LABELS[p.status]}</div>
              </div>
              <Cell label="כניסה" value={p.entryLow ? (p.entryHigh && p.entryHigh !== p.entryLow ? `${p.entryLow}–${p.entryHigh}` : p.entryLow) : '—'} />
              <Cell label="סטופ" value={p.stopLoss ?? '—'} />
              <Cell label="יעד 1" value={p.targets[0]?.price ?? '—'} />
              <Cell label="R ממוצע" value={m ? `${m.avgR}R` : '—'} />
              <div className="ms-auto text-left text-xs">
                {q && (
                  <div>
                    <span dir="ltr" className="font-medium">{q.price}</span>
                    {dist && <div className={dist.inZone ? 'font-semibold text-amber-600 dark:text-amber-400' : 'text-slate-500'}>{dist.text}</div>}
                  </div>
                )}
                {p.expiresAt && <div className="text-slate-500">בתוקף עד <span dir="ltr">{formatIsrael(p.expiresAt, 'dd/MM HH:mm')}</span></div>}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-sm">
      <div className="text-xs text-slate-500">{label}</div>
      <div dir="ltr" className="text-right tabular-nums">{value}</div>
    </div>
  );
}
