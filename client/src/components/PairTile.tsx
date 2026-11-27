import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { dec, symbolTicker } from '@trading/shared';

// Windows doesn't render flag emojis, so currencies get colored badges with their sign.
const CCY: Record<string, { sign: string; cls: string }> = {
  USD: { sign: '$', cls: 'bg-emerald-500/15 text-emerald-600 ring-emerald-500/30 dark:text-emerald-300' },
  EUR: { sign: '€', cls: 'bg-blue-500/15 text-blue-600 ring-blue-500/30 dark:text-blue-300' },
  GBP: { sign: '£', cls: 'bg-violet-500/15 text-violet-600 ring-violet-500/30 dark:text-violet-300' },
  JPY: { sign: '¥', cls: 'bg-rose-500/15 text-rose-600 ring-rose-500/30 dark:text-rose-300' },
  CHF: { sign: '₣', cls: 'bg-red-500/15 text-red-600 ring-red-500/30 dark:text-red-300' },
  AUD: { sign: 'A$', cls: 'bg-amber-500/15 text-amber-600 ring-amber-500/30 dark:text-amber-300' },
  CAD: { sign: 'C$', cls: 'bg-orange-500/15 text-orange-600 ring-orange-500/30 dark:text-orange-300' },
  NZD: { sign: 'N$', cls: 'bg-teal-500/15 text-teal-600 ring-teal-500/30 dark:text-teal-300' },
};

function Badge({ code, className = '' }: { code: string; className?: string }) {
  const c = CCY[code] ?? { sign: code[0], cls: 'bg-slate-500/15 text-slate-500 ring-slate-500/30' };
  return (
    <span className={`inline-flex size-7 items-center justify-center rounded-full text-[11px] font-bold ring-1 ring-inset backdrop-blur ${c.cls} ${className}`} title={code}>
      {c.sign}
    </span>
  );
}

/** "1.09830" → big "1.0983" + small "0" (the pipette), like TradingView. */
function Price({ value }: { value: string }) {
  const [int, frac = ''] = value.split('.');
  const pipette = frac.length >= 3 ? frac.slice(-1) : '';
  const main = pipette ? `${int}.${frac.slice(0, -1)}` : value;
  return (
    <span dir="ltr" className="tabular-nums">
      <span className="text-2xl font-semibold tracking-tight">{main}</span>
      {pipette && <sup className="ms-px text-sm font-medium opacity-70">{pipette}</sup>}
    </span>
  );
}

function Sparkline({ points, up }: { points: Array<[number, string]>; up: boolean }) {
  const id = useRef(`g${Math.random().toString(36).slice(2)}`).current;
  if (points.length < 2) return <div className="flex h-10 items-center justify-center text-[11px] text-slate-400">אוסף נתונים…</div>;
  const ys = points.map(([, p]) => Number(p)); // display only — no money math here
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const W = 100;
  const H = 32;
  const xy = ys.map((y, i) => [(i / (ys.length - 1)) * W, H - ((y - min) / span) * (H - 4) - 2] as const);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const color = up ? 'rgb(16 185 129)' : 'rgb(244 63 94)';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-10 w-full" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export interface PairTileProps {
  symbol: string;
  price: string | null;
  points: Array<[number, string]>;
  activePlans?: number;
  ideas?: number;
  /** Price is inside the entry zone of an active plan. */
  inZone?: boolean;
}

