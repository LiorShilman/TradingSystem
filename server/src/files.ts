import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Screenshot } from '@trading/shared';
import type { StoredScreenshot } from './store/types';

// Screenshots live on the home server's disk: <dataDir>/screenshots/<id>.<ext> + <id>.thumb.webp
// <img> can't send x-admin-key, so files are served through short-lived HMAC-signed URLs.

export type Variant = 'thumb' | 'full';
const URL_TTL_S = 12 * 60 * 60;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export class FileStore {
  private secret: Buffer;
  constructor(
    private dir: string,
    adminKey: string,
  ) {
    this.secret = createHash('sha256').update(`files:${adminKey}`).digest();
  }

  private sign(id: string, variant: Variant, exp: number) {
    return createHmac('sha256', this.secret).update(`${id}.${variant}.${exp}`).digest('base64url');
  }

  verify(id: string, variant: string, exp: string, sig: string): boolean {
    if (variant !== 'thumb' && variant !== 'full') return false;
    const e = Number(exp);
    if (!Number.isFinite(e) || e < Date.now() / 1000) return false;
    const expected = Buffer.from(this.sign(id, variant, e));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** Attach signed URLs (relative to the API base). */
  withUrls(s: StoredScreenshot): Screenshot {
    if (!s.file) return s;
    const exp = Math.floor(Date.now() / 1000) + URL_TTL_S;
    const url = (v: Variant) => `/files/screenshots/${s.id}/${v}?exp=${exp}&sig=${this.sign(s.id, v, exp)}`;
    return { ...s, thumbUrl: url('thumb'), fullUrl: url('full') };
  }

  pathFor(id: string, variant: Variant, ext: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('bad id');
    return path.join(this.dir, variant === 'thumb' ? `${id}.thumb.webp` : `${id}.${ext}`);
  }

  /** Validate it's a real image, write the original and a 480px thumbnail. */
  async save(id: string, buf: Buffer): Promise<NonNullable<Screenshot['file']>> {
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('התמונה גדולה מ-15MB');
    let meta: sharp.Metadata;
    try {
      meta = await sharp(buf).metadata();
    } catch {
      throw new Error('הקובץ אינו תמונה');
    }
    const fmt = meta.format;
    const known: Record<string, { ext: string; mime: string }> = {
      png: { ext: 'png', mime: 'image/png' },
      jpeg: { ext: 'jpg', mime: 'image/jpeg' },
      webp: { ext: 'webp', mime: 'image/webp' },
      gif: { ext: 'gif', mime: 'image/gif' },
    };
    const k = fmt ? known[fmt] : undefined;
    if (!k) throw new Error('סוג תמונה לא נתמך (PNG/JPG/WEBP/GIF)');
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(id, 'full', k.ext), buf);
    await sharp(buf).resize({ width: 480, withoutEnlargement: true }).webp({ quality: 80 }).toFile(this.pathFor(id, 'thumb', k.ext));
    return { ...k, width: meta.width ?? 0, height: meta.height ?? 0, bytes: buf.length };
  }

  async remove(s: StoredScreenshot) {
    if (!s.file) return;
    await rm(this.pathFor(s.id, 'full', s.file.ext), { force: true });
    await rm(this.pathFor(s.id, 'thumb', s.file.ext), { force: true });
  }
}

// ---------- TradingView snapshot links ----------
export type BinaryFetcher = (url: string) => Promise<{ ok: boolean; contentType: string; body: Buffer }>;

export const defaultBinaryFetcher: BinaryFetcher = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 trading-system' }, signal: AbortSignal.timeout(15_000) });
  return { ok: res.ok, contentType: res.headers.get('content-type') ?? '', body: Buffer.from(await res.arrayBuffer()) };
};

/** "https://www.tradingview.com/x/AbC123xy/" → "AbC123xy". */
export function tradingViewSnapshotId(url: string): string | null {
  return /tradingview\.com\/x\/([A-Za-z0-9]+)/i.exec(url)?.[1] ?? /snapshots\/[a-z0-9]\/([A-Za-z0-9]+)\.png/i.exec(url)?.[1] ?? null;
}

/**
 * Download the image behind a TradingView snapshot link. Tries the known S3 path first,
 * then the page's og:image. Returns null if neither works (the link is still kept).
 */
export async function fetchTradingViewImage(url: string, fetcher: BinaryFetcher = defaultBinaryFetcher): Promise<Buffer | null> {
  const id = tradingViewSnapshotId(url);
  if (!id) return null;
  const candidates = [`https://s3.tradingview.com/snapshots/${id[0]!.toLowerCase()}/${id}.png`];
  try {
    const page = await fetcher(`https://www.tradingview.com/x/${id}/`);
    const og = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(page.body.toString('utf8'))?.[1];
    if (og && !candidates.includes(og)) candidates.push(og);
  } catch {
    /* page unavailable — still try S3 */
  }
  for (const c of candidates) {
    try {
      const r = await fetcher(c);
      if (r.ok && r.contentType.startsWith('image/') && r.body.length > 0) return r.body;
    } catch {
      /* next */
    }
  }
  return null;
}
