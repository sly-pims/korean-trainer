import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, humanizeLevel, timeEstimate } from '../api';
import type { HomeData, SessionWithPack } from '../types';
import { useCopy } from '../copy';

export function Home() {
  const { serverError } = useCopy();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { t } = useCopy();

  const load = async () => {
    setError('');
    try {
      setData(await api.home());
    } catch (err) {
      setError(serverError(err));
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
      setError(serverError(err));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="spinner" />;

  const s = data.todaySession;
  // English needs the plural; Korean has none, so both keys resolve to the
  // same string there. Splitting them keeps the sentence translatable instead
  // of concatenating a count onto an English noun.
  const streakText =
    data.settings.streak === 0
      ? t('home.streakNone')
      : t(data.settings.streak === 1 ? 'home.streakDay' : 'home.streakDays', {
          count: data.settings.streak,
        });
  return (
    <>
      <h1>{t('home.greeting')}</h1>
      <div className="row wrap">
        <div className="card grow">
          <div className="row">
            <span className="score-ring">{data.settings.streak}</span>
            <div className="grow">
              <p>
                <b>{t('home.streak')}</b>
              </p>
              <p className="small muted">
                {streakText}
              </p>
            </div>
          </div>
        </div>
        <div className="card grow">
          <p>
            <b>{t('common.level')}</b>
          </p>
          <p className="target-text">{humanizeLevel(data.settings.level, data.settings.lang.levels)}</p>
          <p className="small muted">~{timeEstimate(data.settings.level)} min per day</p>
        </div>
      </div>

      <Link className="card row" to="/history">
        <span className="grow">
          <b>{t('home.history')}</b>
          <span className="block small muted">{t('home.historyHint')}</span>
        </span>
        <span aria-hidden>&rsaquo;</span>
      </Link>

      {!s && (
        <button className="primary big-cta" disabled={busy} onClick={start}>
          {busy ? t('home.preparing') : t('home.begin')}
        </button>
      )}
      {s && (
        <Spotlight
          session={s}
          levelName={humanizeLevel(s.pack.level, data.settings.lang.levels)}
        />
      )}

      <div className="card">
        <p className="small muted">
          {t('home.howItWorks')}
        </p>
      </div>
    </>
  );
}

function Spotlight({ session, levelName }: { session: SessionWithPack; levelName: string }) {
  const { t } = useCopy();
  const done = session.session.status === 'done';
  const title = session.pack.title_target || levelName;
  return (
    <div className="card">
      <div className="row">
        <span className="steps-chip">{done ? t('common.complete') : session.session.current_step}</span>
        {done && session.session.read_score !== null && (
          <span className="tag">{t('home.readScore', { score: session.session.read_score })}</span>
        )}
      </div>
      <h2>{t('home.todaysLesson')}</h2>
      <p className="target-text">{title}</p>
      <p className="small muted">{t('home.packSummary', {
        level: levelName,
        sentences: session.pack.sentences.length,
        questions: session.pack.questions.length,
      })}</p>
      <ResumeButton sessionId={session.session.id} done={done} />
    </div>
  );
}

function ResumeButton({ sessionId, done }: { sessionId: number; done: boolean }) {
  const { t } = useCopy();
  return (
    <Link to={`/session/${sessionId}`}>
      <button className={done ? '' : 'primary big-cta'}>
        {done ? t('home.reviewToday') : t('home.continue')}
      </button>
    </Link>
  );
}