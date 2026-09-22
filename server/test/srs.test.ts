import { describe, expect, it } from 'vitest';
import { reviewCard } from '../src/services/srs.js';

const base = { ease: 2.5, intervalDays: 0, reps: 0, lapses: 0 };
const today = '2026-09-22';

describe('SM-2 reviewCard', () => {
  it('Good: first rep schedules tomorrow (interval 1)', () => {
    const r = reviewCard(base, 'good', today);
    expect(r.reps).toBe(1);
    expect(r.intervalDays).toBe(1);
    expect(r.dueDate).toBe('2026-09-23');
    expect(r.ease).toBe(2.5);
  });

  it('Good twice → interval 6', () => {
    const first = reviewCard(base, 'good', today);
    const second = reviewCard(
      { ease: first.ease, intervalDays: first.intervalDays, reps: first.reps, lapses: first.lapses },
      'good',
      today,
    );
    expect(second.intervalDays).toBe(6);
    expect(second.dueDate).toBe('2026-09-28');
  });

  it('Good three times → interval grows by ease', () => {
    const s1 = reviewCard(base, 'good', today);
    const s2 = reviewCard(s1, 'good', today);
    const s3 = reviewCard(s2, 'good', today);
    expect(s3.intervalDays).toBe(Math.round(6 * s3.ease));
  });

  it('Easy boosts ease upwards', () => {
    const r = reviewCard(base, 'easy', today);
    expect(r.ease).toBeGreaterThan(2.5);
    expect(r.intervalDays).toBe(2); // first-rep easy boost
  });

  it('Again resets reps and lowers ease', () => {
    const s1 = reviewCard(base, 'good', today);
    const again = reviewCard(s1, 'again', today);
    expect(again.reps).toBe(0);
    expect(again.lapses).toBe(1);
    expect(again.ease).toBeLessThan(2.5);
    expect(again.dueDate).toBe('2026-09-23');
  });

  it('ease never drops below 1.3', () => {
    let card = { ease: 1.25, intervalDays: 30, reps: 5, lapses: 0 };
    card = reviewCard(card, 'again', today);
    expect(card.ease).toBe(1.3);
  });
});