import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, formatDuration } from '../api';
import { DiffView } from '../components/DiffView';
import { WritingEvaluation } from '../components/Feedback';
import { SpeakButton, SpeakToggle } from '../components/SpeakButton';
import type {
  SessionDetail,
  SessionHistoryRow,
} from '../types';

// ---------------- List ----------------

export function History() {
  const nav = useNavigate();
  const [rows, setRows] = useState<SessionHistoryRow[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { sessions } = await api.sessions();
        setRows(sessions);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'could not load history');
      }
    })();
  }, []);

  if (err) return <div className="error-banner">{err}</div>;
  if (!rows) return <div className="spinner" />;

  return (
    <>
      <h2>History</h2>
      <p className="small muted">
        Every completed day, reopened read-only exactly as it happened — your answers, corrections and scores.
      </p>
      {rows.length === 0 && (
        <div className="card">
          <p className="muted">No completed sessions yet. Finish a daily session and it will show up here.</p>
        </div>
      )}
      {rows.map((s) => (
        <div
          key={s.id}
          className="card session-row link-card"
          role="link"
          tabIndex={0}
          onClick={() => nav(`/history/${s.id}`)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') nav(`/history/${s.id}`);
          }}
        >
          <div className="row">
            <span className="grow">
              <b>{formatDate(s.date)}</b>
            </span>
            {s.duration_s !== null && (
              <span className="small muted">{formatDuration(s.duration_s)}</span>
            )}
          </div>
          <p className="ko grow">{s.title_ko ?? s.topic}</p>
          <div className="row wrap score-row">
            {(
              [
                ['Read', s.read_score],
                ['Write', s.write_score],
                ['Listen', s.listen_score],
                ['Speak', s.speak_score],
                ['Vocab', s.vocab_score],
              ] as [string, number | null][]
            ).map(([label, v]) => (
              <span key={label} className="small muted">
                {label}{' '}
                {v === null ? (
                  '—'
                ) : (
                  <b className={v >= 60 ? '' : 'bad-text'}>{v}%</b>
                )}
              </span>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

// ---------------- Replay ----------------

export function HistoryReplay() {
  const { id } = useParams();
  const sessionId = Number(id);
  const nav = useNavigate();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { detail: d } = await api.sessionDetail(sessionId);
        setDetail(d);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'could not load replay');
      }
    })();
  }, [sessionId]);

  if (err && !detail) return <div className="error-banner">{err}</div>;
  if (!detail) return <div className="spinner" />;
  const d2 = detail;

  return (
    <>
      <div className="row">
        <h2 className="grow">{formatDate(d2.session.date)} — replay</h2>
        <button className="small" onClick={() => nav('/history')}>
          ← All days
        </button>
      </div>
      <div className="card">
        <p className="small muted">
          Read-only replay of a completed day. Nothing here can be changed.
        </p>
        <div className="row wrap">
          {(
            [
              ['Read', d2.session.read_score],
              ['Write', d2.session.write_score],
              ['Listen', d2.session.listen_score],
              ['Speak', d2.session.speak_score],
              ['Vocab', d2.session.vocab_score],
            ] as [string, number | null][]
          ).map(([label, v]) => (
            <span key={label} className="small muted">
              {label}{' '}
              {v === null ? (
                '—'
              ) : (
                <b className={v >= 60 ? '' : 'bad-text'}>{v}%</b>
              )}
            </span>
          ))}
        </div>
      </div>

      <h3>Reading</h3>
      <div className="card">
        <div className="row">
          <span className="small muted grow">passage</span>
          <SpeakButton text={d2.pack.passage_ko} rate={1} label="Play passage" />
        </div>
        <p className="ko">{d2.pack.passage_ko}</p>
        <p className="muted small">{d2.pack.passage_en}</p>
      </div>
      {d2.read.map((q) => (
        <div className="card" key={q.index}>
          <p className="ko">{q.q_ko}</p>
          <p className="muted small">{q.q_en}</p>
          {q.choices.map((c, ci) => {
            let cls = 'choice';
            if (ci === q.answer_index) cls += ' correct';
            else if (ci === q.chosen_index) cls += ' wrong';
            return (
              <div key={ci} className={cls}>
                {c}
                {ci === q.chosen_index && (
                  <span className="small muted"> · your answer</span>
                )}
              </div>
            );
          })}
          <p className="small muted">
            {q.chosen_index === null
              ? 'No answer recorded.'
              : q.correct
                ? 'Correct ✓'
                : 'Incorrect ✗'}{' '}
            {q.explanation_en}
          </p>
        </div>
      ))}

      <h3>Writing</h3>
      {d2.writing.length === 0 && (
        <div className="card">
          <p className="muted">Nothing written this day.</p>
        </div>
      )}
      {d2.writing.map((w) => (
        <div className="card" key={w.id}>
          <p className="small muted">prompt</p>
          <p className="ko">{w.prompt.ko}</p>
          <p className="muted small">{w.prompt.en}</p>
          <p className="small muted">your sentence</p>
          <p className="ko">{w.user_text}</p>
          {w.feedback ? (
            <>
              <p className="small muted">feedback</p>
              <WritingEvaluation feedback={w.feedback} rate={1} />
            </>
          ) : (
            <div className="card">
              <p className="muted small">
                Feedback wasn't available for this entry.
              </p>
            </div>
          )}
        </div>
      ))}

      <h3>Dictation</h3>
      {d2.dictation.length === 0 && (
        <div className="card">
          <p className="muted">No dictation recorded this day.</p>
        </div>
      )}
      {d2.dictation.map((di) => (
        <div className="card" key={di.id}>
          <div className="row">
            <span className="small muted grow">
              sentence {di.sentence_index + 1}
            </span>
            <span className="tag">{di.percent}%</span>
          </div>
          <p className="small muted">target</p>
          <p className="ko">{di.target_ko}</p>
          <p className="small muted">you typed</p>
          <p className="ko">{di.typed_text}</p>
          <DiffView segments={di.segments} />
        </div>
      ))}

      <h3>Speaking</h3>
      {d2.speaking.length === 0 && (
        <div className="card">
          <p className="muted">Nothing spoken this day.</p>
        </div>
      )}
      {d2.speaking.map((a) => (
        <div className="card" key={a.id}>
          <div className="row">
            <span className="small muted grow">
              {a.mode === 'read_aloud' ? 'read aloud' : 'free response'}
            </span>
            {a.percent !== null && <span className="tag">{a.percent}% match</span>}
          </div>
          {a.mode === 'read_aloud' ? (
            <>
              <p className="small muted">target</p>
              <p className="ko">{a.target}</p>
              <p className="small muted">you said</p>
              <p className="ko">{a.transcript ?? '—'}</p>
              {a.segments && <DiffView segments={a.segments} />}
            </>
          ) : (
            <>
              <p className="small muted">prompt</p>
              <p className="ko">{a.target ?? ''}</p>
              <p className="muted small">
                Your transcript and evaluation for this attempt weren't
                available in the replay.
              </p>
              <SpeakToggle text={a.target ?? ''} rate={1} />
            </>
          )}
        </div>
      ))}
    </>
  );
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  const base = d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return d.getFullYear() === new Date().getFullYear()
    ? base
    : `${base} ${d.getFullYear()}`;
}