export function PairTile({ symbol, price, points, activePlans = 0, ideas = 0, inZone = false }: PairTileProps) {
  const t = symbolTicker(symbol);
  const base = t.slice(0, 3);
  const quote = t.slice(3);

  // Flash green/red when the price moves.
  const prev = useRef<string | null>(null);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (price && prev.current && price !== prev.current) {
      setFlash(dec(price).gt(dec(prev.current)) ? 'up' : 'down');
      const tm = setTimeout(() => setFlash(null), 900);
      prev.current = price;
      return () => clearTimeout(tm);
    }
    prev.current = price;
  }, [price]);

  const minutes = points.length >= 2 ? Math.round((points.at(-1)![0] - points[0]![0]) / 60000) : 0;
  // Live FX moves within seconds; a price identical for 5+ minutes means the feed is frozen
  // (typically a pair missing from the FXCM subscription list). Never present it as live.
  const stale = minutes >= 5 && new Set(points.map((p) => p[1])).size === 1;
  const first = points[0]?.[1];
  const last = price ?? points.at(-1)?.[1];
  const changePct = !stale && first && last && points.length >= 2 ? dec(last).minus(dec(first)).div(dec(first)).times(100) : null;
  const up = changePct ? !changePct.isNegative() : true;

  return (
    <Link
      to={`/assets/${encodeURIComponent(symbol)}`}
      className={`group relative flex flex-col gap-2 overflow-hidden rounded-2xl border bg-gradient-to-br p-4 transition duration-300 hover:-translate-y-0.5 hover:shadow-lg
        ${inZone ? 'border-amber-400 shadow-[0_0_0_1px_rgb(251_191_36),0_0_24px_-4px_rgb(251_191_36/0.6)]' : 'border-slate-200 hover:border-sky-400 dark:border-slate-800 dark:hover:border-sky-500/60'}
        from-white to-slate-50 dark:from-slate-900 dark:to-slate-950
        ${flash === 'up' ? 'bg-emerald-500/10' : flash === 'down' ? 'bg-rose-500/10' : ''}`}
    >
      {/* flash overlay */}
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-0 transition-opacity duration-700 ${flash ? 'opacity-100' : 'opacity-0'} ${flash === 'up' ? 'bg-emerald-500/10' : 'bg-rose-500/10'}`}
      />

      {/* Row 1: currencies + pair name only */}
      <div className="relative flex items-center gap-2.5" dir="ltr">
        <div className="flex shrink-0 items-center gap-1">
          <Badge code={base} />
          <Badge code={quote} />
        </div>
        <span className="truncate text-[15px] font-semibold tracking-wide">
          {base}
          <span className="mx-0.5 font-normal text-slate-400">/</span>
          {quote}
        </span>
      </div>

      {/* Row 2: price + change */}
      <div className="relative flex items-end justify-between gap-2" dir="ltr">
        <div className={`${stale ? 'opacity-50' : ''} ${flash === 'up' ? 'text-emerald-600 dark:text-emerald-400' : flash === 'down' ? 'text-rose-600 dark:text-rose-400' : ''} transition-colors duration-500`}>
          {price ? <Price value={price} /> : <span className="text-2xl font-semibold text-slate-400">—</span>}
        </div>
        {changePct && (
          <span
            className={`mb-1 shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums ${up ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'}`}
            title={`שינוי ב-${minutes} הדקות האחרונות`}
          >
            {up ? '▲' : '▼'} {changePct.abs().toFixed(2)}%
          </span>
        )}
      </div>

      <div className="relative -mx-1">
        {stale ? (
          <div className="flex h-10 items-center justify-center rounded-lg bg-amber-500/10 text-[11px] font-medium text-amber-600 dark:text-amber-400" title="המחיר זהה כבר מספר דקות — כנראה הצמד לא נמצא ב-Subscription list של FXCM">
            ⚠ המחיר לא מתעדכן
          </div>
        ) : (
          <Sparkline points={price && points.length ? [...points.slice(0, -1), [Date.now(), price]] : points} up={up} />
        )}
      </div>

      <div className="relative flex min-h-5 flex-wrap items-center gap-1.5 text-[11px]">
        {inZone && <span className="rounded-full bg-amber-400/20 px-2 py-0.5 font-semibold text-amber-600 dark:text-amber-300">🎯 באזור כניסה</span>}
        {activePlans > 0 && <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-sky-600 dark:text-sky-300">{activePlans} תוכניות</span>}
        {ideas > 0 && <span className="rounded-full bg-slate-500/15 px-2 py-0.5 text-slate-600 dark:text-slate-300">{ideas} רעיונות</span>}
        {minutes > 0 && !stale && <span className="ms-auto text-slate-400">{minutes} דק׳</span>}
      </div>
    </Link>
  );
}
