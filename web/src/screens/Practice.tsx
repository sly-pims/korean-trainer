import { useEffect, useState } from 'react';
import { api } from '../api';
import { DiffView } from '../components/DiffView';
import { GlossCard } from '../components/GlossCard';
import { SpeakButton, SpeakToggle } from '../components/SpeakButton';
import type { GlossaryEntry } from '../types';

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
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<{ percent: number; segments: { type: 'equal' | 'delete' | 'insert'; text: string }[] } | null>(null);
  const [err, setErr] = useState('');

  const check = async () => {
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
      <input lang="ko" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type or paste what you said" />
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
  const [recorded, setRecorded] = useState<Blob | null>(null);
  const [mime, setMime] = useState('audio/webm');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setRecorded(f);
    setMime(f.type || 'audio/webm');
  };

  const submit = async () => {
    if (!recorded) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await api.freeSpeech(null, recorded, mime);
      setMsg(res.queued ? 'Submitted — feedback will appear after grading.' : 'Submitted.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Free-response drill</h3>
      <div className="row">
        <p className="ko grow">{pack.speaking_prompt.ko}</p>
        <SpeakButton text={pack.speaking_prompt.ko} rate={rate} voiceUri={voiceUri} label="Hear prompt" />
      </div>
      <p className="small muted">
        On a phone this uses a short recording; on a desktop you can attach a file. Feedback appears on the newly
        created attempt.
      </p>
      <input type="file" accept="audio/*,video/*" onChange={onFile} />
      {recorded && (
        <button className="small primary" disabled={busy} onClick={submit}>
          {busy ? 'Uploading…' : 'Submit recording'}
        </button>
      )}
      {msg && <p className="small muted">{msg}</p>}
    </div>
  );
}