import { describe, expect, it } from 'vitest';
import { computeStreak } from '../src/services/streak.js';

describe('computeStreak', () => {
  const today = '2026-09-22';

  it('returns 1 on the first session', () => {
    expect(computeStreak(0, null, today)).toBe(1);
  });

  it('counts a session yesterday as a continuation', () => {
    expect(computeStreak(5, '2026-09-21', today)).toBe(6);
  });

  it('keeps the streak for a second session on the same day', () => {
    expect(computeStreak(3, '2026-09-22', today)).toBe(3);
  });

  it('resets to 1 after a skipped day', () => {
    expect(computeStreak(12, '2026-09-15', today)).toBe(1);
  });
});