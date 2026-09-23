import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, levelSuggestionToPrompt } from '../api';
import { DiffView } from '../components/DiffView';
import { SpeakingEvaluation, WritingEvaluation } from '../components/Feedback';
import { GlossCard } from '../components/GlossCard';
import { SrsCard } from '../components/SrsCard';
import { SpeakButton, SpeakToggle } from '../components/SpeakButton';
import { useMediaRecorder } from '../hooks/useMediaRecorder';
import type { GlossaryEntry, ListeningResult, SessionWithPack, Settings, SrsRating, WritingFeedback } from '../types';

const STEP_ORDER = ['warmup', 'read', 'writing', 'listening', 'speaking', 'done'] as const;

type StepName = (typeof STEP_ORDER)[number];

const STEP_LABEL: Record<string, string> = {
  warmup: 'Review',
  read: 'Read',
  writing: 'Write',
  listening: 'Listen',
  speaking: 'Speak',
  done: 'Done',
};

interface SessionUiState {
  settings: Settings | null;
  error: string;
  busy: boolean;
  startedAt: number;
}

export function Session() {
  const { id } = useParams();
  const nav = useNavigate();
  const sessionId = Number(id);
  const [data, setData] = useState<SessionWithPack | null>(null);
  const [ui, setUi] = useState<SessionUiState>({ settings: null, error: '', busy: false, startedAt: Date.now() });

  useEffect(() => {
    (async () => {
      try {
        const [{ session }, settings] = await Promise.all([api.sessionToday(), api.getSettings()]);
        if (!session || session.session.id !== sessionId) {
          setUi((u) => ({ ...u, error: 'No such session' }));
          return;
        }
        setData(session);
        setUi((u) => ({ ...u, settings }));
        if (session.session.current_step === 'done') {
          // already completed recap fetched lazily
        }
      } catch (err) {
        setUi((u) => ({ ...u, error: err instanceof Error ? err.message : 'load failed' }));
      }
    })();
  }, [sessionId]);

  const step: StepName = data?.session.current_step && (STEP_ORDER as readonly string[]).includes(data.session.current_step)
    ? (data.session.current_step as StepName)
    : 'warmup';

  const go = async (next: StepName) => {
    setUi((u) => ({ ...u, busy: true, error: '' }));
    try {
      await api.setStep(sessionId, next);
      setData((d) => (d ? { ...d, session: { ...d.session, current_step: next } } : d));
    } catch (err) {
      setUi((u) => ({ ...u, error: err instanceof Error ? err.message : 'step failed' }));
    } finally {
      setUi((u) => ({ ...u, busy: false }));
    }
  };

  if (ui.error && !data) return <div className="error-banner">{ui.error}</div>;
  if (!data || !ui.settings) return <div className="spinner" />;

  const idx = STEP_ORDER.indexOf(step);

  return (
    <>
      <div className="row">
        <h2 className="grow">Daily session</h2>
        <span className="steps-chip">
          {STEP_LABEL[step]} {idx + 1}/{STEP_ORDER.length}
        </span>
      </div>
      <div className="progress-strip">
        {STEP_ORDER.map((s, i) => (
          <div key={s} className={`seg ${i <= idx ? (i === idx && step !== 'done' ? 'active' : 'done') : ''}`} />
        ))}
      </div>
      {ui.error && <div className="error-banner">{ui.error}</div>}

      {step === 'done' ? (
        <WrapUp
          session={data.session}
          startedAt={ui.startedAt}
          onBack={() => nav('/')}
        />
      ) : step === 'warmup' ? (
        <Warmup sessionId={sessionId} onDone={() => go('read')} />
      ) : step === 'read' ? (
        <Read
          pack={data.pack}
          sessionId={sessionId}
          rate={ui.settings.tts_rate}
          voiceUri={ui.settings.tts_voice}
          onDone={() => go('writing')}
        />
      ) : step === 'writing' ? (
        <Write
          pack={data.pack}
          sessionId={sessionId}
          rate={ui.settings.tts_rate}
          voiceUri={ui.settings.tts_voice}
          onDone={() => go('listening')}
        />
      ) : step === 'listening' ? (
        <Listen
          pack={data.pack}
          sessionId={sessionId}
          rate={ui.settings.tts_rate}
          voiceUri={ui.settings.tts_voice}
          onDone={() => go('speaking')}
        />
      ) : (
        <Speak
          pack={data.pack}
          sessionId={sessionId}
          rate={ui.settings.tts_rate}
          voiceUri={ui.settings.tts_voice}
          onDone={() => go('done')}
        />
      )}
    </>
  );
}

