import type { GlossaryEntry } from '../types';
import { SpeakButton } from './SpeakButton';

interface Props {
  entry: GlossaryEntry;
  rate: number;
  voiceUri?: string | null;
  onTap?: () => void;
}

export function GlossCard({ entry, rate, voiceUri, onTap }: Props) {
  return (
    <div className="card gloss-card">
      <div className="row">
        <span className="surface ko">{entry.surface}</span>
        <SpeakButton text={entry.surface} rate={rate} voiceUri={voiceUri} />
      </div>
      <div className="row">
        <span className="tag">{entry.pos}</span>
        <span className="muted small">{entry.lemma}</span>
      </div>
      <p className="muted">{entry.meaning_en}</p>
      {onTap && (
        <button className="small" onClick={onTap}>
          Close
        </button>
      )}
    </div>
  );
}