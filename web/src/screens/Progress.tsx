import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, formatDuration, humanizeLevel, timeEstimate } from '../api';
import type { ProgressData } from '../types';
import { useCopy } from '../copy';
import type { CopyKey } from '../copy';

type ScoreKey =
  | 'read_score'
  | 'write_score'
  | 'listen_score'
  | 'speak_score'
  | 'vocab_score';

const SKILLS: { key: ScoreKey; label: CopyKey; color: string; hint: CopyKey }[] = [
  { key: 'read_score', label: 'progress.skill.reading', color: 'read', hint: 'progress.skill.readingHint' },
  { key: 'write_score', label: 'progress.skill.writing', color: 'write', hint: 'progress.skill.writingHint' },
  { key: 'listen_score', label: 'progress.skill.listening', color: 'listen', hint: 'progress.skill.listeningHint' },
  { key: 'speak_score', label: 'progress.skill.speaking', color: 'speak', hint: 'progress.skill.speakingHint' },
  { key: 'vocab_score', label: 'progress.skill.vocab', color: 'vocab', hint: 'progress.skill.vocabHint' },
];

export function Progress() {
  const navto = useNavigate();
  const [data, setData] = useState<ProgressData | null>(null);
  const { t, serverError } = useCopy();
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setData(await api.progress());
      } catch (e) {
        setErr(serverError(e));
      }
    })();
  }, []);

  if (err && !data) return <div className="error-banner">{err}</div>;
  if (!data) return <div className="spinner" />;

  const { settings, sessions, streakCalendar, history } = data;
  const todayIso = toIso(new Date());

  return (
    <>
      <h2>{t('progress.title')}</h2>
      <div className="card progress-header">
        <div className="header-stat header-level">
          <div className="level-name">{humanizeLevel(settings.level, settings.lang.levels)}</div>
          <div className="stat-label">{t('common.level')}</div>
          <div className="small muted">~{timeEstimate(settings.level)} min/day</div>
        </div>
        <div className="header-stat">
          <div className="big-num">{sessions.length}</div>
          <div className="stat-label">{t('progress.sessionsDone')}</div>
        </div>
        <div className="header-stat header-streak">
          <div className="big-num">{settings.streak}</div>
          <div className="stat-label">{t('progress.dayStreak')}</div>
        </div>
      </div>

      <StreakCalendar days={streakCalendar} lastDate={settings.last_session_date} />

      <h3>{t('progress.recentSessions')}</h3>
      <p className="small muted">{t('progress.tableNote')}</p>
      <div className="card">
        {sessions.length === 0 && <p className="muted">{t('progress.noSessions')}</p>}
        {sessions.map((s, i) => (
          <div
            className="session-row"
            key={i}
            role="link"
            tabIndex={0}
onClick={() => navto(`/history/${s.id}`)}
onKeyDown={(e) => {
  if (e.key === 'Enter') navto(`/history/${s.id}`);
}}
          >
            <div className="row">
              <span className="session-date grow">
                {formatDate(s.date)}
                {s.date === todayIso && <em className="today-tag">{t('common.today')}</em>}
              </span>
              {s.duration_s !== null && <span className="small muted">{formatDuration(s.duration_s)}</span>}
            </div>
            <div className="row wrap score-row">
              {SKILLS.map((k) => (
                <ScoreChip key={k.key} label={t(k.label)} value={s[k.key] as number | null} color={k.color} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="row wrap">
          {SKILLS.map((k) => (
            <span key={k.key} className="small muted legend-item">
              <span className={`dot ${k.color}`} /> {t(k.label)} = {t(k.hint)}
            </span>
          ))}
        </div>
      </div>

      <h3>{t('progress.levelHistory')}</h3>
      <div className="card">
        {history.length === 0 && <p className="muted">{t('progress.noLevelChanges')}</p>}
        {history.map((h, i) => (
          <div className="list-item" key={i}>
            <span className="grow small">{formatDate(h.change_date)}</span>
            <span className="small">
              Level {h.from_level} → Level {h.to_level}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function ScoreChip({ label, value, color }: { label: string; value: number | null; color: string }) {
  const skipped = value === null || value === undefined;
  return (
    <span className={`score-chip ${color} ${skipped ? 'skipped' : ''}`}>
      <span className="score-chip-label">{label}</span>
      {skipped ? '—' : `${value}%`}
    </span>
  );
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  const base = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return d.getFullYear() === new Date().getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

function StreakCalendar({ days, lastDate }: { days: string[]; lastDate: string | null }) {
  const { t } = useCopy();
  const last = lastDate ? new Date(`${lastDate}T00:00:00`) : new Date();
  const start = new Date(last);
  start.setDate(start.getDate() - 41); // ~6 weeks back
  const cells: { date: Date; active: boolean; today: boolean }[] = [];
  for (let d = new Date(start); d <= last; d.setDate(d.getDate() + 1)) {
    const iso = toIso(d);
    cells.push({ date: new Date(d), active: days.includes(iso), today: iso === toIso(new Date()) });
  }
  // Weekday initials from the runtime locale rather than a hardcoded
  // S M T W T F S, which is only right in English.
  const weekLabels = Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'narrow' }),
  );
  return (
    <div className="card">
      <div className="cal-grid cal-heads">
        {weekLabels.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
      <div className="cal-grid">
        {cells.map((c, i) => (
          <span
            key={i}
            className={`cal-cell ${c.active ? 'active' : ''} ${c.today ? 'today' : ''}`}
            title={c.date.toLocaleDateString()}
          />
        ))}
      </div>
      <p className="small muted">{t('progress.everyLitDay')}</p>
    </div>
  );
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}