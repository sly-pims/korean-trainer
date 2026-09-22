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

const KO_VOICES = [
  { id: 'ko-KR-SunHiNeural', label: 'SunHi — female (natural)' },
  { id: 'ko-KR-InJoonNeural', label: 'InJoon — male (natural)' },
  { id: 'ko-KR-HyunsuNeural', label: 'Hyunsu — male (natural)' },
];

const LEVEL_NOTES = [
  'Day 1 – greetings, hangul reading',
  'Basics: self-introduction, food, daily verbs',
  'Common travel & conversation vocabulary',
  'Intermediate: longer passages, past tense',
  'Upper-intermediate: opinion and narrative',
  'Advanced: near-native passages',
];

export function SettingsScreen() {
  const [s, setS] = useState<Settings | null>(null);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

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
        <p className="small muted">{LEVEL_NOTES[s.level] ?? ''}</p>
        <select id="level" value={s.level} onChange={(e) => patch({ level: Number(e.target.value) })}>
          {[1, 2, 3, 4, 5, 6].map((l) => (
            <option key={l} value={l}>
              {humanizeLevel(l)}
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
          {KO_VOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
          {s.tts_voice && !KO_VOICES.some((v) => v.id === s.tts_voice) && (
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
    </>
  );
}