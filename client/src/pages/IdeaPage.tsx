import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  IDEA_STATUSES,
  IDEA_STATUS_LABELS,
  israelLocalToUtcIso,
  utcIsoToIsraelLocal,
  type Idea,
  type IdeaStatus,
  type Plan,
} from '@trading/shared';
import { NotesTimeline } from '../components/Notes';
import { ScreenshotGallery } from '../components/Screenshots';
import { SymbolInput, TagsInput } from '../components/SymbolInput';
import { ErrorBox, Field } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { SaveIndicatorText, useAutosave } from '../lib/useAutosave';
import { useAsync } from '../lib/useAsync';

export function IdeaPage() {
  const { id = '' } = useParams();
  const idea = useAsync(() => api<Idea>(`/ideas/${id}`), [id]);
  if (idea.error) return <ErrorBox message={idea.error} />;
  if (!idea.data) return <p className="text-sm text-slate-500">טוען…</p>;
  return <IdeaEditor key={idea.data.id} idea={idea.data} />;
}

function IdeaEditor({ idea }: { idea: Idea }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    symbol: idea.symbol,
    title: idea.title,
    body: idea.body,
    tags: idea.tags,
    status: idea.status,
    dropReason: idea.dropReason,
    remind: idea.remindAt ? utcIsoToIsraelLocal(idea.remindAt) : '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const autosave = useAutosave(form, async (f) => {
    const remindAt = f.remind ? israelLocalToUtcIso(f.remind) : null;
    try {
      await api(`/ideas/${idea.id}`, {
        method: 'PATCH',
        body: { symbol: f.symbol, title: f.title, body: f.body, tags: f.tags, status: f.status, dropReason: f.dropReason, remindAt },
      });
    } catch (e) {
      if (e instanceof ApiError) throw new Error(e.details[0] ?? e.issues[0]?.message ?? e.message);
      throw e;
    }
  });

  useEffect(() => setError(null), [form]);

  async function toPlan() {
    try {
      const plan = await api<Plan>(`/ideas/${idea.id}/to-plan`, { method: 'POST' });
      navigate(`/plans/${plan.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    }
  }

  async function remove() {
    if (!confirm('למחוק את הרעיון, ההערות והצילומים שלו?')) return;
    await api(`/ideas/${idea.id}`, { method: 'DELETE' });
    navigate('/ideas');
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to="/ideas" className="text-sm text-sky-600 hover:underline">
          → כל הרעיונות
        </Link>
        <SaveIndicatorText {...autosave} />
      </div>

      <div className="card space-y-4">
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <Field label="נכס">
            <SymbolInput value={form.symbol} onChange={(v) => set('symbol', v)} />
          </Field>
          <Field label="הרעיון">
            <input className="input" value={form.title} onChange={(e) => set('title', e.target.value)} />
          </Field>
        </div>
        <Field label="פירוט">
          <textarea className="input min-h-24" value={form.body} onChange={(e) => set('body', e.target.value)} placeholder="מה ראית, למה זה מעניין, מה צריך לקרות" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="סטטוס">
            <select className="input" value={form.status} onChange={(e) => set('status', e.target.value as IdeaStatus)}>
              {IDEA_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {IDEA_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="תזכורת לחזור (שעון ישראל)">
            <input className="input" type="datetime-local" dir="ltr" value={form.remind} onChange={(e) => set('remind', e.target.value)} />
          </Field>
          <Field label="תגיות">
            <TagsInput value={form.tags} onChange={(v) => set('tags', v)} />
          </Field>
        </div>
        {form.status === 'dropped' && (
          <Field label="למה נזנח?">
            <input className="input" value={form.dropReason} onChange={(e) => set('dropReason', e.target.value)} placeholder="למשל: המחיר ברח בלי בדיקה חוזרת" />
          </Field>
        )}
        <ErrorBox message={error} />
        <div className="flex flex-wrap gap-2">
          {idea.planId ? (
            <Link to={`/plans/${idea.planId}`} className="btn-primary">
              פתח את התוכנית ←
            </Link>
          ) : (
            <button className="btn-primary" onClick={toPlan}>
              הפוך לתוכנית עסקה ←
            </button>
          )}
          <Link to={`/assets/${encodeURIComponent(form.symbol)}`} className="btn-ghost">
            דף הנכס
          </Link>
          <button className="btn-danger" onClick={remove}>
            מחק
          </button>
        </div>
      </div>

      <div className="card">
        <ScreenshotGallery parentKind="idea" parentId={idea.id} symbol={form.symbol} pasteTarget />
      </div>
      <div className="card">
        <NotesTimeline parentKind="idea" parentId={idea.id} symbol={form.symbol} />
      </div>
    </div>
  );
}