// ---------------- Warmup ----------------

function Warmup({
  sessionId,
  onDone,
}: {
  sessionId: number;
  onDone: () => void;
}) {
  const [cards, setCards] = useState<import('../types').SrsCardRow[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const { cards } = await api.warmupCards(sessionId);
      setCards(cards);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'warmup failed');
    }
  };
  useEffect(() => {
    void load();
  }, [sessionId]);

  const review = async (wordId: number, rating: SrsRating) => {
    setBusyId(wordId);
    try {
      await api.reviewCard(wordId, rating);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'review failed');
    } finally {
      setBusyId(null);
    }
  };

  if (err) return <div className="error-banner">{err}</div>;
  if (cards === null) return <div className="spinner" />;

  return (
    <>
      <h3>Warm-up (due words)</h3>
      {cards.length === 0 ? (
        <div className="card">
          <p className="muted">No words due right now. Great job keeping on top of them!</p>
        </div>
      ) : (
        <SrsCard cards={cards} busy={busyId} onReview={review} />
      )}
      <button className="primary big-cta" onClick={onDone}>
        Continue to reading →
      </button>
    </>
  );
}

// ---------------- Read ----------------

function Read({
  pack,
  sessionId,
  rate,
  voiceUri,
  onDone,
}: {
  pack: import('../types').ContentPack;
  sessionId: number;
  rate: number;
  voiceUri: string;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<GlossaryEntry | null>(null);
  const [tappableSet, setTappable] = useState<Set<string>>(new Set());
  const [showEn, setShowEn] = useState(false);
  const [reveal, setReveal] = useState<Record<number, boolean>>({});
  const [qAnswers, setQAnswers] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTappable(new Set(pack.glossary.map((g) => g.surface)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack]);

  const tap = async (surface: string) => {
    const entry = pack.glossary.find((g) => g.surface === surface);
    if (!entry) return;
    setSelected(entry);
    try {
      await api.wordTap(sessionId, surface);
    } catch {
      /* offline is fine — the word still shows */
    }
  };

  const answer = async (qi: number, choice: number) => {
    if (qAnswers[qi] !== undefined) return;
    const nextAnswers = { ...qAnswers, [qi]: choice };
    setQAnswers(nextAnswers);
    setReveal((m) => ({ ...m, [qi]: true }));
  };

  const saveAnswers = async (answers: Record<number, number>): Promise<boolean> => {
    setSaving(true);
    try {
      await api.gradeRead(
        sessionId,
        pack.questions.map((_q, i) => answers[i]),
      );
      return true;
    } catch {
      return false;
    } finally {
      setSaving(false);
    }
  };

  const continueToWriting = async () => {
    if (!allAnswered || !(await saveAnswers(qAnswers))) return;
    onDone();
  };

  const allAnswered = pack.questions.length > 0 && pack.questions.every((_, i) => qAnswers[i] !== undefined);

  const passageText = pack.passage_ko;
  const pieces: { text: string; surface?: string }[] = useMemo(() => {
    const parts: { text: string; surface?: string }[] = [];
    let rest = passageText;
    while (rest.length) {
      const tapable = [...tappableSet].filter((s) => rest.startsWith(s)).sort((a, b) => b.length - a.length);
      if (tapable.length) {
        parts.push({ text: tapable[0], surface: tapable[0] });
        rest = rest.slice(tapable[0].length);
      } else {
        const next = [...tappableSet]
          .map((s) => rest.indexOf(s))
          .filter((i) => i >= 0)
          .sort((a, b) => a - b)[0];
        const upto = next === undefined ? rest.length : Math.max(next, 1);
        parts.push({ text: rest.slice(0, upto) });
        rest = rest.slice(upto);
      }
    }
    return parts;
  }, [passageText, tappableSet]);

  return (
    <>
      <div className="row">
        <h3 className="grow">Reading</h3>
        <SpeakButton text={pack.passage_ko} rate={rate} voiceUri={voiceUri} label="Read the passage" />
        <button className="small" onClick={() => setShowEn((v) => !v)}>
          {showEn ? 'Hide English' : 'Show English'}
        </button>
      </div>
      {showEn && <p className="muted small card">{pack.passage_en}</p>}

      <div className="card">
        <p className="passage">
          {pieces.map((p, i) =>
            p.surface ? (
              <span key={i} className="tappable" onClick={() => tap(p.surface!)}>
                {p.text}
              </span>
            ) : (
              <span key={i}>{p.text}</span>
            ),
          )}
        </p>
        {selected && <GlossCard entry={selected} rate={rate} voiceUri={voiceUri} onTap={() => setSelected(null)} />}
      </div>

      <h3>Check your understanding</h3>
      {pack.questions.map((q, qi) => {
        const answered = qAnswers[qi] !== undefined;
        return (
          <div className="card q-card" key={qi}>
            <p className="ko">{q.q_ko}</p>
            <p className="muted small">{q.q_en}</p>
            {q.choices.map((c, ci) => {
              let cls = 'choice';
              if (reveal[qi]) {
                if (ci === q.answer_index) cls += ' correct';
                else if (ci === qAnswers[qi]) cls += ' wrong';
              }
              return (
                <button key={ci} className={cls} disabled={answered} onClick={() => answer(qi, ci)}>
                  {c}
                </button>
              );
            })}
            {reveal[qi] && <p className="small muted">{q.explanation_en}</p>}
          </div>
        );
      })}
      <button className="primary big-cta" disabled={!allAnswered || saving} onClick={() => void continueToWriting()}>
        Continue to writing →
      </button>
      {allAnswered && <p className="small muted center">Your answers will be saved as you continue.</p>}
    </>
  );
}

// ---------------- Writing ----------------

function Write({
  pack,
  sessionId,
  rate,
  voiceUri,
  onDone,
}: {
  pack: import('../types').ContentPack;
  sessionId: number;
  rate: number;
  voiceUri: string;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState<WritingFeedback | null>(null);
  const [queued, setQueued] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const res = await api.submitWriting(sessionId, text);
      setQueued(res.queued);
      setFeedback(res.feedback);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not submit');
    } finally {
      setBusy(false);
    }
  };

  if (feedback) return <WritingFeedbackView feedback={feedback} rate={rate} voiceUri={voiceUri} onDone={onDone} />;

  return (
    <>
      <h3>Writing</h3>
      <div className="card">
        <div className="row">
          <p className="ko grow">{pack.writing_prompt.ko}</p>
          <SpeakButton text={pack.writing_prompt.ko} rate={rate} voiceUri={voiceUri} label="Hear the prompt" />
        </div>
        <p className="muted">{pack.writing_prompt.en}</p>
        {pack.writing_prompt.target_grammar && <span className="tag">{pack.writing_prompt.target_grammar}</span>}
      </div>
      <label htmlFor="write">Write your answer in Korean</label>
      <textarea
        id="write"
        lang="ko"
        enterKeyHint="done"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="한국어로 써 보세요…"
      />
      {err && <div className="error-banner">{err}</div>}
      {queued && <p className="muted small">Sent for grading — feedback will appear shortly.</p>}
      <button className="primary big-cta" disabled={busy || text.trim().length === 0} onClick={submit}>
        {busy ? 'Grading…' : 'Submit'}
      </button>
    </>
  );
}

