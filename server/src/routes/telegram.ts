import { Router } from 'express';
import { nowUtcIso } from '@trading/shared';
import { z } from 'zod';
import { HttpError, parse } from '../http';
import type { Store } from '../store/types';
import { escapeHtml, type Telegram } from '../telegram';

const mask = (id: string) => `***${id.slice(-3)}`;

export function telegramRouter(store: Store, tg: Telegram) {
  const r = Router();

  const wrap = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : 'טלגרם לא זמין');
    }
  };

  r.get('/', async (_req, res) => {
    const link = await store.telegram.get();
    res.json({
      configured: tg.configured,
      bot: tg.configured ? await wrap(() => tg.botName()) : null,
      connected: link ? { name: link.name, chat: mask(link.chatId), connectedAt: link.connectedAt } : null,
    });
  });

  // Chats that wrote to the bot — the user picks theirs.
  r.post('/detect', async (_req, res) => {
    if (!tg.configured) throw new HttpError(409, 'אין TELEGRAM_BOT_TOKEN ב-server/.env');
    const chats = await wrap(() => tg.recentChats());
    res.json(chats.map((c) => ({ ...c, label: `${c.name} (${mask(c.id)})` })));
  });

  r.post('/connect', async (req, res) => {
    const { chatId } = parse(z.object({ chatId: z.string().regex(/^-?\d+$/) }), req.body);
    // Only a chat that actually wrote to the bot can be linked.
    const chat = (await wrap(() => tg.recentChats())).find((c) => c.id === chatId);
    if (!chat) throw new HttpError(400, 'הצ׳אט הזה לא כתב לבוט. שלח לבוט /start ונסה שוב.');
    await store.telegram.set({ chatId, name: chat.name, connectedAt: nowUtcIso() });
    await wrap(() => tg.send(`✅ <b>מערכת המסחר מחוברת</b>\nמעכשיו התראות יגיעו לכאן, ${escapeHtml(chat.name)}.`));
    res.json({ ok: true });
  });

  r.post('/test', async (_req, res) => {
    const sent = await wrap(() => tg.send('🔔 הודעת בדיקה ממערכת המסחר. אם אתה רואה את זה — הכל עובד.'));
    if (!sent) throw new HttpError(409, 'טלגרם לא מחובר');
    res.json({ ok: true });
  });

  r.delete('/', async (_req, res) => {
    await store.telegram.set(null);
    res.status(204).end();
  });

  return r;
}
