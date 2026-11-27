import { useCallback, useEffect, useState } from 'react';
import { formatIsrael, type Note, type NoteParentKind } from '@trading/shared';
import { api } from '../lib/api';
import { ErrorBox } from './ui';

/** Dated analysis notes that build up over time. Ctrl+Enter adds. */
export function NotesTimeline({
  parentKind,
  parentId,
  symbol = null,
  title = 'ניתוחים והערות',
}: {
  parentKind: NoteParentKind;
  parentId: string;
  symbol?: string | null;
  title?: string;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setNotes(await api<Note[]>(`/notes?parentKind=${parentKind}&parentId=${encodeURIComponent(parentId)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    }
  }, [parentKind, parentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Notes added elsewhere on the page (e.g. the chart advisor's "save as note").
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener('notes:changed', onChanged);
    return () => window.removeEventListener('notes:changed', onChanged);
  }, [load]);

  async function add() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const n = await api<Note>('/notes', { method: 'POST', body: { parentKind, parentId, symbol, body: text } });
      setNotes((l) => [n, ...l]);
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    try {
      const n = await api<Note>(`/notes/${editing.id}`, { method: 'PATCH', body: { body: editing.body } });
      setNotes((l) => l.map((x) => (x.id === n.id ? n : x)));
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    }
  }

  async function remove(n: Note) {
    if (!confirm('למחוק את ההערה?')) return;
    try {
      await api(`/notes/${n.id}`, { method: 'DELETE' });
      setNotes((l) => l.filter((x) => x.id !== n.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="font-semibold">
        {title} {notes.length > 0 && <span className="text-sm font-normal text-slate-500">({notes.length})</span>}
      </h3>
      <div className="space-y-2">
        <textarea
          className="input min-h-20"
          placeholder="מה אתה רואה עכשיו? (Ctrl+Enter להוספה)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void add();
            }
          }}
        />
        <button className="btn-primary" onClick={add} disabled={busy || !text.trim()}>
          {busy ? 'מוסיף…' : 'הוסף הערה'}
        </button>
      </div>
      <ErrorBox message={error} />
      <ol className="relative space-y-3 border-r-2 border-slate-200 pr-4 dark:border-slate-700">
        {notes.map((n) => (
          <li key={n.id} className="relative">
            <span className="absolute -right-[1.4rem] top-1.5 size-2.5 rounded-full bg-sky-500" />
            <div className="mb-1 flex items-center gap-3 text-xs text-slate-500">
              <span dir="ltr">{formatIsrael(n.createdAt, 'dd/MM/yyyy HH:mm')}</span>
              {n.updatedAt !== n.createdAt && <span>(נערך)</span>}
              <button className="text-sky-600 hover:underline" onClick={() => setEditing({ id: n.id, body: n.body })}>
                עריכה
              </button>
              <button className="text-red-600 hover:underline" onClick={() => remove(n)}>
                מחיקה
              </button>
            </div>
            {editing?.id === n.id ? (
              <div className="space-y-2">
                <textarea className="input min-h-20" value={editing.body} onChange={(e) => setEditing({ id: n.id, body: e.target.value })} autoFocus />
                <div className="flex gap-2">
                  <button className="btn-primary px-3 py-1" onClick={saveEdit}>
                    שמור
                  </button>
                  <button className="btn-ghost px-3 py-1" onClick={() => setEditing(null)}>
                    ביטול
                  </button>
                </div>
              </div>
            ) : (
              <p className="whitespace-pre-wrap text-sm">{n.body}</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