function WritingFeedbackView({
  feedback,
  rate,
  voiceUri,
  onDone,
}: {
  feedback: WritingFeedback;
  rate: number;
  voiceUri: string;
  onDone: () => void;
}) {
  return (
    <>
      <WritingEvaluation feedback={feedback} rate={rate} voiceUri={voiceUri} />
      <button className="primary big-cta" onClick={onDone}>
        Continue to listening →
      </button>
    </>
  );
}

// ---------------- Listening ----------------

function Listen({
  pack,
  sessionId,
  rate,
  voiceUri,
  onDone,
}: {
  pack: import('../types').ContentPack;
  sessionId: number;
  rate: number;
  voiceUri: string;
  onDone: () => void;
}) {
  const targets = pack.sentences.slice(0, 3);
  const [typed, setTyped] = useState<string[]>(targets.map(() => ''));
  const [result, setResult] = useState<ListeningResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const check = async () => {
    setBusy(true);
    setErr('');
    try {
      setResult(await api.gradeListening(sessionId, typed));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'listening failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3>Dictation</h3>
      <p className="muted small">
        Listen, then type what you hear. Spaces and punctuation don’t count.
      </p>
      {targets.map((s, i) => (
        <div className="card" key={i}>
          <div className="row">
            <span className="small muted">{i + 1}.</span>
            <SpeakToggle text={s.ko} rate={rate} voiceUri={voiceUri} />
            {result && (
              <span className={`tag ${result.perSentence[i].percent >= 90 ? '' : 'small-label'}`}>
                {result.perSentence[i].percent}%
              </span>
            )}
          </div>
          <input
            lang="ko"
            value={typed[i]}
            onChange={(e) => setTyped((t) => t.map((v, j) => (j === i ? e.target.value : v)))}
            placeholder="듣고 적어 보세요…"
            disabled={!!result}
          />
          {result && <DiffView segments={result.perSentence[i].segments} />}
        </div>
      ))}
      {err && <div className="error-banner">{err}</div>}
      {!result && (
        <button className="primary big-cta" disabled={busy || typed.some((t) => t.trim() === '')} onClick={check}>
          {busy ? 'Checking…' : 'Check dictation'}
        </button>
      )}
      {result && (
        <button className="primary big-cta" onClick={onDone}>
          Continue to speaking →
        </button>
      )}
    </>
  );
}

// ---------------- Speaking ----------------

function Speak({
  pack,
  sessionId,
  rate,
  voiceUri,
  onDone,
}: {
  pack: import('../types').ContentPack;
  sessionId: number;
  rate: number;
  voiceUri: string;
  onDone: () => void;
}) {
  return (
    <>
      <ReadAloud pack={pack} sessionId={sessionId} rate={rate} voiceUri={voiceUri} />
      <FreeResponse pack={pack} sessionId={sessionId} rate={rate} voiceUri={voiceUri} onDone={onDone} />
    </>
  );
}

function ReadAloud({
  pack,
  sessionId,
  rate,
  voiceUri,
}: {
  pack: import('../types').ContentPack;
  sessionId: number;
  rate: number;
  voiceUri: string;
}) {
  const targets = pack.sentences.slice(0, 3);
  return (
    <>
      <h3>Read aloud</h3>
      <p className="muted small">
        Tap 🔊 to hear the sentence, then read it back. Mic recognition is approximate — a low match may be the
        recognizer, not you.
      </p>
      {targets.map((s, i) => (
        <ReadAloudSentence
          key={i}
          index={i}
          target={s.ko}
          sessionId={sessionId}
          rate={rate}
          voiceUri={voiceUri}
        />
      ))}
    </>
  );
}

function ReadAloudSentence({
  index,
  target,
  sessionId,
  rate,
  voiceUri,
}: {
  index: number;
  target: string;
  sessionId: number;
  rate: number;
  voiceUri: string;
}) {
  const rec = useMediaRecorder();
  const [transcript, setTranscript] = useState('');
  const [percent, setPercent] = useState<number | null>(null);
  const [segments, setSegments] = useState<{ type: 'equal' | 'delete' | 'insert'; text: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!rec.blob) return;
    (async () => {
      setBusy(true);
      setErr('');
      try {
        const r = await api.readAloudAudio(sessionId, index, rec.blob!, rec.mimeType);
        setTranscript(r.transcript);
        setPercent(r.percent);
        setSegments(buildSegments(target, r.transcript));
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'check failed');
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.blob]);

  const check = async () => {
    if (!transcript.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api.readAloud(sessionId, index, transcript);
      setPercent(r.percent);
      setSegments(buildSegments(target, transcript));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'check failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="row">
        <span className="small muted grow">{index + 1}.</span>
        <span className="ko">{target}</span>
        <SpeakButton text={target} rate={rate} voiceUri={voiceUri} label="Hear the sentence" />
      </div>
      <div className="row">
        <button
          className="primary"
          onClick={() => {
            if (rec.recording) {
              rec.stop();
            } else {
              setPercent(null);
              setSegments(null);
              rec.reset();
              void rec.start();
            }
          }}
          disabled={!rec.supported}
        >
          {rec.recording ? '⏹ Stop recording' : '🎤 Record & check'}
        </button>
        {rec.recording && <span className="small muted grow">Recording… read it out loud, then tap stop.</span>}
      </div>
      {rec.error && <div className="error-banner">{rec.error}</div>}
      <label htmlFor={`transcript-${index}`}>Transcript</label>
      <input
        id={`transcript-${index}`}
        lang="ko"
        value={transcript}
        onChange={(e) => setTranscript(e.target.value)}
        placeholder="Type what you said if microphone recognition is unavailable"
      />
      {percent !== null && segments && (
        <div className="row">
          <span className={`tag ${percent >= 80 ? '' : 'small-label'}`}>match {percent}%</span>
          <DiffView segments={segments} />
        </div>
      )}
      {err && <div className="error-banner">{err}</div>}
      <button className="small" disabled={busy || transcript.trim() === '' || percent !== null} onClick={check}>
        {busy ? 'Checking…' : 'Check my reading'}
      </button>
    </div>
  );
}

function buildSegments(target: string, typed: string): { type: 'equal' | 'delete' | 'insert'; text: string }[] {
  // A tiny equal/delete/insert split for feedback display.
  if (typed === target) return [{ type: 'equal', text: target }];
  const a = Array.from(target);
  const b = Array.from(typed);
  const L: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
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
  return mergeEqualRuns(segs);
}

function mergeEqualRuns(segs: { type: 'equal' | 'delete' | 'insert'; text: string }[]) {
  const out: { type: 'equal' | 'delete' | 'insert'; text: string }[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.type === s.type) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

function FreeResponse({
  pack,
  sessionId,
  rate,
  voiceUri,
  onDone,
}: {
  pack: import('../types').ContentPack;
  sessionId: number;
  rate: number;
  voiceUri: string;
  onDone: () => void;
}) {
  const rec = useMediaRecorder((msg) => setErr(msg));
  const [uploading, setUploading] = useState(false);
  const [attemptId, setAttemptId] = useState<number | null>(null);
  const [queued, setQueued] = useState(false);
  const [feedback, setFeedback] = useState<import('../types').SpeakingFeedback | null>(null);
  const [err, setErr] = useState('');
  const [showPrivacy, setShowPrivacy] = useState(!localStorage.getItem('kt:privacy-ok'));

  const submitRecording = async () => {
    const blob = rec.blob;
    if (!blob) return;
    setUploading(true);
    setErr('');
    try {
      const res = await api.freeSpeech(sessionId, blob, rec.mimeType || 'audio/webm');
      setAttemptId(res.attempt_id);
      setQueued(res.queued);
      setFeedback(res.feedback ?? null);
      localStorage.setItem('kt:privacy-ok', '1');
      setShowPrivacy(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  };

  const pollFeedback = async () => {
    if (attemptId === null) return;
    try {
      const r = await api.getSpeakingAttempt(attemptId);
      if (r.feedback) {
        setFeedback(r.feedback as import('../types').SpeakingFeedback);
        setQueued(false);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'feedback check failed');
    }
  };

  if (feedback) {
    return (
      <>
        <SpeakingEvaluation feedback={feedback} rate={rate} voiceUri={voiceUri} />
        <button className="primary big-cta" onClick={onDone}>
          Finish session
        </button>
      </>
    );
  }

  return (
    <>
      <h3>Free response</h3>
      <div className="card">
        <div className="row">
          <p className="ko grow">{pack.speaking_prompt.ko}</p>
          <SpeakButton text={pack.speaking_prompt.ko} rate={rate} voiceUri={voiceUri} label="Hear the prompt" />
        </div>
        <p className="muted">{pack.speaking_prompt.en}</p>
      </div>
      {showPrivacy && (
        <div className="card">
          <p className="small muted">
            🔒 Your recording stays on this trainer and is only used for feedback. It is auto-deleted after the
            retention period.
          </p>
          <button className="small" onClick={() => { setShowPrivacy(false); localStorage.setItem('kt:privacy-ok', '1'); }}>
            Got it
          </button>
        </div>
      )}
      {!rec.supported ? (
        <div className="error-banner">Recording needs HTTPS and a supported browser.</div>
      ) : (
        <div className="card">
          <div className="row">
            <button
              className={rec.recording ? '' : 'primary'}
              onClick={() => {
                if (rec.recording) {
                  rec.stop();
                } else {
                  void rec.start();
                  setErr('');
                }
              }}
              disabled={uploading || (attemptId !== null && !queued)}
            >
              {rec.recording ? '⏹ Stop recording' : '🎤 Start recording'}
            </button>
            {rec.recording && <span className="small muted">max 60s</span>}
          </div>
          {rec.elapsedMs > 0 && <p className="small muted">{Math.round(rec.elapsedMs / 1000)}s recorded</p>}
          {err && <div className="error-banner">{err}</div>}
          {queued && (
            <div className="row">
              <span className="small muted grow">Grading in progress — check back in a moment.</span>
              <button className="small" onClick={pollFeedback} disabled={!attemptId}>
                Check feedback
              </button>
            </div>
          )}
          {attemptId === null && (
            <button className="small" disabled={!rec.blob || uploading} onClick={submitRecording}>
              {uploading ? 'Uploading…' : 'Submit recording'}
            </button>
          )}
        </div>
      )}
      <button className="ghost" onClick={onDone} disabled={attemptId !== null && !queued}>
        Skip speaking (still counts towards your session)
      </button>
    </>
  );
}

// ---------------- Wrap-up ----------------

function WrapUp({
  session,
  startedAt,
  onBack,
}: {
  session: import('../types').SessionRow;
  startedAt: number;
  onBack: () => void;
}) {
  const [result, setResult] = useState<import('../types').SessionCompleteResult | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const duration = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        const r = await api.completeSession(session.id, duration);
        setResult(r);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'wrap-up failed');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, startedAt]);

  const applySuggestion = async () => {
    if (!result?.suggestion || result.suggestion.action === 'stay') return;
    setBusy(true);
    try {
      const { level } = await api.applyLevel(result.suggestion.action);
      setResult((r) =>
        r
          ? {
              ...r,
              suggestion: {
                action: 'stay',
                suggested_level: level,
                overall: r.suggestion?.overall ?? 0,
              },
            }
          : r,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'level change failed');
    } finally {
      setBusy(false);
    }
  };

  if (err && !result) return <div className="error-banner">{err}</div>;
  if (!result) return <div className="spinner" />;

  const rows: [string, number | null][] = [
    ['Read', result.scores.read],
    ['Write', result.scores.write],
    ['Listen', result.scores.listen],
    ['Speak', result.scores.speak],
    ['Vocab', result.scores.vocab],
  ];

  return (
    <>
      <h3>Session complete!</h3>
      <div className="card center">
        <p className="ko" style={{ fontSize: '1.8rem' }}>
          🎉 {result.streak}-day streak
        </p>
        <p className="muted">Keep it going tomorrow.</p>
      </div>
      <div className="card">
        {rows.map(([label, score]) => (
          <div className="list-item" key={label}>
            <span className="grow">{label}</span>
            {score === null ? <span className="muted small">skipped</span> : <span className="tag">{score}%</span>}
          </div>
        ))}
      </div>
      {result.suggestion && result.suggestion.action !== 'stay' && (
        <div className="card">
          <p>{levelSuggestionToPrompt(result.suggestion)}</p>
          <button className="primary" disabled={busy} onClick={applySuggestion}>
            {result.suggestion.action === 'up' ? 'Level up' : 'Level down'}
          </button>
        </div>
      )}
      <button className="ghost" onClick={onBack}>
        Back to home
      </button>
    </>
  );
}