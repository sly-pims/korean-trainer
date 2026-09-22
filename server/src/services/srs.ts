import { addDays } from '../dates.js';

export type Rating = 'again' | 'hard' | 'good' | 'easy';

export interface CardState {
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
}

export interface ReviewedCard extends CardState {
  dueDate: string;
}

// SM-2-style scheduling. Ratings map to SM-2 qualities:
//   again=1, hard=3, good=4, easy=5.
// Again resets the learning state; good/easy grow the interval by ease.

export function reviewCard(card: CardState, rating: Rating, today: string): ReviewedCard {
  let { ease, intervalDays, reps, lapses } = card;
  let interval: number;

  switch (rating) {
    case 'again':
      reps = 0;
      interval = 0;
      ease = Math.max(1.3, Math.round((ease - 0.2) * 100) / 100);
      lapses += 1;
      break;
    case 'hard':
      interval = reps === 0 ? 1 : Math.max(1, Math.round(intervalDays * 1.2));
      reps += 1;
      ease = Math.max(1.3, Math.round((ease - 0.15) * 100) / 100);
      break;
    case 'good':
      interval =
        reps === 0 ? 1 : reps === 1 ? 6 : Math.max(1, Math.round(intervalDays * ease));
      reps += 1;
      break;
    case 'easy':
      interval = reps === 0 ? 2 : reps === 1 ? 7 : Math.max(1, Math.round(intervalDays * ease * 1.3));
      reps += 1;
      ease = Math.min(3.0, Math.round((ease + 0.15) * 100) / 100);
      break;
  }

  const dueDate = addDays(today, rating === 'again' ? 1 : Math.max(interval, 1));
  return { ease, intervalDays: interval, reps, lapses, dueDate };
}