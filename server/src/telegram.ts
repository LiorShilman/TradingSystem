import type { Store } from './store/types';

/** One Bot API call. Injectable for tests. */
export type TelegramApi = (method: string, body?: Record<string, unknown>) => Promise<unknown>;

export function makeTelegramApi(token: string): TelegramApi {
  return async (method, body) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
    // Never include the URL (it contains the token) in errors.
    if (!j.ok) throw new Error(`Telegram: ${j.description ?? `HTTP ${res.status}`}`);
    return j.result;
  };
}

export interface TelegramLink {
  chatId: string;
  name: string;
  connectedAt: string;
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class Telegram {
  constructor(
    private api: TelegramApi | null,
    private store: Store,
  ) {}

  get configured() {
    return this.api !== null;
  }

  async botName(): Promise<string | null> {
    if (!this.api) return null;
    const me = (await this.api('getMe')) as { username?: string };
    return me.username ?? null;
  }

  /** Private chats that messaged the bot recently (they pressed Start / wrote to it). */
  async recentChats(): Promise<Array<{ id: string; name: string }>> {
    if (!this.api) return [];
    const updates = (await this.api('getUpdates', { allowed_updates: ['message'] })) as Array<{
      message?: { chat?: { id: number; type: string; first_name?: string; last_name?: string; username?: string } };
    }>;
    const map = new Map<string, string>();
    for (const u of updates) {
      const c = u.message?.chat;
      if (c?.type === 'private') map.set(String(c.id), [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || 'ללא שם');
    }
    return [...map].map(([id, name]) => ({ id, name }));
  }

  /** Send to the connected chat. Returns false (no throw) when not configured/connected. */
  async send(html: string): Promise<boolean> {
    if (!this.api) return false;
    const link = await this.store.telegram.get();
    if (!link) return false;
    await this.api('sendMessage', { chat_id: link.chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    return true;
  }
}
