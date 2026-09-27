import type { GlossaryEntry } from '../types';
import { SpeakButton } from './SpeakButton';
import { useCopy } from '../copy';
import type { LanguageDescriptor } from '../types';

interface Props {
  entry: GlossaryEntry;
  rate: number;
  voiceUri?: string | null;
  lang: LanguageDescriptor;
  onTap?: () => void;
}

export function GlossCard({ entry, rate, voiceUri, lang, onTap }: Props) {
  const { t } = useCopy();
  return (
    <div className="card gloss-card">
      <div className="row">
        <span className="surface ko">{entry.surface}</span>
        <SpeakButton text={entry.surface} rate={rate} voiceUri={voiceUri} lang={lang} />
      </div>
      <div className="row">
        <span className="tag">{entry.pos}</span>
        <span className="muted small">{entry.lemma}</span>
      </div>
      <p className="muted">{entry.meaning_native}</p>
      {onTap && (
        <button className="small" onClick={onTap}>
          {t('common.close')}
        </button>
      )}
    </div>
  );
}