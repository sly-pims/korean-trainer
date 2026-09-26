import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, humanizeLevel, timeEstimate } from '../api';
import type { HomeData, SessionWithPack } from '../types';

export function Home() {
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError('');
    try {
      setData(await api.home());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load home');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const start = async () => {
    setBusy(true);
    try {
      const { session } = await api.startSession();
      setData({ ...(data as HomeData), todaySession: session });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="spinner" />;

  const s = data.todaySession;
  return (
    <>
      <h1>Hello 👋</h1>
      <div className="row wrap">
        <div className="card grow">
          <div className="row">
            <span className="score-ring">{data.settings.streak}</span>
            <div className="grow">
              <p>
                <b>Streak</b>
              </p>
              <p className="small muted">
                {data.settings.streak === 0 ? 'Start today to begin a streak!' : `${data.settings.streak} day${data.settings.streak === 1 ? '' : 's'} in a row`}
              </p>
            </div>
          </div>
        </div>
        <div className="card grow">
          <p>
            <b>Level</b>
          </p>
          <p className="target-text">{humanizeLevel(data.settings.level)}</p>
          <p className="small muted">~{timeEstimate(data.settings.level)} min per day</p>
        </div>
      </div>

      <Link className="card row" to="/history">
        <span className="grow">
          <b>History</b>
          <span className="block small muted">Review past sessions, replay any day</span>
        </span>
        <span aria-hidden>&rsaquo;</span>
      </Link>

      {!s && (
        <button className="primary big-cta" disabled={busy} onClick={start}>
          {busy ? 'Preparing…' : '▶ Begin today’s session'}
        </button>
      )}
      {s && <Spotlight session={s} />}

      <div className="card">
        <p className="small muted">
          Your trainer builds one <b>reading · vocab · writing · listening · speaking</b> session a day, tuned to your level. Tapped words are
          learned with spaced repetition, and tomorrow’s lesson is queued automatically.
        </p>
      </div>
    </>
  );
}

function Spotlight({ session }: { session: SessionWithPack }) {
  const done = session.session.status === 'done';
  const title = session.pack.title_target || `Level ${session.pack.level}`;
  return (
    <div className="card">
      <div className="row">
        <span className="steps-chip">{done ? 'complete' : session.session.current_step}</span>
        {done && session.session.read_score !== null && <span className="tag">read {session.session.read_score}%</span>}
      </div>
      <h2>Today’s lesson</h2>
      <p className="target-text">{title}</p>
      <p className="small muted">
        Level {session.pack.level} · {session.pack.sentences.length} sentences · {session.pack.questions.length} questions
      </p>
      <ResumeButton sessionId={session.session.id} done={done} />
    </div>
  );
}

function ResumeButton({ sessionId, done }: { sessionId: number; done: boolean }) {
  return (
    <Link to={`/session/${sessionId}`}>
      <button className={done ? '' : 'primary big-cta'}>{done ? 'Review today' : '▶ Continue'}</button>
    </Link>
  );
}