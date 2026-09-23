import { useEffect, useState } from 'react';
import { api, formatDuration, humanizeLevel } from '../api';
import type { ProgressData } from '../types';

const SKILLS = [
  { key: 'read_score', label: 'Reading', color: 'read', hint: 'comprehension check' },
  { key: 'write_score', label: 'Writing', color: 'write', hint: 'your free-written note' },
  { key: 'listen_score', label: 'Listening', color: 'listen', hint: 'dictation' },
  { key: 'speak_score', label: 'Speaking', color: 'speak', hint: 'read-aloud & speaking' },
  { key: 'vocab_score', label: 'Vocab', color: 'vocab', hint: 'word review' },
] as const;

export function Progress() {
  const [data, setData] = useState<ProgressData | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setData(await api.progress());
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'could not load progress');
      }
    })();
  }, []);

  if (err && !data) return <div className="error-banner">{err}</div>;
  if (!data) return <div className="spinner" />;

  const { settings, sessions, streakCalendar, history } = data;
  const todayIso = toIso(new Date());

  return (
    <>
      <h2>Progress</h2>
      <div className="card row">
        <div className="grow">
          <div className="big-num">{settings.streak}</div>
          <div className="stat-label">day streak</div>
        </div>
        <div className="grow">
          <div className="stat-label">Level</div>
          <div className="big-num">{humanizeLevel(settings.level)}</div>
        </div>
        <div className="grow">
          <div className="stat-label">Sessions done</div>
          <div className="big-num">{sessions.length}</div>
        </div>
      </div>

      <StreakCalendar days={streakCalendar} lastDate={settings.last_session_date} />

      <h3>Recent sessions</h3>
      <p className="small muted">
        Each row is one day's session. Scores are <b>% correct</b>; <b>—</b> means that skill was skipped.
      </p>
      <div className="card">
        {sessions.length === 0 && <p className="muted">No sessions yet. Finished your first one today?</p>}
        {sessions.map((s, i) => (
          <div className="session-row" key={i}>
            <div className="row">
              <span className="session-date grow">
                {formatDate(s.date)}
                {s.date === todayIso && <em className="today-tag">today</em>}
              </span>
              {s.duration_s !== null && <span className="small muted">{formatDuration(s.duration_s)}</span>}
            </div>
            <div className="row wrap score-row">
              {SKILLS.map((k) => (
                <ScoreChip key={k.key} label={k.label} value={s[k.key] as number | null} color={k.color} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="row wrap">
          {SKILLS.map((k) => (
            <span key={k.key} className="small muted legend-item">
              <span className={`dot ${k.color}`} /> {k.label} = {k.hint}
            </span>
          ))}
        </div>
      </div>

      <h3>Level history</h3>
      <div className="card">
        {history.length === 0 && <p className="muted">Level changes will appear here.</p>}
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
  const last = lastDate ? new Date(`${lastDate}T00:00:00`) : new Date();
  const start = new Date(last);
  start.setDate(start.getDate() - 41); // ~6 weeks back
  const cells: { date: Date; active: boolean; today: boolean }[] = [];
  for (let d = new Date(start); d <= last; d.setDate(d.getDate() + 1)) {
    const iso = toIso(d);
    cells.push({ date: new Date(d), active: days.includes(iso), today: iso === toIso(new Date()) });
  }
  const weekLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
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
      <p className="small muted">Every lit day is a completed session.</p>
    </div>
  );
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}