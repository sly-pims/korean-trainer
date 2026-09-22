import { useEffect, useState } from 'react';
import { api, formatDuration, humanizeLevel, scorePercent } from '../api';
import type { ProgressData } from '../types';

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

  return (
    <>
      <h2>Progress</h2>
      <div className="card row">
        <div className="grow">
          <div className="big-num">{settings.streak}</div>
          <div className="muted small">day streak</div>
        </div>
        <div className="grow">
          <div className="muted small">Level</div>
          <div className="big-num">{humanizeLevel(settings.level)}</div>
        </div>
        <div className="grow">
          <div className="muted small">Sessions</div>
          <div className="big-num">{sessions.length}</div>
        </div>
      </div>

      <StreakCalendar days={streakCalendar} lastDate={settings.last_session_date} />

      <h3>Recent sessions</h3>
      <div className="card">
        {sessions.length === 0 && <p className="muted">No sessions yet. Finished your first one today?</p>}
        {sessions.map((s, i) => (
          <div key={i} className="list-item">
            <span className="grow small">{s.date}</span>
            <ScoreRow label="R" value={s.read_score} color="read" />
            <ScoreRow label="W" value={s.write_score} color="write" />
            <ScoreRow label="L" value={s.listen_score} color="listen" />
            <ScoreRow label="S" value={s.speak_score} color="speak" />
            <ScoreRow label="V" value={s.vocab_score} color="vocab" />
            {s.duration_s !== null && <span className="muted small">{formatDuration(s.duration_s)}</span>}
          </div>
        ))}
      </div>

      <h3>Level history</h3>
      <div className="card">
        {history.length === 0 && <p className="muted">Level changes will appear here.</p>}
        {history.map((h, i) => (
          <div className="list-item" key={i}>
            <span className="grow small">{h.change_date}</span>
            <span className="small">
              L{h.from_level} → L{h.to_level}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function ScoreRow({ label, value, color }: { label: string; value: number | null; color: string }) {
  const pct = scorePercent(value);
  return (
    <span className={`score-chip ${color}`} title={`${label}: ${pct === null ? '—' : pct + '%'}`}>
      {label}
      {pct === null ? '' : pct}
    </span>
  );
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
      <div className="row small muted">
        {weekLabels.map((w, i) => (
          <span key={i} className="cal-cell-head">
            {w}
          </span>
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