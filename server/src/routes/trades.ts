import { Router } from 'express';
import {
  DEFAULT_SETTINGS,
  effectiveRates,
  normalizeSymbol,
  nowUtcIso,
  parentKey,
  tradeCreateSchema,
  tradeDerived,
  tradeIssues,
  tradePatchSchema,
  withComputedPnl,
  type Currency,
  type Settings,
  type Trade,
  type TradeInput,
} from '@trading/shared';
import type { FileStore } from '../files';
import { HttpError, notFound, parse } from '../http';
import type { Store } from '../store/types';
import type { SpecHub } from '../specs';
import { recomputeBalance } from './cashflows';

export async function currentRates(store: Store): Promise<Settings['rates']> {
  const [settings, fx] = await Promise.all([store.settings.get(), store.fx.get()]);
  return effectiveRates(fx, (settings ?? DEFAULT_SETTINGS).rates).rates;
}

/** Open trades first (newest opened), then closed (newest closed). */
const tradeOrder = (a: Trade, b: Trade) =>
  a.status !== b.status ? (a.status === 'open' ? -1 : 1) : (b.closedAt ?? b.openedAt).localeCompare(a.closedAt ?? a.openedAt);

export function tradesRouter(store: Store, files: FileStore, specs?: SpecHub) {
  const r = Router();

  /** Validate, compute exit P&L at today's rates (unless entered by hand) and the derived fields. */
  async function prepare(input: TradeInput, currency: Currency): Promise<TradeInput & ReturnType<typeof tradeDerived>> {
    const issues = tradeIssues(input);
    if (issues.length) throw new HttpError(409, issues.join(' · '), issues);
    const computed = withComputedPnl(input, currency, await currentRates(store));
    return { ...computed, ...tradeDerived(computed) };
  }

  r.get('/', async (req, res) => {
    const q = req.query;
    let list: Trade[];
    if (typeof q.planId === 'string') list = await store.trades.list({ field: 'planId', value: q.planId });
    else if (typeof q.accountId === 'string') list = await store.trades.list({ field: 'accountId', value: q.accountId });
    else if (typeof q.symbol === 'string') list = await store.trades.list({ field: 'symbol', value: normalizeSymbol(q.symbol) });
    else list = await store.trades.list();
    res.json(list.sort(tradeOrder));
  });

  r.get('/:id', async (req, res) => {
    const t = await store.trades.get(req.params.id);
    if (!t) throw notFound('העסקה');
    res.json(t);
  });

  r.post('/', async (req, res) => {
    const input = parse(tradeCreateSchema, req.body);
    const account = await store.accounts.get(input.accountId);
    if (!account) throw notFound('החשבון');
    const plan = input.planId ? await store.plans.get(input.planId) : null;
    if (input.planId && !plan) throw notFound('התוכנית');
    // CFD: freeze the broker's value of a 1.0 move at opening, so later P&L never depends on a re-read.
    const spec = specs ? await specs.get(input.symbol) : null;
    const ready = await prepare(
      {
        ...input,
        ideaId: input.ideaId ?? plan?.ideaId ?? null,
        equityAtEntry: input.equityAtEntry ?? (Number(account.balance) > 0 ? account.balance : null),
        pointValue: spec?.pointValue ?? null,
        pointValueCurrency: spec?.currency ?? null,
      },
      account.baseCurrency,
    );
    const now = nowUtcIso();
    const trade = await store.trades.create({ ...ready, currency: account.baseCurrency, createdAt: now, updatedAt: now } satisfies Omit<Trade, 'id'>);

    // The plan is now "opened", with a note pointing to the trade.
    if (plan) {
      if (plan.status !== 'opened') await store.plans.update(plan.id, { status: 'opened', updatedAt: now });
      await store.notes.create({
        parentKind: 'plan',
        parentId: plan.id,
        parentKey: parentKey('plan', plan.id),
        symbol: plan.symbol,
        body: `▶ נפתחה עסקה ביומן (${trade.fills.length > 1 ? `${trade.fills.length} ביצועים` : `כניסה ב-${trade.fills[0]!.price}`}).`,
        createdAt: now,
        updatedAt: now,
      });
    }
    await recomputeBalance(store, account.id);
    res.status(201).json(trade);
  });

  r.patch('/:id', async (req, res) => {
    const patch = parse(tradePatchSchema, req.body);
    const cur = await store.trades.get(req.params.id);
    if (!cur) throw notFound('העסקה');
    const { id: _id, currency, createdAt, status: _s, openedAt: _o, closedAt: _c, netPnl: _n, r: _r, updatedAt: _u, ...base } = cur;
    const ready = await prepare({ ...base, ...patch }, currency);
    const updated = await store.trades.update(cur.id, { ...ready, updatedAt: nowUtcIso() });
    await recomputeBalance(store, cur.accountId);
    res.json(updated ?? { ...cur, ...ready, createdAt });
  });

  r.delete('/:id', async (req, res) => {
    const cur = await store.trades.get(req.params.id);
    if (!cur) throw notFound('העסקה');
    for (const n of await store.notes.list({ field: 'parentKey', value: parentKey('trade', cur.id) })) await store.notes.delete(n.id);
    for (const s of await store.screenshots.list({ field: 'parentKey', value: parentKey('trade', cur.id) })) {
      await files.remove(s);
      await store.screenshots.delete(s.id);
    }
    await store.trades.delete(cur.id);
    await recomputeBalance(store, cur.accountId);
    res.status(204).end();
  });

  return r;
}
