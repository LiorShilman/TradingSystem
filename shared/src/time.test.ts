import { describe, expect, it } from 'vitest';
import {
  EXCHANGE_TZ,
  exchangeTimeInIsrael,
  formatIsrael,
  isUtcIso,
  israelLocalToUtcIso,
  utcIsoToIsraelLocal,
} from './time';

describe('time — Israel display', () => {
  it('14:00 UTC is 17:00 in Israel summer and 16:00 in winter', () => {
    expect(formatIsrael('2026-07-15T14:00:00.000Z', 'HH:mm')).toBe('17:00');
    expect(formatIsrael('2026-12-15T14:00:00.000Z', 'HH:mm')).toBe('16:00');
  });

  it('round-trips datetime-local input as Israel time', () => {
    const utc = israelLocalToUtcIso('2026-07-15T17:00');
    expect(utc).toBe('2026-07-15T14:00:00.000Z');
    expect(utcIsoToIsraelLocal(utc!)).toBe('2026-07-15T17:00');
    expect(israelLocalToUtcIso('not-a-date')).toBeNull();
  });

  it('accepts only UTC ISO strings', () => {
    expect(isUtcIso('2026-07-15T14:00:00.000Z')).toBe(true);
    expect(isUtcIso('2026-07-15T14:00:00+03:00')).toBe(false);
    expect(isUtcIso('15/07/2026')).toBe(false);
  });
});

describe('time — NY open in Israel across unsynced DST weeks', () => {
  const nyOpen = (d: string) => exchangeTimeInIsrael(d, EXCHANGE_TZ.newYork, '09:30').toFormat('HH:mm');

  it('normal winter: 16:30', () => {
    expect(nyOpen('2026-01-15')).toBe('16:30');
  });
  it('US already on DST, Israel not yet (Mar 8–26 2026): 15:30', () => {
    expect(nyOpen('2026-03-10')).toBe('15:30');
  });
  it('both on DST: 16:30', () => {
    expect(nyOpen('2026-04-15')).toBe('16:30');
  });
  it('Israel back on winter time, US still DST (late Oct 2026): 15:30', () => {
    expect(nyOpen('2026-10-27')).toBe('15:30');
  });
  it('London open 08:00 in Israel: 10:00 both in summer and in winter', () => {
    expect(exchangeTimeInIsrael('2026-07-15', EXCHANGE_TZ.london, '08:00').toFormat('HH:mm')).toBe('10:00');
    expect(exchangeTimeInIsrael('2026-12-15', EXCHANGE_TZ.london, '08:00').toFormat('HH:mm')).toBe('10:00');
  });
});
