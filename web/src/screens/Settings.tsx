import { useEffect, useState } from 'react';
import { api, humanizeLevel } from '../api';
import type { Settings } from '../types';

const IANA_TZ = [
  'Asia/Seoul',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Taipei',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Vancouver',
  'Australia/Sydney',
  'Australia/Perth',
  'Pacific/Auckland',
  'Etc/UTC',
];

/**
 * The voices to offer, from the active language's own allowlist.
 *
 * This was a hardcoded list of three Korean voices — the profile has six, so
 * three of them were unreachable — and nothing at all for any other language.
 * The server refuses a voice outside `lang.voices`, so this list is also the
 * only set of options that will actually work.
 */
function voiceOptions(voices: string[]): { id: string; label: string }[] {
  return voices.map((id) => ({ id, label: id.replace(/^[a-z]{2}-[A-Z]{2}-/, '').replace(/Neural$/, '') }));
}

export function SettingsScreen() {
  const [s, setS] = useState<Settings | null>(null);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setS(await api.getSettings());
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'could not load settings');
      }
    })();
  }, []);

  if (err && !s) return <div className="error-banner">{err}</div>;
  if (!s) return <div className="spinner" />;

  const patch = (p: Partial<Settings>) => setS((cur) => (cur ? { ...cur, ...p } : cur));

  const reset = async () => {
    // The server's reset always lands on level 1, so name it from the profile
    // rather than writing "Beginner 1" into an English sentence.
    const ok = window.confirm(
      `Reset ALL progress? This deletes every session, word, writing entry and speaking attempt, sets your level back to ${humanizeLevel(1, s.lang.levels)} and clears the streak. Voice/speed settings are kept. This cannot be undone.`,
    );
    if (!ok) return;
    setResetting(true);
    setResetMsg(null);
    try {
      const r = await api.resetProgress();
      setResetMsg(r.ok ? { text: 'Progress reset — you are ready to start from scratch.', error: false } : { text: 'Reset reported a problem.', error: true });
    } catch (e) {
      setResetMsg({ text: e instanceof Error ? e.message : 'reset failed', error: true });
    } finally {
      setResetting(false);
    }
  };

  const save = async () => {
    if (!s) return;
    setBusy(true);
    setSaved('');
    try {
      const next = await api.updateSettings({
        level: s.level,
        tts_rate: s.tts_rate,
        tts_voice: s.tts_voice,
        show_romanization: s.show_romanization,
        keep_recordings_days: s.keep_recordings_days,
        timezone: s.timezone,
      });
      setS(next);
      setSaved('Saved ✓');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>Settings</h2>
      {err && <div className="error-banner">{err}</div>}

      <div className="card">
        <label htmlFor="level">Level</label>
        <p className="small muted">{s.lang.levels[String(s.level)]?.note ?? ''}</p>
        <select id="level" value={s.level} onChange={(e) => patch({ level: Number(e.target.value) })}>
          {[1, 2, 3, 4, 5, 6].map((l) => (
            <option key={l} value={l}>
              {humanizeLevel(l, s.lang.levels)}
            </option>
          ))}
        </select>

        <label htmlFor="tts_rate">Speech speed ×{s.tts_rate.toFixed(2)}</label>
        <input
          id="tts_rate"
          type="range"
          min={0.75}
          max={1.5}
          step={0.05}
          value={s.tts_rate}
          onChange={(e) => patch({ tts_rate: Number(e.target.value) })}
        />

        <label htmlFor="tts_voice">Voice</label>
        <select id="tts_voice" value={s.tts_voice} onChange={(e) => patch({ tts_voice: e.target.value })}>
          {voiceOptions(s.lang.voices).map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
          {/* A voice the server no longer offers (the language list changed under
              a saved setting) stays visible rather than silently resetting the
              select. readSettings already substitutes the default, so this only
              triggers on a value the client set and the server has not re-read. */}
          {s.tts_voice && !s.lang.voices.includes(s.tts_voice) && (
            <option value={s.tts_voice}>{s.tts_voice}</option>
          )}
        </select>

        <label className="row">
          <span>
            Show romanization:
            <span className="small muted"> (rendered next to passages)</span>
          </span>
          <input
            type="checkbox"
            checked={s.show_romanization}
            onChange={(e) => patch({ show_romanization: e.target.checked })}
          />
        </label>

        <label htmlFor="keep">Keep recordings (days)</label>
        <select
          id="keep"
          value={s.keep_recordings_days}
          onChange={(e) => patch({ keep_recordings_days: Number(e.target.value) })}
        >
          {[0, 7, 14, 30, 90].map((d) => (
            <option key={d} value={d}>
              {d === 0 ? 'Never keep' : `${d} days`}
            </option>
          ))}
        </select>

        <label htmlFor="tz">Timezone</label>
        <select id="tz" value={s.timezone} onChange={(e) => patch({ timezone: e.target.value })}>
          {IANA_TZ.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
          {s.timezone && !IANA_TZ.includes(s.timezone) && <option value={s.timezone}>{s.timezone}</option>}
        </select>
      </div>

      <div className="row">
        <button className="primary big-cta" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        {saved && <span className="small muted">{saved}</span>}
      </div>

      <h3 style={{ marginTop: 24 }}>Danger zone</h3>
      <div className="card">
        <p className="small muted">
          Reset ALL progress: every session, word, writing entry and speaking attempt is deleted, your level returns to{' '}
          {humanizeLevel(1, s.lang.levels)} and the streak is cleared. Voice/speed settings are kept. This cannot be undone.
        </p>
        <button className="danger" disabled={resetting} onClick={reset}>
          {resetting ? 'Resetting…' : 'Reset all progress'}
        </button>
        {resetMsg && <p className={`small ${resetMsg.error ? 'error-banner' : 'muted'}`}>{resetMsg.text}</p>}
      </div>
    </>
  );
}