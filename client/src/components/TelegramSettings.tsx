import { useState } from 'react';
import { formatIsrael } from '@trading/shared';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { ErrorBox } from './ui';

interface Status {
  configured: boolean;
  bot: string | null;
  connected: { name: string; chat: string; connectedAt: string } | null;
}

export function TelegramSettings() {
  const status = useAsync(() => api<Status>('/telegram'), []);
  const [chats, setChats] = useState<Array<{ id: string; label: string }> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    } finally {
      setBusy(false);
    }
  }

  const detect = () =>
    run(async () => {
      const list = await api<Array<{ id: string; label: string }>>('/telegram/detect', { method: 'POST' });
      setChats(list);
      if (!list.length) setError('הבוט לא קיבל הודעות. פתח אותו בטלגרם, לחץ Start (או שלח "שלום"), ונסה שוב.');
    });

  const connect = (chatId: string) =>
    run(async () => {
      await api('/telegram/connect', { method: 'POST', body: { chatId } });
      setChats(null);
      setMsg('מחובר ✓ — נשלחה הודעה לטלגרם');
      await status.reload();
    });

  const s = status.data;

  return (
    <section className="card space-y-3">
      <h2 className="font-semibold">התראות טלגרם</h2>
      <ErrorBox message={status.error ?? error} />
      {s && !s.configured && (
        <p className="text-sm text-slate-500">
          חסר <code dir="ltr">TELEGRAM_BOT_TOKEN</code> בקובץ <code dir="ltr">server/.env</code>. אחרי שמוסיפים — צריך להפעיל מחדש את השרת.
        </p>
      )}
      {s?.configured && (
        <>
          <p className="text-sm">
            בוט: <a className="text-sky-600 hover:underline" dir="ltr" href={`https://t.me/${s.bot}`} target="_blank" rel="noreferrer">@{s.bot}</a>
          </p>
          {s.connected ? (
            <div className="space-y-2">
              <p className="text-sm text-emerald-600 dark:text-emerald-400">
                ✓ מחובר ל-{s.connected.name} <span dir="ltr">({s.connected.chat})</span> · מאז <span dir="ltr">{formatIsrael(s.connected.connectedAt, 'dd/MM/yyyy')}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                <button className="btn-ghost" disabled={busy} onClick={() => run(async () => { await api('/telegram/test', { method: 'POST' }); setMsg('נשלחה הודעת בדיקה ✓'); })}>
                  שלח הודעת בדיקה
                </button>
                <button className="btn-danger" disabled={busy} onClick={() => confirm('לנתק את טלגרם?') && run(async () => { await api('/telegram', { method: 'DELETE' }); await status.reload(); })}>
                  נתק
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <ol className="list-decimal space-y-1 pe-5 text-sm text-slate-600 dark:text-slate-300">
                <li>
                  פתח את <a className="text-sky-600 hover:underline" dir="ltr" href={`https://t.me/${s.bot}`} target="_blank" rel="noreferrer">@{s.bot}</a> בטלגרם ולחץ <b>Start</b>.
                </li>
                <li>לחץ כאן "חפש את הצ׳אט שלי" ובחר את עצמך.</li>
              </ol>
              <button className="btn-primary" disabled={busy} onClick={detect}>
                {busy ? 'מחפש…' : 'חפש את הצ׳אט שלי'}
              </button>
              {chats && chats.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {chats.map((c) => (
                    <button key={c.id} className="btn-ghost" disabled={busy} onClick={() => connect(c.id)}>
                      חבר: {c.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {msg && <p className="text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}
    </section>
  );
}
