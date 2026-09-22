import type { SrsCardRow, SrsRating } from '../types';

interface Props {
  cards: SrsCardRow[];
  busy?: number | null;
  onReview: (wordId: number, rating: SrsRating) => void;
}

const RATINGS: { rating: SrsRating; label: string; hint: string }[] = [
  { rating: 'again', label: 'Again', hint: "I didn't know it" },
  { rating: 'hard', label: 'Hard', hint: 'Took me a while' },
  { rating: 'good', label: 'Good', hint: 'I knew it' },
  { rating: 'easy', label: 'Easy', hint: 'Too easy' },
];

/** A single SRS card with a rating prompt (SM-2). */
export function SrsCard({ cards, busy, onReview }: Props) {
  const card = cards[0];
  if (!card) return null;
  return (
    <div className="card">
      <div className="row">
        <span className="ko grow" style={{ fontSize: '1.6rem', fontWeight: 700 }}>
          {card.surface_example || card.lemma}
        </span>
        <span className="tag">due today</span>
      </div>
      <p className="muted">{card.meaning_en}</p>
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
      {cards.length > 1 && <p className="small muted center">{cards.length - 1} more waiting today</p>}
    </div>
  );
}