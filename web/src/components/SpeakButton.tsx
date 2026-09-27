import { useState } from 'react';
import { useTts, type TtsLanguage } from '../hooks/useTts';

interface Props {
  text: string;
  rate?: number;
  voiceUri?: string | null;
  label?: string;
  /**
   * The active language, from `settings.lang`. Required rather than defaulted:
   * the hook has to know which language it is speaking to pick a voice, and a
   * default here would be a hardcoded language in a component that cannot know
   * the deployment teaches more than one.
   */
  lang: TtsLanguage;
}

/** A button that plays target-language text aloud. */
export function SpeakButton({ text, rate, voiceUri, label, lang }: Props) {
  const { speak, stop, speaking, supported } = useTts(lang);
  const [err, setErr] = useState('');
  if (!supported) return null;
  return (
    <>
      <button
        className="icon-btn"
        title={label ?? 'Play'}
        aria-label={label ?? 'Play'}
        onClick={() => (speaking ? stop() : speak(text, { rate: rate ?? 1, voiceUri, onError: (m) => setErr(m) }))}
      >
        {speaking ? '⏹' : '🔊'}
      </button>
      {err && <span className="small muted">{err}</span>}
    </>
  );
}

/** A speak button with an explicit slow/normal toggle (for dictation). */
export function SpeakToggle({
  text,
  rate,
  voiceUri,
  lang,
}: {
  text: string;
  rate: number;
  voiceUri?: string | null;
  lang: TtsLanguage;
}) {
  const { speak, stop, speaking, supported } = useTts(lang);
  const [slow, setSlow] = useState(false);
  if (!supported) return <span className="small muted">TTS unavailable</span>;
  return (
    <span className="row wrap">
      <button
        className="icon-btn"
        aria-label="Play"
        onClick={() => (speaking ? stop() : speak(text, { rate: slow ? rate * 0.65 : rate, voiceUri }))}
      >
        {speaking ? '⏹' : '🔊'}
      </button>
      <button className="small" onClick={() => setSlow((v) => !v)} title="Toggle slow">
        {slow ? '🐢 Slow' : 'Normal'}
      </button>
    </span>
  );
}
