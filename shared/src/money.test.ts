import { describe, expect, it } from 'vitest';
import { dec, decStr, formatDec, normalizeDecInput, sumDec } from './money';

describe('money', () => {
  it('0.1 + 0.2 is exactly 0.3', () => {
    expect(decStr(dec('0.1').plus(dec('0.2')))).toBe('0.3');
    expect(sumDec(['0.1', '0.2'])).toBe('0.3');
  });

  it('keeps forex precision', () => {
    expect(decStr(dec('1.08453').minus(dec('1.08000')))).toBe('0.00453');
  });

  it('rejects non-decimal strings', () => {
    expect(() => dec('1e5')).toThrow();
    expect(() => dec('abc')).toThrow();
    expect(() => dec('')).toThrow();
  });

  it('normalizes typed input', () => {
    expect(normalizeDecInput('1,500.25')).toBe('1500.25');
    expect(normalizeDecInput(' +10 ')).toBe('10');
    expect(normalizeDecInput('3.')).toBe('3');
    expect(normalizeDecInput('1.50000')).toBe('1.5');
    expect(normalizeDecInput('-0')).toBe('0');
    expect(normalizeDecInput('12abc')).toBeNull();
    expect(normalizeDecInput('')).toBeNull();
  });

  it('formats with separators', () => {
    expect(formatDec('8499.75', 2)).toBe('8,499.75');
    expect(formatDec('-1234567.891', 2)).toBe('-1,234,567.89');
    expect(formatDec('-0.001', 2)).toBe('0.00');
    expect(formatDec('1.08453')).toBe('1.08453');
  });
});
