import { Router } from 'express';
import { normalizeSymbol } from '@trading/shared';
import type { QuoteHub } from '../quotes';

const parseSymbols = (q: unknown) =>
  [...new Set((typeof q === 'string' ? q.split(',') : []).map((s) => normalizeSymbol(s)).filter((s): s is string => !!s))].slice(0, 200);

export function quotesRouter(hub: QuoteHub) {
  const r = Router();

  // Latest prices.
  r.get('/', async (req, res) => {
    res.json(await hub.get(parseSymbols(req.query.symbols)));
  });

  // Latest prices + up to one hour of observed points ([epochMs, price]) for sparklines.
  r.get('/history', async (req, res) => {
    const symbols = parseSymbols(req.query.symbols);
    const latest = await hub.get(symbols);
    const history = hub.historyFor(symbols);
    res.json(Object.fromEntries(symbols.map((s) => [s, { quote: latest[s] ?? null, points: history[s] ?? [] }])));
  });

  return r;
}
