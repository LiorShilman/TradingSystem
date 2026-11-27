// All server calls go through here. The admin key lives only in this device's localStorage.
const KEY_STORAGE = 'adminKey';
const API_BASE: string = import.meta.env.VITE_API_BASE ?? `${import.meta.env.BASE_URL}api`;

export interface Issue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues: Issue[] = [],
    /** Server-side list of problems (e.g. what a plan is missing). */
    public details: string[] = [],
  ) {
    super(message);
  }
  /** Message for a field, e.g. "amount". */
  field(name: string) {
    return this.issues.find((i) => i.path === name)?.message;
  }
}

export function getAdminKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}
export function setAdminKey(key: string | null) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* private mode — the session simply won't persist */
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; key?: string } = {}): Promise<T> {
  const key = opts.key ?? getAdminKey() ?? '';
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        'x-admin-key': key,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'אין חיבור לשרת');
  }
  if (res.status === 401 && !opts.key) window.dispatchEvent(new Event('auth:logout'));
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `שגיאה ${res.status}`, data.issues ?? [], data.details ?? []);
  return data as T;
}

/** Absolute URL for a server-relative path such as a signed image URL. */
export const apiUrl = (rel: string) => `${API_BASE}${rel}`;

/** Upload an image as a raw body; metadata goes in the query string. */
export async function uploadImage<T>(path: string, file: Blob): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'x-admin-key': getAdminKey() ?? '', 'Content-Type': file.type || 'image/png' },
      body: file,
    });
  } catch {
    throw new ApiError(0, 'אין חיבור לשרת');
  }
  if (res.status === 401) window.dispatchEvent(new Event('auth:logout'));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `שגיאה ${res.status}`, data.issues ?? []);
  return data as T;
}

/** Download a protected file (the header can't be sent from a plain <a href>). */
export async function download(path: string, fallbackName: string) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { 'x-admin-key': getAdminKey() ?? '' } });
  if (!res.ok) throw new ApiError(res.status, 'ההורדה נכשלה');
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
