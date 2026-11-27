import { Router } from 'express';
import { accountCreateSchema, accountPatchSchema, nowUtcIso, type Account } from '@trading/shared';
import { HttpError, notFound, parse } from '../http';
import type { Store } from '../store/types';

export function accountsRouter(store: Store) {
  const r = Router();

  r.get('/', async (_req, res) => {
    const list = await store.accounts.list();
    list.sort((a, b) => Number(a.isArchived) - Number(b.isArchived) || a.createdAt.localeCompare(b.createdAt));
    res.json(list);
  });

  r.get('/:id', async (req, res) => {
    const a = await store.accounts.get(req.params.id);
    if (!a) throw notFound('החשבון');
    res.json(a);
  });

  r.post('/', async (req, res) => {
    const input = parse(accountCreateSchema, req.body);
    const now = nowUtcIso();
    const created = await store.accounts.create({ ...input, balance: '0', createdAt: now, updatedAt: now } satisfies Omit<Account, 'id'>);
    res.status(201).json(created);
  });

  r.patch('/:id', async (req, res) => {
    const patch = parse(accountPatchSchema, req.body);
    const updated = await store.accounts.update(req.params.id, { ...patch, updatedAt: nowUtcIso() });
    if (!updated) throw notFound('החשבון');
    res.json(updated);
  });

  r.delete('/:id', async (req, res) => {
    const id = req.params.id;
    if (!(await store.accounts.get(id))) throw notFound('החשבון');
    const [flows, trades] = await Promise.all([store.cashflows.list({ field: 'accountId', value: id }), store.trades.list({ field: 'accountId', value: id })]);
    if (flows.length || trades.length) throw new HttpError(409, 'לחשבון יש תנועות או עסקאות. אפשר להעביר אותו לארכיון במקום למחוק.');
    await store.accounts.delete(id);
    res.status(204).end();
  });

  return r;
}
