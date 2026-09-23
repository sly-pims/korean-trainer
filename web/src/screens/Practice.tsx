import { useEffect, useState } from 'react';
import { api } from '../api';
import { DiffView } from '../components/DiffView';
import { SpeakingEvaluation } from '../components/Feedback';
import { GlossCard } from '../components/GlossCard';
import { SpeakButton, SpeakToggle } from '../components/SpeakButton';
import { useMediaRecorder } from '../hooks/useMediaRecorder';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import type { GlossaryEntry, SpeakingFeedback } from '../types';

/** Standalone practice screen: random pack, read-aloud drill and a free-response drill. */
export function Practice() {
  const [pack, setPack] = useState<import('../types').ContentPack | null>(null);
  const [settings, setSettings] = useState<import('../types').Settings | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<GlossaryEntry | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [p, s] = await Promise.all([api.practiceRead(), api.getSettings()]);
        setPack(p.pack);
        setSettings(s);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'practice unavailable');
      }
    })();
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!pack || !settings) return <div className="spinner" />;

  const rate = settings.tts_rate;
  const voiceUri = settings.tts_voice;

  return (
    <>
      <h2>Practice</h2>
      <p className="muted small">
        Extra drills outside your daily session. Speaking free responses count against the daily LLM budget.
      </p>
      <div className="card">
        <div className="row">
          <h3 className="grow">Random lesson</h3>
          <SpeakButton text={pack.passage_ko} rate={rate} voiceUri={voiceUri} label="Play passage" />
        </div>
        <p className="passage">
          {splitPassage(pack.passage_ko, pack.glossary.map((g) => g.surface)).map((piece, i) =>
            piece.surface ? (
              <span
                key={i}
                className="tappable"
                onClick={() => {
                  const e = pack.glossary.find((g) => g.surface === piece.surface);
                  if (e) setSelected(e);
                }}
              >
                {piece.text}
              </span>
            ) : (
              <span key={i}>{piece.text}</span>
            ),
          )}
        </p>
        {selected && (
          <GlossCard entry={selected} rate={rate} voiceUri={voiceUri} onTap={() => setSelected(null)} />
        )}
        <p className="small muted">{pack.passage_en}</p>
      </div>

      <ReadAloudPractice pack={pack} rate={rate} voiceUri={voiceUri} />
      <FreeResponsePractice pack={pack} rate={rate} voiceUri={voiceUri} />
    </>
  );
}

