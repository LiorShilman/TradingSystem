import { useId, useState } from 'react';
import { COMMON_FX_SYMBOLS, normalizeSymbol } from '@trading/shared';

/** Free text that normalizes to TradingView format on blur ("eurusd" → "FX:EURUSD"). */
export function SymbolInput({
  value,
  onChange,
  autoFocus,
  className = 'input',
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const listId = useId();
  const [bad, setBad] = useState(false);
  return (
    <>
      <input
        className={`${className} uppercase ${bad ? 'border-red-500' : ''}`}
        dir="ltr"
        list={listId}
        value={value}
        autoFocus={autoFocus}
        placeholder="EURUSD / FX:EURUSD"
        onChange={(e) => {
          setBad(false);
          onChange(e.target.value);
        }}
        onBlur={() => {
          if (!value.trim()) return;
          const n = normalizeSymbol(value);
          if (n) onChange(n);
          else setBad(true);
        }}
      />
      <datalist id={listId}>
        {COMMON_FX_SYMBOLS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {bad && <span className="block text-xs text-red-600 dark:text-red-400">סימול לא תקין (למשל EURUSD או NASDAQ:AAPL)</span>}
    </>
  );
}

export function TagsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  return (
    <input
      className="input"
      value={text}
      placeholder="למשל: H4, פריצה, מגמה"
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split(/[,،]/)
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 20),
        );
      }}
    />
  );
}
