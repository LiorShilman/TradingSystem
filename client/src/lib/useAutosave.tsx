import { useEffect, useRef, useState } from 'react';

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

/**
 * Saves `value` ~1.5s after the last change. A pending save is flushed when the
 * component unmounts, so navigating away right after typing doesn't lose it.
 * `save` may throw to report an error (e.g. an invalid field) — nothing is lost, it retries on the next change.
 */
export function useAutosave<T>(value: T, save: (v: T) => Promise<void>, delay = 1500) {
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const pending = useRef<{ v: T } | null>(null);
  const first = useRef(true);
  const json = JSON.stringify(value);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    pending.current = { v: value };
    setState('pending');
    const t = setTimeout(async () => {
      const p = pending.current;
      pending.current = null;
      if (!p) return;
      setState('saving');
      try {
        await saveRef.current(p.v);
        setState('saved');
        setError(null);
      } catch (e) {
        setState('error');
        setError(e instanceof Error ? e.message : 'השמירה נכשלה');
      }
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [json]);

  useEffect(
    () => () => {
      if (pending.current) void saveRef.current(pending.current.v).catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pending.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  return { state, error };
}

export function SaveIndicatorText({ state, error }: { state: SaveState; error: string | null }) {
  const text = { idle: '', pending: 'שינויים לא נשמרו…', saving: 'שומר…', saved: 'נשמר ✓', error: error ?? 'השמירה נכשלה' }[state];
  const color = state === 'error' ? 'text-red-600 dark:text-red-400' : state === 'saved' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500';
  return <span className={`text-xs ${color}`}>{text}</span>;
}
