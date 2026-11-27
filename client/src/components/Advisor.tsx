import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatIsrael, type AdvisorSessionView, type NoteParentKind } from '@trading/shared';
import { api, ApiError } from '../lib/api';

interface Props {
  symbol: string;
  planId?: string | null;
  accountId?: string | null;
  /** Where "save as note" puts an answer. */
  noteParent: { kind: NoteParentKind; id: string };
}

interface Shot {
  url: string;
  mediaType: 'image/jpeg';
  data: string;
}

const MAX_SIDE = 1600;

/** Downscale to at most 1600px on the long side, JPEG — keeps the upload small and the model reads it fine. */
async function toShot(file: Blob): Promise<Shot> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('לא הצלחתי לקרוא את התמונה'));
      i.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return { url: dataUrl, mediaType: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- minimal markdown (headings, bullets, bold) — rendered as elements, never as HTML ----------
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let items: string[] = [];
  let ordered = false;
  const flush = () => {
    if (items.length) {
      const lis = items.map((b, i) => <li key={i}>{inline(b)}</li>);
      out.push(
        ordered ? (
          <ol key={`l${out.length}`} className="ms-5 list-decimal space-y-0.5">
            {lis}
          </ol>
        ) : (
          <ul key={`l${out.length}`} className="ms-5 list-disc space-y-0.5">
            {lis}
          </ul>
        ),
      );
      items = [];
    }
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      if (items.length && ordered !== !!numbered) flush();
      ordered = !!numbered;
      items.push(item[1]!);
      continue;
    }
    flush();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) out.push(<h4 key={out.length} className="mt-3 font-bold text-sky-700 first:mt-0 dark:text-sky-400">{inline(h[2]!)}</h4>);
    else if (line.trim()) out.push(<p key={out.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="space-y-1.5 text-sm leading-relaxed">{out}</div>;
}

// ---------- panel ----------
export function AdvisorButton(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn-ghost" onClick={() => setOpen(true)} title="ניתוח הגרף עם Claude לפני שליחת פקודות">
        🤖 התייעצות על הגרף
      </button>
      {/* Kept mounted after the first open, so closing the panel doesn't lose the conversation. */}
      <AdvisorPanel {...props} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function AdvisorPanel({ symbol, planId = null, accountId = null, noteParent, open, onClose }: Props & { open: boolean; onClose: () => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [session, setSession] = useState<AdvisorSessionView | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Set<number>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const lastQuestion = useRef('');

  useEffect(() => {
    if (open && enabled === null)
      api<{ enabled: boolean }>('/advisor/status')
        .then((s) => setEnabled(s.enabled))
        .catch(() => setEnabled(false));
  }, [open, enabled]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const addFile = useCallback(async (f: Blob) => {
    setError(null);
    try {
      setShot(await toShot(f));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה בתמונה');
    }
  }, []);

  // Ctrl+V while the panel is open: the image goes here, not to the page's screenshot gallery.
  useEffect(() => {
    if (!open || session) return;
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
      if (!file) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void addFile(file);
    };
    window.addEventListener('paste', onPaste, { capture: true });
    return () => window.removeEventListener('paste', onPaste, { capture: true });
  }, [open, session, addFile]);

  // Poll while the advisor is answering.
  useEffect(() => {
    if (session?.status !== 'thinking') return;
    const t = setInterval(async () => {
      try {
        const v = await api<AdvisorSessionView>(`/advisor/sessions/${session.id}`);
        setSession(v);
        if (v.status === 'error') {
          setError(v.error);
          setQuestion(lastQuestion.current); // the question was dropped — let it be sent again
        }
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'אין חיבור לשרת');
        if (e instanceof ApiError && e.status === 404) setSession(null);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [session?.id, session?.status]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [session?.turns.length, session?.partial]);

  async function send() {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    lastQuestion.current = q;
    try {
      // A failed first question leaves an empty session — start over with the same screenshot.
      const v =
        session && session.turns.length
          ? await api<AdvisorSessionView>(`/advisor/sessions/${session.id}/messages`, { method: 'POST', body: { question: q } })
          : await api<AdvisorSessionView>('/advisor/sessions', {
              method: 'POST',
              body: { symbol, planId, accountId, image: shot ? { mediaType: shot.mediaType, data: shot.data } : null, question: q },
            });
      setSession(v);
      setQuestion('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'שגיאה');
      if (e instanceof ApiError && e.status === 404) setSession(null);
    } finally {
      setBusy(false);
    }
  }

  async function saveNote(index: number) {
    if (!session) return;
    const answer = session.turns[index]!;
    const asked = session.turns[index - 1]?.text ?? '';
    const body = `🤖 התייעצות עם Claude · ${formatIsrael(answer.at)}\nשאלה: ${asked}\n\n${answer.text}`;
    try {
      await api('/notes', { method: 'POST', body: { parentKind: noteParent.kind, parentId: noteParent.id, symbol, body } });
      setSaved((s) => new Set(s).add(index));
      window.dispatchEvent(new Event('notes:changed'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'השמירה נכשלה');
    }
  }

  function reset() {
    setSession(null);
    setShot(null);
    setQuestion('');
    setError(null);
    setSaved(new Set());
  }

  if (!open) return null;
  const thinking = session?.status === 'thinking';
  const started = !!session?.turns.length;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside className="flex h-full w-full max-w-2xl flex-col bg-white shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h2 className="font-bold">
            🤖 התייעצות על <span dir="ltr">{symbol}</span>
          </h2>
          <span className="text-xs text-slate-500">Claude Opus 5.5 · דעה מנומקת, לא אות מסחר</span>
          <div className="ms-auto flex gap-2">
            {started && (
              <button className="btn-ghost px-3 py-1" onClick={reset} disabled={thinking}>
                שיחה חדשה
              </button>
            )}
            <button className="btn-ghost px-3 py-1" onClick={onClose} aria-label="סגור">
              ✕
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {enabled === false && (
            <p className="rounded-lg bg-amber-500/15 p-3 text-sm text-amber-800 dark:text-amber-300">היועץ לא מוגדר בשרת: חסר ANTHROPIC_API_KEY ב-server/.env.</p>
          )}

          {!started && (
            <div className="space-y-3">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                צרף צילום של הגרף כמו שאתה רואה אותו (עם הקווים והאזורים שלך) וכתוב מה אתה שוקל. המערכת מצרפת לבד נרות אמיתיים מ-FXCM, מחיר חי, התוכנית, החשבון והעסקאות שלך.
              </p>
              <div
                className="flex min-h-36 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-slate-300 p-3 text-sm text-slate-500 hover:border-sky-400 dark:border-slate-700"
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
                  if (f) void addFile(f);
                }}
              >
                {shot ? (
                  <div className="relative">
                    <img src={shot.url} alt="צילום הגרף" className="max-h-72 rounded-lg" />
                    <button
                      className="absolute end-1 top-1 rounded-full bg-black/60 px-2 text-white"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShot(null);
                      }}
                      aria-label="הסר צילום"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <span>📷 Ctrl+V להדבקת צילום · גרירה לכאן · או לחיצה לבחירת קובץ (לא חובה)</span>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void addFile(f);
                  e.target.value = '';
                }}
              />
            </div>
          )}

          {session?.turns.map((t, i) =>
            t.role === 'user' ? (
              <div key={i} className="space-y-1">
                <div className="ms-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-xl bg-sky-600 px-3 py-2 text-sm text-white">{t.text}</div>
                {i === 0 && session.included.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1">
                    {session.included.map((x) => (
                      <span key={x} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                        {x}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div key={i} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                <Markdown text={t.text} />
                <div className="mt-2 flex justify-end">
                  <button className="text-xs text-sky-600 hover:underline disabled:text-emerald-600 disabled:no-underline" onClick={() => saveNote(i)} disabled={saved.has(i)}>
                    {saved.has(i) ? 'נשמר בהערות ✓' : 'שמור כהערה'}
                  </button>
                </div>
              </div>
            ),
          )}

          {thinking && (
            <div className="rounded-xl border border-sky-200 p-3 dark:border-sky-900">
              {session.partial ? <Markdown text={session.partial} /> : <p className="animate-pulse text-sm text-slate-500">היועץ מנתח את הגרף והנתונים… (בדרך כלל חצי דקה עד דקה)</p>}
            </div>
          )}
          {error && <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-400">{error}</p>}
          <div ref={endRef} />
        </div>

        <footer className="space-y-2 border-t border-slate-200 p-3 dark:border-slate-800">
          <textarea
            className="input min-h-20 resize-y"
            placeholder={started ? 'שאלת המשך… (Ctrl+Enter לשליחה)' : 'מה אתה שוקל? למשל: שוקל לונג מ-3650, סטופ מתחת ל-3630. (Ctrl+Enter לשליחה)'}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
            }}
            disabled={enabled === false}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500">ההחלטה שלך — היועץ לא שולח פקודות.</span>
            <button className="btn-primary" onClick={send} disabled={busy || thinking || !question.trim() || enabled === false}>
              {thinking ? 'מנתח…' : started ? 'שלח' : 'נתח את הגרף'}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}
