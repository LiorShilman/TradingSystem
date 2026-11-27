import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { alertConfigSchema, tvWebhookSchema, tvWebhookTemplate } from '@trading/shared';
import { z } from 'zod';
import type { AlertEngine } from '../alerts';
import { parse } from '../http';
import type { Store } from '../store/types';

export const WEBHOOK_PATH = '/webhooks/tradingview';

/** Admin: alert log, settings, webhook setup info. */
export function alertsRouter(store: Store, engine: AlertEngine, webhook: { secret: string | null; publicUrl: string | null }) {
  const r = Router();

  r.get('/', async (req, res) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
    const list = await store.alerts.list();
    res.json(list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  });

  r.get('/config', async (_req, res) => {
    res.json(await engine.getConfig());
  });

  r.put('/config', async (req, res) => {
    const c = parse(alertConfigSchema, req.body);
    await store.alertConfig.set(c);
    engine.invalidate();
    res.json(c);
  });

  // Everything needed to set up a TradingView alert. Contains the secret: admin-only by design.
  r.get('/webhook', (req, res) => {
    const planId = typeof req.query.planId === 'string' ? req.query.planId.slice(0, 100) : undefined;
    res.json({
      configured: !!webhook.secret,
      path: `/api${WEBHOOK_PATH}`,
      url: webhook.publicUrl ? `${webhook.publicUrl.replace(/\/$/, '')}/api${WEBHOOK_PATH}` : null,
      template: webhook.secret ? tvWebhookTemplate(webhook.secret, planId) : null,
    });
  });

  return r;
}

/**
 * Public TradingView webhook. TradingView can't send custom headers, so the secret is in the body.
 * Replies immediately (TradingView gives up after a few seconds) and processes afterwards.
 */
export function webhookRouter(engine: AlertEngine, secret: string | null) {
  const r = Router();
  const expected = secret ? createHash('sha256').update(secret).digest() : null;
  let windowStart = 0;
  let count = 0;

  // TradingView sends application/json when the message is valid JSON, text/plain otherwise.
  r.post(WEBHOOK_PATH, express.text({ type: '*/*', limit: '16kb' }), (req, res) => {
    if (!expected) {
      res.status(503).json({ error: 'webhook not configured' });
      return;
    }
    const now = Date.now();
    if (now - windowStart > 60_000) {
      windowStart = now;
      count = 0;
    }
    if (++count > 60) {
      res.status(429).json({ error: 'too many requests' });
      return;
    }
    // application/json was already parsed by the app-level JSON parser; text/plain arrives as a string.
    let body: unknown = req.body;
    try {
      if (typeof body === 'string') body = JSON.parse(body);
      else if (!body || typeof body !== 'object') throw new Error('empty');
    } catch {
      res.status(400).json({ error: 'body must be JSON' });
      return;
    }
    const parsed = tvWebhookSchema.safeParse(body);
    const given = createHash('sha256').update(parsed.success ? parsed.data.secret : '').digest();
    if (!parsed.success || !timingSafeEqual(given, expected)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json({ ok: true });
    const { secret: _s, ...rest } = parsed.data;
    setImmediate(() => void engine.handleWebhook(rest));
  });

  return r;
}
