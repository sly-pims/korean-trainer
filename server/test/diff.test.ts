import { describe, expect, it } from 'vitest';
import { compareStrings, normalizeForCompare } from '../src/services/diff.js';

describe('normalizeForCompare', () => {
  it('NFC-normalizes', () => {
    // "안녕하세요" in NFD then NFC round-trips to the same NFC string.
    const nfd = '안녕하세요'.normalize('NFD');
    expect(nfd).not.toBe('안녕하세요');
    expect(normalizeForCompare(nfd)).toBe('안녕하세요');
  });

  it('removes spaces and punctuation', () => {
    expect(normalizeForCompare('안녕하세요. 저는 빵을 먹어요!')).toBe('안녕하세요저는빵을먹어요');
  });

  it('keeps Hangul and digits', () => {
    expect(normalizeForCompare('가나다 123')).toBe('가나다123');
  });
});

describe('compareStrings', () => {
  it('ignores spacing differences', () => {
    const r = compareStrings('저는 밥을 먹어요.', '저는 밥을 먹어요');
    expect(r.percent).toBe(100);
    expect(r.segments.every((s) => s.type === 'equal' || s.type === 'delete')).toBe(true);
  });

  it('ignores punctuation differences', () => {
    const r = compareStrings('좋아요!', '좋아요.');
    expect(r.percent).toBe(100);
  });

  it('scores a real mismatch lower', () => {
    const r = compareStrings('저는 밥을 먹어요.', '저는 김밥을 먹어요.');
    expect(r.percent).toBeLessThan(100);
    expect(r.matched).toBeGreaterThan(0);
  });

  it('handles a totally different string', () => {
    const r = compareStrings('가나다', '마바사');
    expect(r.percent).toBe(0);
  });

  it('produces delete/insert segments for highlighting', () => {
    const r = compareStrings('가나다', '가라다');
    expect(r.segments.filter((s) => s.type === 'delete').length).toBe(1);
    expect(r.segments.filter((s) => s.type === 'insert').length).toBe(1);
  });
});