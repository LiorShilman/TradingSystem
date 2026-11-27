import { useEffect, useRef } from 'react';
import { symbolTicker } from '@trading/shared';

const INTERVALS: Record<string, string> = { M1: '1', M5: '5', M15: '15', M30: '30', H1: '60', H4: '240', D: 'D', D1: 'D', W: 'W', W1: 'W', MN: 'M' };

// Some feeds (FXCM) exist only inside a logged-in TradingView account, not in the public embed widget.
// The widget shows the same pair from a public feed instead; our stored symbol stays unchanged.
const WIDGET_FEED_SUBSTITUTE: Record<string, string> = { FXCM: 'OANDA' };

export function widgetSymbol(symbol: string): string {
  const [exchange = ''] = symbol.split(':');
  const sub = WIDGET_FEED_SUBSTITUTE[exchange];
  return sub ? `${sub}:${symbolTicker(symbol)}` : symbol;
}

/** TradingView's free embed widget, plus a link to the full chart in the user's own TradingView. */
export function TradingViewChart({ symbol, timeframe = 'H4', height }: { symbol: string; timeframe?: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = widgetSymbol(symbol);
  const interval = INTERVALS[timeframe.toUpperCase()] ?? '240';
  // Explicit pixel height: with autosize the widget sometimes collapses to ~100px.
  const h = height ?? Math.max(460, Math.round(window.innerHeight * 0.7));

  useEffect(() => {
    const el = ref.current;
    if (!el || !shown) return;
    el.innerHTML = `<div class="tradingview-widget-container__widget" style="height:${h}px;width:100%"></div>`;
    const dark = document.documentElement.classList.contains('dark');
    const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    s.async = true;
    s.type = 'text/javascript';
    s.innerHTML = JSON.stringify({
      autosize: false,
      width: '100%',
      height: h,
      symbol: shown,
      interval,
      timezone: 'Asia/Jerusalem',
      theme: dark ? 'dark' : 'light',
      style: '1',
      locale: 'he_IL',
      allow_symbol_change: false,
      calendar: false,
      support_host: 'https://www.tradingview.com',
    });
    el.appendChild(s);
    return () => {
      el.innerHTML = '';
    };
  }, [shown, interval, h]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>{shown !== symbol ? <>הגרף מוצג לפי <span dir="ltr">{shown}</span> — נתוני FXCM זמינים רק בחשבון TradingView שלך</> : null}</span>
        <a
          href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}&interval=${interval}`}
          target="_blank"
          rel="noreferrer"
          className="text-sky-600 hover:underline"
        >
          פתח ב-TradingView ↗
        </a>
      </div>
      <div ref={ref} className="tradingview-widget-container overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700" style={{ height: h }} dir="ltr" />
    </div>
  );
}
