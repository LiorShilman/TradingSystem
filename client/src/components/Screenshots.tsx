import { useCallback, useEffect, useRef, useState } from 'react';
import { SHOT_PHASES, SHOT_PHASE_LABELS, formatIsrael, type ParentKind, type Screenshot, type ShotPhase } from '@trading/shared';
import { api, apiUrl, uploadImage } from '../lib/api';
import { ErrorBox } from './ui';

interface Props {
  /** Editable gallery attached to a parent… */
  parentKind?: ParentKind;
  parentId?: string;
  /** …or a read-only gallery of every screenshot of a symbol. */
  symbol?: string | null;
  readOnly?: boolean;
  /** Listen to Ctrl+V anywhere on the page (only one gallery per page should). */
  pasteTarget?: boolean;
  title?: string;
}

const isTvLink = (s: string) => /tradingview\.com\/x\/[A-Za-z0-9]+/i.test(s);

export function ScreenshotGallery({ parentKind, parentId, symbol = null, readOnly = false, pasteTarget = false, title = 'צילומי גרף' }: Props) {
  const [shots, setShots] = useState<Screenshot[]>([]);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<ShotPhase>('before');
  const [tvUrl, setTvUrl] = useState('');
  const [open, setOpen] = useState<Screenshot | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const editable = !readOnly && !!parentKind && !!parentId;

  const query = parentKind && parentId ? `parentKind=${parentKind}&parentId=${encodeURIComponent(parentId)}` : symbol ? `symbol=${encodeURIComponent(symbol)}` : '';

  const load = useCallback(async () => {
    if (!query) return;
    try {
      setShots(await api<Screenshot[]>(`/screenshots?${query}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const meta = () =>
    `parentKind=${parentKind}&parentId=${encodeURIComponent(parentId!)}&phase=${phase}` + (symbol ? `&symbol=${encodeURIComponent(symbol)}` : '');

  const uploadFiles = useCallback(
    async (files: Blob[]) => {
      if (!editable) return;
      setError(null);
      for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        setBusy((b) => b + 1);
        try {
          const s = await uploadImage<Screenshot>(`/screenshots?${meta()}`, f);
          setShots((list) => [s, ...list]);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'ההעלאה נכשלה');
        } finally {
          setBusy((b) => b - 1);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editable, parentKind, parentId, phase, symbol],
  );

  const addTvLink = useCallback(
    async (url: string) => {
      if (!editable) return;
      setError(null);
      setBusy((b) => b + 1);
      try {
        const s = await api<Screenshot>('/screenshots/tradingview', { method: 'POST', body: { url, parentKind, parentId, phase, symbol } });
        setShots((list) => [s, ...list]);
        setTvUrl('');
        if (!s.file) setError('הקישור נשמר, אבל לא הצלחתי להוריד עותק של התמונה.');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'שגיאה');
      } finally {
        setBusy((b) => b - 1);
      }
    },
    [editable, parentKind, parentId, phase, symbol],
  );

  // Ctrl+V: image from clipboard, or a TradingView snapshot link.
  useEffect(() => {
    if (!editable || !pasteTarget) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = [...(e.clipboardData?.items ?? [])];
      const images = items.filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => !!f);
      if (images.length) {
        e.preventDefault();
        void uploadFiles(images);
        return;
      }
      const text = e.clipboardData?.getData('text') ?? '';
      const target = e.target as HTMLElement | null;
      const inField = target?.closest('input, textarea, [contenteditable]');
      if (isTvLink(text) && !inField) {
        e.preventDefault();
        void addTvLink(text.trim());
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [editable, pasteTarget, uploadFiles, addTvLink]);

  async function patch(s: Screenshot, body: Partial<Pick<Screenshot, 'phase' | 'caption'>>) {
    try {
      const u = await api<Screenshot>(`/screenshots/${s.id}`, { method: 'PATCH', body });
      setShots((l) => l.map((x) => (x.id === s.id ? u : x)));
      if (open?.id === s.id) setOpen(u);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    }
  }

  async function remove(s: Screenshot) {
    if (!confirm('למחוק את הצילום?')) return;
    try {
      await api(`/screenshots/${s.id}`, { method: 'DELETE' });
      setShots((l) => l.filter((x) => x.id !== s.id));
      setOpen(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">
          {title} {shots.length > 0 && <span className="text-sm font-normal text-slate-500">({shots.length})</span>}
        </h3>
        {busy > 0 && <span className="text-xs text-slate-500">מעלה…</span>}
      </div>

      {editable && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const text = e.dataTransfer.getData('text');
            if (isTvLink(text)) void addTvLink(text.trim());
            else void uploadFiles([...e.dataTransfer.files]);
          }}
          className={`space-y-2 rounded-lg border-2 border-dashed p-3 text-sm transition ${drag ? 'border-sky-500 bg-sky-50 dark:bg-sky-950' : 'border-slate-300 dark:border-slate-700'}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-auto" value={phase} onChange={(e) => setPhase(e.target.value as ShotPhase)} aria-label="שלב">
              {SHOT_PHASES.map((p) => (
                <option key={p} value={p}>
                  {SHOT_PHASE_LABELS[p]}
                </option>
              ))}
            </select>
            <button type="button" className="btn-ghost px-3 py-1.5" onClick={() => fileRef.current?.click()}>
              📁 בחר קובץ
            </button>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void uploadFiles([...(e.target.files ?? [])])} />
            <span className="text-xs text-slate-500">{pasteTarget ? 'או Ctrl+V / גרירה לכאן' : 'או גרירה לכאן'}</span>
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (tvUrl.trim()) void addTvLink(tvUrl.trim());
            }}
          >
            <input className="input" dir="ltr" placeholder="קישור TradingView: https://www.tradingview.com/x/…" value={tvUrl} onChange={(e) => setTvUrl(e.target.value)} />
            <button className="btn-ghost shrink-0 px-3" disabled={!tvUrl.trim()}>
              הוסף
            </button>
          </form>
        </div>
      )}

      <ErrorBox message={error} />

      {shots.length === 0 ? (
        !editable && <p className="text-sm text-slate-500">אין צילומים.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {shots.map((s) => (
            <button key={s.id} type="button" onClick={() => setOpen(s)} className="group overflow-hidden rounded-lg border border-slate-200 bg-slate-100 text-right dark:border-slate-700 dark:bg-slate-800">
              {s.thumbUrl ? (
                <img src={apiUrl(s.thumbUrl)} alt={s.caption || 'צילום גרף'} loading="lazy" className="aspect-video w-full object-cover transition group-hover:opacity-90" />
              ) : (
                <div className="flex aspect-video items-center justify-center p-2 text-center text-xs text-slate-500">🔗 קישור TradingView בלבד</div>
              )}
              <div className="flex items-center justify-between gap-1 px-2 py-1 text-xs">
                <span className="truncate">{s.caption || SHOT_PHASE_LABELS[s.phase]}</span>
                <span className="shrink-0 text-slate-500" dir="ltr">
                  {formatIsrael(s.createdAt, 'dd/MM')}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {open && <Lightbox shot={open} editable={editable} onClose={() => setOpen(null)} onPatch={(b) => patch(open, b)} onDelete={() => remove(open)} />}
    </section>
  );
}

function Lightbox({
  shot,
  editable,
  onClose,
  onPatch,
  onDelete,
}: {
  shot: Screenshot;
  editable: boolean;
  onClose: () => void;
  onPatch: (b: Partial<Pick<Screenshot, 'phase' | 'caption'>>) => void;
  onDelete: () => void;
}) {
  const [caption, setCaption] = useState(shot.caption);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 p-2 sm:p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="flex min-h-0 flex-1 items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {shot.fullUrl ? (
          <img src={apiUrl(shot.fullUrl)} alt={shot.caption} className="max-h-full max-w-full object-contain" />
        ) : (
          <a href={shot.tvUrl ?? '#'} target="_blank" rel="noreferrer" className="text-sky-300 underline">
            פתח ב-TradingView
          </a>
        )}
      </div>
      <div className="mx-auto mt-2 flex w-full max-w-3xl flex-wrap items-center gap-2 text-sm text-white" onClick={(e) => e.stopPropagation()}>
        {editable ? (
          <>
            <select className="input w-auto text-slate-900" value={shot.phase} onChange={(e) => onPatch({ phase: e.target.value as ShotPhase })}>
              {SHOT_PHASES.map((p) => (
                <option key={p} value={p}>
                  {SHOT_PHASE_LABELS[p]}
                </option>
              ))}
            </select>
            <input
              className="input min-w-40 flex-1 text-slate-900"
              placeholder="כיתוב"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onBlur={() => caption !== shot.caption && onPatch({ caption })}
            />
          </>
        ) : (
          <span className="flex-1">
            {SHOT_PHASE_LABELS[shot.phase]} {shot.caption && `· ${shot.caption}`}
          </span>
        )}
        {shot.tvUrl && (
          <a href={shot.tvUrl} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
            פתח ב-TradingView ↗
          </a>
        )}
        {editable && (
          <button className="btn-danger px-3 py-1" onClick={onDelete}>
            מחק
          </button>
        )}
        <button className="btn-ghost border-white/30 px-3 py-1 text-white hover:bg-white/10" onClick={onClose}>
          סגור ✕
        </button>
      </div>
    </div>
  );
}
