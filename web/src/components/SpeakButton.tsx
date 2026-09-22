import { useState } from 'react';
import { useTts } from '../hooks/useTts';

interface Props {
  text: string;
  rate?: number;
  voiceUri?: string | null;
  label?: string;
}

/** A button that plays Korean text through speechSynthesis. */
export function SpeakButton({ text, rate, voiceUri, label }: Props) {
  const { speak, stop, speaking, supported } = useTts();
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
export function SpeakToggle({ text, rate, voiceUri }: { text: string; rate: number; voiceUri?: string | null }) {
  const { speak, stop, speaking, supported } = useTts();
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