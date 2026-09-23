import { useEffect, useState } from 'react';
import { SpeakButton } from './SpeakButton';
import type { SrsCardRow, SrsRating } from '../types';

interface Props {
  cards: SrsCardRow[];
  busy?: number | null;
  rate: number;
  voiceUri: string;
  onReview: (wordId: number, rating: SrsRating) => void;
}

const RATINGS: { rating: SrsRating; label: string; hint: string }[] = [
  { rating: 'again', label: 'Again', hint: "I couldn't recall it" },
  { rating: 'hard', label: 'Hard', hint: 'I only half-knew it' },
  { rating: 'good', label: 'Good', hint: "I knew it" },
  { rating: 'easy', label: 'Easy', hint: 'Too easy' },
];

/** A single SRS recall card: try to remember the meaning first, then reveal and rate. */
export function SrsCard({ cards, busy, rate, voiceUri, onReview }: Props) {
  const card = cards[0];
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setRevealed(false);
  }, [card?.word_id]);

  if (!card) return null;

  const showCount = cards.length - 1;
  return (
    <div className="card">
      <div className="row">
        <span className="ko grow" style={{ fontSize: '1.6rem', fontWeight: 700 }}>
          {card.surface_example || card.lemma}
        </span>
        <span className="tag">due today</span>
      </div>
      <p className="small muted">Try to recall what this word means before revealing it.</p>
      {!revealed ? (
        <button className="primary grow-cta" disabled={busy === card.word_id} onClick={() => setRevealed(true)}>
          Reveal meaning
        </button>
      ) : (
        <>
          <p className="muted">{card.meaning_en}</p>
          <div className="row">
            <SpeakButton text={card.lemma} rate={rate} voiceUri={voiceUri} label="Hear it" />
            <span className="small muted grow">How well did you know it?</span>
            <button className="ghost small" onClick={() => setRevealed(false)}>
              hide
            </button>
          </div>
          <div className="row wrap">
            {RATINGS.map((r) => (
              <button
                key={r.rating}
                className="grow"
                disabled={busy === card.word_id}
                onClick={() => onReview(card.word_id, r.rating)}
                title={r.hint}
              >
                {r.label}
              </button>
            ))}
          </div>
        </>
      )}
      {showCount > 0 && <p className="small muted center">{showCount} more waiting today</p>}
    </div>
  );
}