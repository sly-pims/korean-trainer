import { useEffect, useState } from 'react';
import { SpeakButton } from './SpeakButton';
import type { SrsCardRow, SrsRating } from '../types';
import type { LanguageDescriptor } from '../types';
import { useCopy } from '../copy';
import type { CopyKey } from '../copy';

interface Props {
  cards: SrsCardRow[];
  busy?: number | null;
  rate: number;
  voiceUri: string;
  lang: LanguageDescriptor;
  onReview: (wordId: number, rating: SrsRating) => void;
}

const RATINGS: { rating: SrsRating; label: CopyKey; hint: CopyKey }[] = [
  { rating: 'again', label: 'srs.again', hint: 'srs.againHint' },
  { rating: 'hard', label: 'srs.hard', hint: 'srs.hardHint' },
  { rating: 'good', label: 'srs.good', hint: 'srs.goodHint' },
  { rating: 'easy', label: 'srs.easy', hint: 'srs.easyHint' },
];

/** A single SRS recall card: try to remember the meaning first, then reveal and rate. */
export function SrsCard({ cards, busy, rate, voiceUri, lang, onReview }: Props) {
  const card = cards[0];
  const { t } = useCopy();
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setRevealed(false);
  }, [card?.word_id]);

  if (!card) return null;

  const showCount = cards.length - 1;
  return (
    <div className="card">
      <div className="row">
        <span className="target-text grow" style={{ fontSize: '1.6rem', fontWeight: 700 }}>
          {card.surface_example || card.lemma}
        </span>
        <span className="tag">{t('srs.dueToday')}</span>
      </div>
      <p className="small muted">{t('srs.recallHint')}</p>
      {!revealed ? (
        <button className="primary grow-cta" disabled={busy === card.word_id} onClick={() => setRevealed(true)}>
          Reveal meaning
        </button>
      ) : (
        <>
          <p className="muted">{card.meaning_native}</p>
          <div className="row">
            <SpeakButton text={card.lemma} rate={rate} voiceUri={voiceUri} lang={lang} label="speak.hearIt" />
            <span className="small muted grow">{t('srs.howWell')}</span>
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
                title={t(r.hint)}
              >
                {t(r.label)}
              </button>
            ))}
          </div>
        </>
      )}
      {showCount > 0 && <p className="small muted center">{showCount} more waiting today</p>}
    </div>
  );
}