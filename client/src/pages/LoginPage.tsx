import { useState, type FormEvent } from 'react';
import { ErrorBox } from '../components/ui';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

export function LoginPage() {
  const { login } = useAuth();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(key);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'המפתח שגוי' : err instanceof Error ? err.message : 'שגיאה');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4">
        <h1 className="text-xl font-bold">📈 כניסה למערכת</h1>
        <label className="block space-y-1">
          <span className="text-sm font-medium">מפתח גישה</span>
          <input
            className="input"
            type="password"
            dir="ltr"
            autoComplete="current-password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoFocus
          />
        </label>
        <ErrorBox message={error} />
        <button className="btn-primary w-full" disabled={busy || !key.trim()}>
          {busy ? 'בודק…' : 'כניסה'}
        </button>
        <p className="text-xs text-slate-500">המפתח נשמר רק במכשיר הזה.</p>
      </form>
    </div>
  );
}
