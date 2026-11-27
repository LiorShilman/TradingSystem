import { DateTime } from 'luxon';
import { z } from 'zod';

// Stored: ISO-8601 in UTC ("2026-11-27T06:12:00.000Z"). Displayed: Asia/Jerusalem.
// Never use a fixed hour offset — Israel, the US and Europe switch DST on different dates.
export const ISRAEL_TZ = 'Asia/Jerusalem';

export const EXCHANGE_TZ = {
  newYork: 'America/New_York',
  london: 'Europe/London',
  tokyo: 'Asia/Tokyo',
} as const;

export function nowUtcIso(): string {
  return DateTime.utc().toISO()!;
}

export function isUtcIso(s: string): boolean {
  return /Z$/.test(s) && DateTime.fromISO(s, { zone: 'utc' }).isValid;
}

export const utcIsoString = z.string().refine(isUtcIso, 'תאריך לא תקין');

export function toIsrael(isoUtc: string): DateTime {
  return DateTime.fromISO(isoUtc, { zone: 'utc' }).setZone(ISRAEL_TZ);
}

export function formatIsrael(isoUtc: string, fmt = 'dd/MM/yyyy HH:mm'): string {
  return toIsrael(isoUtc).toFormat(fmt);
}

/** Value of an <input type="datetime-local"> ("2026-11-27T09:30"), read as Israel time → UTC ISO. */
export function israelLocalToUtcIso(local: string): string | null {
  const dt = DateTime.fromISO(local, { zone: ISRAEL_TZ });
  return dt.isValid ? dt.toUTC().toISO() : null;
}

/** UTC ISO → value for <input type="datetime-local"> in Israel time. */
export function utcIsoToIsraelLocal(isoUtc: string): string {
  return toIsrael(isoUtc).toFormat("yyyy-MM-dd'T'HH:mm");
}

/** A wall-clock time at an exchange on a given local date, expressed in Israel time. */
export function exchangeTimeInIsrael(localDate: string, zone: string, time: string): DateTime {
  return DateTime.fromISO(`${localDate}T${time}`, { zone }).setZone(ISRAEL_TZ);
}
