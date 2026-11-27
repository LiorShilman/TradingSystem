import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { IDEA_STATUSES, IDEA_STATUS_LABELS, formatIsrael, nowUtcIso, type Idea, type IdeaStatus, type Screenshot } from '@trading/shared';
import { SymbolInput, TagsInput } from '../components/SymbolInput';
import { ErrorBox, PageTitle } from '../components/ui';
import { api, ApiError, uploadImage } from '../lib/api';
import { useAsync } from '../lib/useAsync';

type Filter = 'open' | IdeaStatus;

export function IdeasPage() {
  const ideas = useAsync(() => api<Idea[]>('/ideas'), []);
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>('open');
  const showForm = params.get('new') === '1';

  const list = ideas.data ?? [];
  const now = nowUtcIso();
  const due = list.filter((i) => i.remindAt && i.remindAt <= now && (i.status === 'raw' || i.status === 'watching'));
  const shown = list.filter((i) => (filter === 'open' ? i.status !== 'dropped' : i.status === filter));

  return (
    <div className="space-y-5">
      <PageTitle
        actions={
          <button className="btn-primary" onClick={() => setParams(showForm ? {} : { new: '1' })} type="button">
            {showForm ? 'סגור' : '+ רעיון'}
          </button>
        }
      >
        רעיונות
      </PageTitle>

      {showForm && (
        <QuickIdea
          initialSymbol={params.get('symbol') ?? ''}
          onCreated={() => {
            setParams({});
            void ideas.reload();
          }}
        />
      )}

      {due.length > 0 && (
        <div className="card border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40">
          <div className="mb-2 text-sm font-semibold">⏰ הגיע הזמן לחזור אליהם ({due.length})</div>
          <ul className="space-y-1 text-sm">
            {due.map((i) => (
              <li key={i.id}>
                <Link to={`/ideas/${i.id}`} className="hover:underline">
                  <span dir="ltr" className="font-medium">{i.symbol}</span> · {i.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-1">
        {(['open', ...IDEA_STATUSES] as Filter[]).map((f) => {
          const count = f === 'open' ? list.filter((i) => i.status !== 'dropped').length : list.filter((i) => i.status === f).length;
          return (
            <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-3 py-1 text-sm ${filter === f ? 'bg-sky-600 text-white' : 'bg-slate-200 dark:bg-slate-800'}`}>
              {f === 'open' ? 'פתוחים' : IDEA_STATUS_LABELS[f]} ({count})
            </button>
          );
        })}
      </div>

      <ErrorBox message={ideas.error} />
      {ideas.loading && !ideas.data && <p className="text-sm text-slate-500">טוען…</p>}
      {ideas.data && shown.length === 0 && <p className="text-sm text-slate-500">אין רעיונות כאן. רעיון נרשם בשנייה — לחץ "+ רעיון".</p>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {shown.map((i) => (
          <Link key={i.id} to={`/ideas/${i.id}`} className="card block space-y-2 transition hover:border-sky-400">
            <div className="flex items-start justify-between gap-2">
              <span dir="ltr" className="font-semibold">{i.symbol}</span>
              <StatusPill status={i.status} />
            </div>
            <p className="text-sm">{i.title}</p>
            <div className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
              {i.tags.map((t) => (
                <span key={t} className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">
                  {t}
                </span>
              ))}
              <span className="ms-auto" dir="ltr">{formatIsrael(i.updatedAt, 'dd/MM HH:mm')}</span>
            </div>
            {i.planId && <div className="text-xs text-sky-600">→ יש תוכנית</div>}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: IdeaStatus }) {
  const color: Record<IdeaStatus, string> = {
    raw: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
    watching: 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200',
    ready: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
    dropped: 'bg-slate-100 text-slate-500 line-through dark:bg-slate-800',
  };
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${color[status]}`}>{IDEA_STATUS_LABELS[status]}</span>;
}

/** Capture in seconds: symbol, one line, tags, and optionally a pasted chart. */
function QuickIdea({ onCreated, initialSymbol }: { onCreated: () => void; initialSymbol: string }) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [images, setImages] = useState<File[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => !!f);
      if (files.length) {
        e.preventDefault();
        setImages((l) => [...l, ...files]);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const idea = await api<Idea>('/ideas', { method: 'POST', body: { symbol, title, tags } });
      for (const f of images) {
        await uploadImage<Screenshot>(`/screenshots?parentKind=idea&parentId=${idea.id}&phase=before&symbol=${encodeURIComponent(idea.symbol)}`, f);
      }
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? (e.issues[0]?.message ?? e.message) : 'שגיאה');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-3">
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <label className="block space-y-1">
          <span className="text-sm font-medium">נכס</span>
          <SymbolInput value={symbol} onChange={setSymbol} autoFocus />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">הרעיון במשפט אחד</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="למשל: בדיקה חוזרת של 1.0850 אחרי פריצה" />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">תגיות</span>
        <TagsInput value={tags} onChange={setTags} />
      </label>
      <p className="text-xs text-slate-500">
        {images.length ? `📎 ${images.length} צילומים יצורפו` : 'אפשר להדביק צילום גרף עם Ctrl+V. קישור TradingView מוסיפים בדף הרעיון.'}
      </p>
      <ErrorBox message={err} />
      <button className="btn-primary" disabled={busy || !symbol.trim() || !title.trim()}>
        {busy ? 'שומר…' : 'שמור רעיון'}
      </button>
    </form>
  );
}
