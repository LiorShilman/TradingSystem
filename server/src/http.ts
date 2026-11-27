import { createHash, timingSafeEqual } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Optional list shown to the user (e.g. what's missing in a plan). */
    public details?: string[],
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} לא נמצא`);

export function parse<S extends ZodType>(schema: S, body: unknown) {
  return schema.parse(body) as ReturnType<S['parse']>;
}

/** Constant-time compare of the x-admin-key header. */
export function adminAuth(adminKey: string): RequestHandler {
  const expected = createHash('sha256').update(adminKey).digest();
  return (req, res, next) => {
    const given = req.header('x-admin-key') ?? '';
    const ok = timingSafeEqual(createHash('sha256').update(given).digest(), expected);
    if (!ok) {
      res.status(401).json({ error: 'מפתח גישה שגוי או חסר' });
      return;
    }
    next();
  };
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'קלט לא תקין',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'הקובץ גדול מדי' });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'גוף הבקשה אינו JSON תקין' });
    return;
  }
  console.error('[error]', err instanceof Error ? err.message : err);
  res.status(500).json({ error: 'שגיאה פנימית בשרת' });
};
