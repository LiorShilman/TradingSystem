import { useEffect, useState } from 'react';
import {
  CURRENCIES,
  DISPLAY_CURRENCIES,
  normalizeDecInput,
  type Currency,
  type DisplayCurrency,
  type FxSnapshot,
  type Settings,
} from '@trading/shared';
import { TelegramSettings } from '../components/TelegramSettings';
import { ErrorBox, Field, PageTitle } from '../components/ui';
import { api, download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fxSourceLabel } from '../lib/fx';
import { applyTheme, getTheme, type Theme } from '../lib/theme';
import { useAsync } from '../lib/useAsync';

const RATE_CURRENCIES = CURRENCIES.filter((c) => c !== 'USD');

export function SettingsPage() {
  const { logout } = useAuth();
  const settings = useAsync(() => api<Settings>('/settings'), []);
  const fx = useAsync(() => api<FxSnapshot | null>('/fx'), []);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const [display, setDisplay] = useState<DisplayCurrency>('ILS');
  /** Manual overrides only. Empty = use the automatic rate. */
  const [manual, setManual] = useState<Partial<Record<Currency, string>>>({});
  const [rateErrors, setRateErrors] = useState<Partial<Record<Currency, string>>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setDisplay(settings.data.displayCurrency);
    const { USD: _usd, ...rest } = settings.data.rates;
    setManual(rest);
  }, [settings.data]);

  async function save() {
    setError(null);
    setStatus(null);
    const clean: Settings['rates'] = { USD: '1' };
    const errs: Partial<Record<Currency, string>> = {};
    for (const c of RATE_CURRENCIES) {
      const raw = manual[c]?.trim();
      if (!raw) continue; // empty → automatic (or missing)
      const n = normalizeDecInput(raw);
      if (n === null || n === '0' || n.startsWith('-')) errs[c] = 'שער לא תקין';
      else clean[c] = n;
    }
    setRateErrors(errs);
    if (Object.keys(errs).length) return;
    try {
      await api('/settings', { method: 'PUT', body: { displayCurrency: display, rates: clean } });
      setStatus('נשמר ✓');
      void settings.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    }
  }

  async function refreshRates() {
    setError(null);
    setRefreshing(true);
    try {
      fx.setData(await api<FxSnapshot>('/fx/refresh', { method: 'POST' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    } finally {
      setRefreshing(false);
    }
  }

  async function exportJson() {
    setError(null);
    try {
      await download('/export', 'trading-export.json');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה');
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle>הגדרות</PageTitle>
      <ErrorBox message={settings.error ?? fx.error ?? error} />

      <section className="card space-y-3">
        <h2 className="font-semibold">תצוגה</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="ערכת נושא">
            <select
              className="input"
              value={theme}
              onChange={(e) => {
                const t = e.target.value as Theme;
                setTheme(t);
                applyTheme(t);
              }}
            >
              <option value="system">לפי המערכת</option>
              <option value="light">בהיר</option>
              <option value="dark">כהה</option>
            </select>
          </Field>
          <Field label="מטבע תצוגה לסך התיק">
            <select className="input" value={display} onChange={(e) => setDisplay(e.target.value as DisplayCurrency)}>
              {DISPLAY_CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">שערי המרה</h2>
          <button className="btn-ghost" onClick={refreshRates} disabled={refreshing}>
            {refreshing ? 'מרענן…' : '↻ רענן עכשיו'}
          </button>
        </div>
        <p className="text-xs text-slate-500">
          {fx.data ? <>אוטומטי לפי {fxSourceLabel(fx.data)}. מתעדכן כל 3 שעות.</> : 'עדיין לא נמשכו שערים אוטומטיים.'} שדה
          ידני דורס את השער האוטומטי של אותו מטבע. כמה יחידות מהמטבע שוות 1$.
        </p>
        <div className="grid gap-3 sm:grid-cols-4">
          {RATE_CURRENCIES.map((c) => {
            const auto = fx.data?.rates[c];
            const isManual = !!manual[c]?.trim();
            return (
              <Field
                key={c}
                label={`1$ = ? ${c}`}
                error={rateErrors[c]}
                hint={isManual ? `ידני — דורס את האוטומטי${auto ? ` (${auto})` : ''}` : auto ? `אוטומטי: ${auto}` : 'אין שער — הזן ידנית'}
              >
                <div className="flex gap-1">
                  <input
                    className="input"
                    dir="ltr"
                    inputMode="decimal"
                    placeholder={auto ?? ''}
                    value={manual[c] ?? ''}
                    onChange={(e) => setManual((r) => ({ ...r, [c]: e.target.value }))}
                  />
                  {isManual && auto && (
                    <button
                      type="button"
                      className="btn-ghost px-2 text-xs"
                      title="חזור לשער האוטומטי"
                      onClick={() => setManual((r) => ({ ...r, [c]: '' }))}
                    >
                      ↺
                    </button>
                  )}
                </div>
              </Field>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          <button className="btn-primary" onClick={save}>
            שמור
          </button>
          {status && <span className="text-sm text-emerald-600">{status}</span>}
        </div>
      </section>

      <TelegramSettings />

      <section className="card space-y-3">
        <h2 className="font-semibold">גיבוי</h2>
        <p className="text-xs text-slate-500">קובץ JSON עם כל הנתונים. גיבוי אוטומטי ושחזור יתווספו בהמשך.</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={exportJson}>
            ⬇ ייצוא JSON
          </button>
          <button className="btn-ghost" onClick={() => void download('/export/trades.csv', 'trades.csv').catch((e) => setError(e instanceof Error ? e.message : 'שגיאה'))}>
            ⬇ עסקאות ל-Excel (CSV)
          </button>
        </div>
      </section>

      <section className="card">
        <button className="btn-danger" onClick={logout}>
          התנתק מהמכשיר הזה
        </button>
      </section>
    </div>
  );
}
