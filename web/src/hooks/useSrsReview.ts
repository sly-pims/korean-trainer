import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { SrsCardRow, SrsRating } from '../types';

/**
 * Shared SRS review flow used by both the daily session's warm-up step and
 * the standalone Vocabulary screen. Loads due cards, reviews one, reloads.
 */
export function useSrsReview() {
  const [cards, setCards] = useState<SrsCardRow[] | null>(null);
  const [dueTotal, setDueTotal] = useState(0);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const { cards, due_total } = await api.srsDue();
      setCards(cards);
      setDueTotal(due_total);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not load due words');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const review = useCallback(
    async (wordId: number, rating: SrsRating) => {
      setBusyId(wordId);
      try {
        await api.reviewCard(wordId, rating);
        await load();
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'review failed');
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  return { cards, dueTotal, busyId, err, load, review };
}