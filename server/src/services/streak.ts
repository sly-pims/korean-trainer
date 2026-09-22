import { addDays } from '../dates.js';

// Streak logic — pure and unit-tested.
// A streak continues if the last session was yesterday or today.
// Skipping a day resets it to 1. Today is the local-day date string.

export function computeStreak(streak: number, lastSessionDate: string | null, today: string): number {
  if (!lastSessionDate) return 1;
  if (lastSessionDate === today) return streak;
  if (addDays(today, -1) === lastSessionDate) return streak + 1;
  return 1;
}