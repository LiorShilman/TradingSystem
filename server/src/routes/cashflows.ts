import { Router } from 'express';
import {
  cashflowAmountError,
  cashflowCreateSchema,
  cashflowPatchSchema,
  computeBalance,
  nowUtcIso,
  realizedTotal,
  type Cashflow,
} from '@trading/shared';
import { ZodError } from 'zod';
import { Decimal, dec, decStr } from '@trading/shared';
import { notFound, parse } from '../http';
import type { Store } from '../store/types';

/** Recompute the derived balance of an account: all its cashflows + the realized net P&L of its trades. */
export async function recomputeBalance(store: Store, accountId: string) {
  const [flows, trades] = await Promise.all([store.cashflows.list({ field: 'accountId', value: accountId }), store.trades.list({ field: 'accountId', value: accountId })]);
  const balance = decStr(dec(computeBalance(flows)).plus(new Decimal(realizedTotal(trades))));
  await store.accounts.update(accountId, { balance, updatedAt: nowUtcIso() });
}

export function cashflowsRouter(store: Store) {
  const r = Router();

  // GET /api/cashflows?accountId=...  (newest first)
  r.get('/', async (req, res) => {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
    const list = await store.cashflows.list(accountId ? { field: 'accountId', value: accountId } : undefined);
    list.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt));
    res.json(list);
  });

  r.post('/', async (req, res) => {
    const input = parse(cashflowCreateSchema, req.body);
    const account = await store.accounts.get(input.accountId);
    if (!account) throw notFound('החשבון');
    const now = nowUtcIso();
    const created = await store.cashflows.create({
      ...input,
      currency: account.baseCurrency,
      createdAt: now,
      updatedAt: now,
    } satisfies Omit<Cashflow, 'id'>);
    await recomputeBalance(store, account.id);
    res.status(201).json(created);
  });

  r.patch('/:id', async (req, res) => {
    const patch = parse(cashflowPatchSchema, req.body);
    const current = await store.cashflows.get(req.params.id);
    if (!current) throw notFound('התנועה');
    const merged = { ...current, ...patch };
    const err = cashflowAmountError(merged.type, merged.amount);
    if (err) throw new ZodError([{ code: 'custom', path: ['amount'], message: err, input: merged.amount }]);
    const updated = await store.cashflows.update(current.id, { ...patch, updatedAt: nowUtcIso() });
    await recomputeBalance(store, current.accountId);
    res.json(updated);
  });

  r.delete('/:id', async (req, res) => {
    const current = await store.cashflows.get(req.params.id);
    if (!current) throw notFound('התנועה');
    await store.cashflows.delete(current.id);
    await recomputeBalance(store, current.accountId);
    res.status(204).end();
  });

  return r;
}
