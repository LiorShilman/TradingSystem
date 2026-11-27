import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ACCOUNT_KIND_LABELS,
  ASSET_CLASSES,
  ASSET_CLASS_LABELS,
  DIRECTIONS,
  DIRECTION_LABELS,
  israelLocalToUtcIso,
  normalizeDecInput,
  nowUtcIso,
  utcIsoToIsraelLocal,
  type AssetClass,
  type Direction,
  type Trade,
} from '@trading/shared';
import { api, ApiError } from '../lib/api';
import { useActiveAccount } from '../lib/activeAccount';
import { fmtPx, isCurrencyPair, newId, parseQty, useAccounts } from '../lib/trades';
import { SymbolInput } from './SymbolInput';
import { ErrorBox, Field } from './ui';

export interface NewTradeDefaults {
  symbol?: string;
  assetClass?: AssetClass;
  accountId?: string | null;
  direction?: Direction;
  timeframe?: string;
  planId?: string | null;
  ideaId?: string | null;
  initialStop?: string | null;
  entryPrice?: string | null;
  quantity?: string | null;
  targets?: Array<{ price: string; sizePct: string }>;
  tags?: string[];
}

/** Open a trade in the journal — from a plan (prefilled) or by hand. Navigates to the new trade. */
export function NewTradeForm({ defaults = {}, onCancel }: { defaults?: NewTradeDefaults; onCancel?: () => void }) {
  const navigate = useNavigate();
  const accounts = useAccounts();
  const { active: current } = useActiveAccount();
  const [symbol, setSymbol] = useState(defaults.symbol ?? '');
  const [assetClass, setAssetClass] = useState<AssetClass>(defaults.assetClass ?? 'forex');
  const [accountId, setAccountId] = useState(defaults.accountId ?? current?.id ?? '');
  // The active account may arrive after the first render (accounts load async).
  useEffect(() => {
    if (!accountId && current) setAccountId(current.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);
  const [direction, setDirection] = useState<Direction>(defaults.direction ?? 'long');
  const px = (p: string | null | undefined) => (p ? fmtPx(p, defaults.symbol ?? '', defaults.assetClass ?? 'forex') : '');
  const [stop, setStop] = useState(px(defaults.initialStop));
  const [price, setPrice] = useState(px(defaults.entryPrice));
  const [qty, setQty] = useState(defaults.quantity ?? '');
  const [when, setWhen] = useState(() => utcIsoToIsraelLocal(nowUtcIso()));
  const [fee, setFee] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const active = (accounts.data ?? []).filter((a) => !a.isArchived);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const p = normalizeDecInput(price);
    const s = normalizeDecInput(stop);
    const q = parseQty(qty);
    const f = fee.trim() ? normalizeDecInput(fee) : '0';
    const at = israelLocalToUtcIso(when);
    if (!symbol) errs.symbol = 'בחר נכס';
    if (!accountId) errs.account = 'בחר חשבון';
    if (!p || Number(p) <= 0) errs.price = 'מחיר לא תקין';
    if (!s || Number(s) <= 0) errs.stop = 'חובה — ממנו מחושב 1R';
    if (!q) errs.qty = 'כמות לא תקינה';
    if (f === null || Number(f) < 0) errs.fee = 'עמלה לא תקינה';
    if (!at) errs.when = 'זמן לא תקין';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      const t = await api<Trade>('/trades', {
        method: 'POST',
        body: {
          symbol,
          assetClass,
          accountId,
          direction,
          timeframe: defaults.timeframe ?? '',
          planId: defaults.planId ?? null,
          ideaId: defaults.ideaId ?? null,
          initialStop: s,
          targets: defaults.targets ?? [],
          tags: defaults.tags ?? [],
          fills: [{ id: newId(), kind: 'entry', at, price: p, quantity: q, fee: f }],
        },
      });
      navigate(`/trades/${t.id}`);
    } catch (e2) {
      setError(e2 instanceof ApiError ? (e2.details[0] ?? e2.issues[0]?.message ?? e2.message) : 'שגיאה');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <ErrorBox message={error ?? accounts.error} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="נכס" error={errors.symbol}>
          <SymbolInput value={symbol} onChange={setSymbol} />
        </Field>
        <Field label="חשבון" error={errors.account}>
          <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">— בחר חשבון —</option>
            {active.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.baseCurrency}){a.kind === 'demo' ? ` · ${ACCOUNT_KIND_LABELS.demo}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="כיוון">
          <select className="input" value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
            {DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {DIRECTION_LABELS[d]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="סוג נכס">
          <select className="input" value={assetClass} onChange={(e) => setAssetClass(e.target.value as AssetClass)}>
            {ASSET_CLASSES.map((c) => (
              <option key={c} value={c}>
                {ASSET_CLASS_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="מחיר כניסה" error={errors.price}>
          <input className="input tabular-nums" dir="ltr" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="כמות" error={errors.qty} hint={assetClass === 'forex' && isCurrencyPair(symbol) ? 'ביחידות: 100000 = לוט. אפשר לכתוב 50K' : 'יחידות כמו ב-FXCM (זהב: 1 = אונקיה, מדדים ונפט: 1 = חוזה)'}>
          <input className="input tabular-nums" dir="ltr" value={qty} onChange={(e) => setQty(e.target.value)} placeholder={assetClass === 'forex' ? '50K' : ''} />
        </Field>
        <Field label="סטופ התחלתי" error={errors.stop}>
          <input className="input tabular-nums" dir="ltr" inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} />
        </Field>
        <Field label="עמלה (מטבע החשבון)" error={errors.fee}>
          <input className="input tabular-nums" dir="ltr" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0" />
        </Field>
        <Field label="זמן הכניסה (שעון ישראל)" error={errors.when}>
          <input className="input" type="datetime-local" dir="ltr" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
      </div>
      <p className="text-xs text-slate-500">כניסות נוספות, יציאות חלקיות ועלויות מוסיפים אחר כך בדף העסקה.</p>
      <div className="flex gap-2">
        <button className="btn-primary" disabled={busy}>
          {busy ? 'פותח…' : 'פתח עסקה ביומן'}
        </button>
        {onCancel && (
          <button type="button" className="btn-ghost" onClick={onCancel}>
            ביטול
          </button>
        )}
      </div>
    </form>
  );
}
