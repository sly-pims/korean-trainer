import { useState } from 'react';
import { useTts } from '../hooks/useTts';
import { useCopy } from '../copy';
import type { CopyKey } from '../copy';
import type { LanguageDescriptor } from '../types';

interface Props {
  text: string;
  rate?: number;
  voiceUri?: string | null;
  /**
   * Button text, as a copy key rather than a string, so a caller cannot hand
   * this component untranslated text by accident — it used to accept whatever
   * literal the caller wrote, which is how "Play passage" ended up hardcoded in
   * two screens that are supposed to render in the learner's language.
   */
  label?: CopyKey;
  /**
   * Values for `{placeholders}` in `label`. Callers whose accessible name has to
   * include target-language content pass it here rather than pre-formatting a
   * string, so the word order around the word stays the locale's to decide.
   */
  labelParams?: Record<string, string | number>;
  /**
   * The active language, from `settings.lang`. Required rather than defaulted:
   * the hook has to know which language it is speaking to pick a voice, and a
   * default here would be a hardcoded language in a component that cannot know
   * the deployment teaches more than one.
   */
  lang: LanguageDescriptor;
}

/** A button that plays target-language text aloud. */
export function SpeakButton({ text, rate, voiceUri, label, labelParams, lang }: Props) {
  const { speak, stop, speaking, supported } = useTts(lang);
  const { t } = useCopy();
  const [err, setErr] = useState('');
  const caption = label ? t(label, labelParams) : t('speak.play');
  if (!supported) return null;
  return (
    <>
      <button
        className="icon-btn"
        title={caption}
        aria-label={caption}
        onClick={() => (speaking ? stop() : speak(text, { rate: rate ?? 1, voiceUri, onError: (m) => setErr(m) }))}
      >
        {speaking ? '⏹' : '🔊'}
      </button>
      {err && <span className="small muted">{err}</span>}
    </>
  );
}

/**
 * A speak button with an explicit slow/normal toggle (for dictation).
 *
 * `label` is a copy key rather than a string so a caller cannot hand this
 * component untranslated text by accident — the dictation step in particular
 * used to write "Show English" into the markup.
 */
export function SpeakToggle({
  text,
  rate,
  voiceUri,
  lang,
  label,
}: {
  text: string;
  rate: number;
  voiceUri?: string | null;
  lang: LanguageDescriptor;
  label?: CopyKey;
}) {
  const { speak, stop, speaking, supported } = useTts(lang);
  const { t } = useCopy();
  const [slow, setSlow] = useState(false);
  if (!supported) return <span className="small muted">{t('speak.unavailable')}</span>;
  return (
    <span className="row wrap">
      <button
        className="icon-btn"
        aria-label={label ? t(label) : t('speak.play')}
        onClick={() => (speaking ? stop() : speak(text, { rate: slow ? rate * 0.65 : rate, voiceUri }))}
      >
        {speaking ? '⏹' : '🔊'}
      </button>
      <button className="small" onClick={() => setSlow((v) => !v)} title={t('speak.toggleSlow')}>
        {slow ? t('speak.slow') : t('speak.normal')}
      </button>
    </span>
  );
}
