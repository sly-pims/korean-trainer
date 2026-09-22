import { useEffect, useMemo, useState } from 'react';
import { api, posLabel } from '../api';
import { SpeakButton } from '../components/SpeakButton';
import type { Settings, WordRow } from '../types';

export function Words() {
  const [words, setWords] = useState<WordRow[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [query, setQuery] = useState('');
  const [err, setErr] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const reload = async () => {
    try {
      const [w, s] = await Promise.all([api.words(), api.getSettings()]);
      setWords(w.words);
      setSettings(s);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not load words');
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const filtered = useMemo(() => {
    if (!words) return [];
    const q = query.trim().toLowerCase();
    if (!q) return words;
    return words.filter(
      (w) =>
        w.lemma.toLowerCase().includes(q) ||
        w.meaning_en.toLowerCase().includes(q) ||
        w.surface_example.toLowerCase().includes(q),
    );
  }, [words, query]);

  if (err && !words) return <div className="error-banner">{err}</div>;
  if (!words || !settings) return <div className="spinner" />;

  return (
    <>
      <div className="row">
        <h2 className="grow">Word list</h2>
        <button className="small" onClick={() => setShowAdd((v) => !v)}>
          + Add
        </button>
      </div>
      <input placeholder="Search words (lemma / meaning)…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {showAdd && <AddWordForm onAdded={() => { setShowAdd(false); void reload(); }} onError={setErr} />}
      <div className="list">
        {filtered.length === 0 && <p className="muted">No words yet — tap words while reading to start your list.</p>}
        {filtered.map((w) => (
          <div className="card list-item" key={w.id}>
            <div className="grow">
              <div className="row">
                <span className="ko grow">{w.surface_example || w.lemma}</span>
                <SpeakButton text={w.lemma} rate={settings.tts_rate} voiceUri={settings.tts_voice} label={w.lemma} />
              </div>
              <div className="small">
                <span className="muted">{posLabel(w.pos)}</span> · {w.meaning_en}
              </div>
              {w.card?.due_date && (
                <div className={`small ${isDue(w.card.due_date) ? 'due' : 'muted'}`}>
                  {isDue(w.card.due_date) ? 'due now — review in warm-up' : `next: ${shortDate(w.card.due_date)}`}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function isDue(iso: string): boolean {
  const due = new Date(`${iso}T00:00:00`);
  return due.getTime() <= Date.now();
}

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function AddWordForm({ onAdded, onError }: { onAdded: () => void; onError: (e: string) => void }) {
  const [lemma, setLemma] = useState('');
  const [surface, setSurface] = useState('');
  const [meaning, setMeaning] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!lemma.trim() || !meaning.trim()) return;
    setBusy(true);
    try {
      await api.addWord({ lemma: lemma.trim(), surface: surface.trim() || lemma.trim(), meaning_en: meaning.trim() });
      onAdded();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'could not add word');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Add a word</h3>
      <input lang="ko" placeholder="Word (e.g. 사과)" value={lemma} onChange={(e) => setLemma(e.target.value)} />
      <input lang="ko" placeholder="Surface form (optional)" value={surface} onChange={(e) => setSurface(e.target.value)} />
      <input placeholder="Meaning in English" value={meaning} onChange={(e) => setMeaning(e.target.value)} />
      <button className="small primary" disabled={busy || lemma.trim() === '' || meaning.trim() === ''} onClick={add}>
        {busy ? 'Saving…' : 'Save word'}
      </button>
    </div>
  );
}