function splitPassage(text: string, surfaces: string[]): { text: string; surface?: string }[] {
  const parts: { text: string; surface?: string }[] = [];
  let rest = text;
  while (rest.length) {
    const match = surfaces.filter((s) => s.length > 0 && rest.startsWith(s)).sort((a, b) => b.length - a.length)[0];
    if (match) {
      parts.push({ text: match, surface: match });
      rest = rest.slice(match.length);
    } else {
      const next = surfaces.map((s) => rest.indexOf(s)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
      const upto = next === undefined ? rest.length : Math.max(next, 1);
      parts.push({ text: rest.slice(0, upto) });
      rest = rest.slice(upto);
    }
  }
  return parts;
}

function ReadAloudPractice({ pack, rate, voiceUri }: { pack: import('../types').ContentPack; rate: number; voiceUri: string }) {
  const target = pack.sentences[0]?.ko ?? pack.speaking_prompt.ko;
  const rec = useSpeechRecognition('ko-KR');
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<{ percent: number; segments: { type: 'equal' | 'delete' | 'insert'; text: string }[] } | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    rec.onFinal((text) => setTyped(text));
    rec.onInterim((text) => setTyped(text));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = async () => {
    if (!typed.trim()) return;
    setErr('');
    try {
      const r = await api.gradeReadAloudSelf(target, typed);
      setResult({ percent: r.percent, segments: splitCharDiff(target, typed) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'check failed');
    }
  };

  return (
    <div className="card">
      <h3>Read-aloud drill</h3>
      <div className="row">
        <span className="ko grow">{target}</span>
        <SpeakToggle text={target} rate={rate} voiceUri={voiceUri} />
      </div>
      <div className="row">
        <button
          onClick={() => {
            if (rec.listening) {
              rec.stop();
            } else {
              setResult(null);
              rec.start();
            }
          }}
          disabled={!rec.supported}
        >
          {rec.listening ? '⏹ Stop' : '🎤 Start speaking'}
        </button>
        {rec.supported && (rec.interim || typed) && (
          <span className="small muted grow">{rec.listening ? rec.interim || '…' : typed}</span>
        )}
      </div>
      {rec.error && <div className="error-banner">{rec.error}</div>}
      <input lang="ko" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Speak it, or type or paste what you said" />
      <div className="row">
        <button className="small" onClick={check} disabled={typed.trim() === ''}>
          Check match
        </button>
        {result && <span className={`tag ${result.percent >= 80 ? '' : 'small-label'}`}>{result.percent}%</span>}
      </div>
      {result && <DiffView segments={result.segments} />}
      {err && <div className="error-banner">{err}</div>}
    </div>
  );
}

function splitCharDiff(aRaw: string, bRaw: string): { type: 'equal' | 'delete' | 'insert'; text: string }[] {
  const a = Array.from(aRaw);
  const b = Array.from(bRaw);
  const L: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const segs: { type: 'equal' | 'delete' | 'insert'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      segs.push({ type: 'equal', text: a[i] });
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      segs.push({ type: 'delete', text: a[i] });
      i++;
    } else {
      segs.push({ type: 'insert', text: b[j] });
      j++;
    }
  }
  while (i < a.length) {
    segs.push({ type: 'delete', text: a[i] });
    i++;
  }
  while (j < b.length) {
    segs.push({ type: 'insert', text: b[j] });
    j++;
  }
  const out: { type: 'equal' | 'delete' | 'insert'; text: string }[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.type === s.type) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

function FreeResponsePractice({ pack, rate, voiceUri }: { pack: import('../types').ContentPack; rate: number; voiceUri: string }) {
  const rec = useMediaRecorder();
  const [attemptId, setAttemptId] = useState<number | null>(null);
  const [queued, setQueued] = useState(false);
  const [feedback, setFeedback] = useState<SpeakingFeedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const submit = async (blob: Blob, mime: string) => {
    setBusy(true);
    setMsg('');
    try {
      const res = await api.freeSpeech(null, blob, mime);
      setAttemptId(res.attempt_id);
      setQueued(res.queued);
      setFeedback(res.feedback ?? null);
      setMsg(res.queued ? 'Submitted — feedback will appear after grading.' : 'Submitted.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'upload failed');
    } finally {
      setBusy(false);
    }
  };

  const submitRecording = () => {
    const blob = rec.blob;
    const mime = rec.mimeType || 'audio/webm';
    if (!blob) return;
    rec.reset();
    void submit(blob, mime);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    void submit(f, f.type || 'audio/webm');
  };

  const pollFeedback = async () => {
    if (attemptId === null) return;
    try {
      const r = await api.getSpeakingAttempt(attemptId);
      if (r.feedback) {
        setFeedback(r.feedback as SpeakingFeedback);
        setQueued(false);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'feedback check failed');
    }
  };

  const recordAgain = () => {
    setFeedback(null);
    setAttemptId(null);
    setQueued(false);
    setMsg('');
  };

  return (
    <div className="card">
      <h3>Free-response drill</h3>
      <div className="row">
        <p className="ko grow">{pack.speaking_prompt.ko}</p>
        <SpeakButton text={pack.speaking_prompt.ko} rate={rate} voiceUri={voiceUri} label="Hear prompt" />
      </div>
      {feedback ? (
        <>
          <SpeakingEvaluation feedback={feedback} rate={rate} voiceUri={voiceUri} />
          <button className="small" onClick={recordAgain}>
            Record another answer
          </button>
        </>
      ) : (
        <>
          {!rec.supported ? (
            <div className="error-banner">Recording needs HTTPS and a supported browser — you can attach a file below.</div>
          ) : (
            <div className="row">
              <button
                className={rec.recording ? '' : 'primary'}
                onClick={() => {
                  if (rec.recording) {
                    rec.stop();
                  } else {
                    void rec.start();
                    setMsg('');
                  }
                }}
                disabled={busy}
              >
                {rec.recording ? '⏹ Stop recording' : '🎤 Start recording'}
              </button>
              {rec.recording && <span className="small muted grow">max 60s</span>}
            </div>
          )}
          {rec.blob && attemptId === null && (
            <div className="row">
              <button className="small primary" disabled={busy} onClick={submitRecording}>
                {busy ? 'Uploading…' : 'Submit recording'}
              </button>
            </div>
          )}
          {queued && (
            <div className="row">
              <span className="small muted grow">Grading in progress — check back in a moment.</span>
              <button className="small" onClick={pollFeedback} disabled={!attemptId}>
                Check feedback
              </button>
            </div>
          )}
          <p className="small muted">…or attach a recording on desktop:</p>
          <input type="file" accept="audio/*,video/*" onChange={onFile} disabled={busy} />
          {rec.error && <div className="error-banner">{rec.error}</div>}
          {msg && <p className="small muted">{msg}</p>}
        </>
      )}
    </div>
  );
}