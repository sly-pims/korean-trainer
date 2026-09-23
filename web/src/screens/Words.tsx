import { useEffect, useMemo, useState } from 'react';
import { api, posLabel } from '../api';
import { SrsCard } from '../components/SrsCard';
import { SpeakButton } from '../components/SpeakButton';
import { useSrsReview } from '../hooks/useSrsReview';
import type { Settings, WordRow, WordSuggestion } from '../types';

type DueFilter = 'all' | 'due' | 'later';

const SOURCE_LABEL: Record<string, string> = {
  reading: 'tapped in reading',
  manual: 'added',
  suggested: 'suggested',
};

export function Words() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <>
      <PracticeCard onReviewed={() => setRefreshKey((k) => k + 1)} />
      <BrowseCard refreshKey={refreshKey} />
      <DiscoverCard onChanged={() => setRefreshKey((k) => k + 1)} />
    </>
  );
}

// ---------------- Practice due cards ----------------

function PracticeCard({ onReviewed }: { onReviewed: () => void }) {
  const { cards, dueTotal, busyId, err, load, review } = useSrsReview();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    void api.getSettings().then(setSettings);
  }, []);

  const reviewAndRefresh = async (wordId: number, rating: import('../types').SrsRating) => {
    await review(wordId, rating);
    onReviewed();
  };

  return (
    <div className="card">
      <div className="row">
        <div className="grow">
          <b>SRS review</b>
          <p className="small muted">
            {cards === null ? '…' : dueTotal === 0 ? 'No words due right now.' : `${dueTotal} due now`}
            {open && cards !== null && cards.length > 0 ? ' · ' : ''}
          </p>
        </div>
        <button className="primary small" disabled={open} onClick={() => setOpen(true)}>
          Practice
        </button>
      </div>
      {open && (
        <>
          {err && <div className="error-banner">{err}</div>}
          {cards && cards.length > 0 ? (
            <>
              {settings && (
                <SrsCard
                  cards={cards}
                  busy={busyId}
                  rate={settings.tts_rate}
                  voiceUri={settings.tts_voice}
                  onReview={reviewAndRefresh}
                />
              )}
              <button className="ghost" onClick={() => { setOpen(false); void load(); }}>
                Stop practice
              </button>
            </>
          ) : (
            <p className="muted">All clear — nothing due.</p>
          )}
        </>
      )}
    </div>
  );
}

// ---------------- Browse & search ----------------

function BrowseCard({ refreshKey }: { refreshKey: number }) {
  const [words, setWords] = useState<WordRow[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [query, setQuery] = useState('');
  const [dueFilter, setDueFilter] = useState<DueFilter>('all');
  const [levelFilter, setLevelFilter] = useState(0);
  const [openIds, setOpenIds] = useState<Record<number, boolean>>({});
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const filtered = useMemo(() => {
    if (!words) return [];
    const q = query.trim().toLowerCase();
    return words.filter((w) => {
      if (q && !w.lemma.toLowerCase().includes(q) && !w.meaning_en.toLowerCase().includes(q) && !(w.surface_example ?? '').toLowerCase().includes(q)) {
        return false;
      }
      if (dueFilter !== 'all') {
        const due = w.card?.due_date ? isDue(w.card.due_date) : true;
        if (dueFilter === 'due' && !due) return false;
        if (dueFilter === 'later' && due) return false;
      }
      if (levelFilter > 0 && w.level !== levelFilter) return false;
      return true;
    });
  }, [words, query, dueFilter, levelFilter]);

  if (err && !words) return <div className="error-banner">{err}</div>;
  if (!words || !settings) return <div className="spinner" />;

  return (
    <div className="card">
      <div className="row">
        <h3 className="grow">Word list</h3>
        <button className="small" onClick={() => setShowAdd((v) => !v)}>
          + Add
        </button>
      </div>
      <input placeholder="Search words (lemma / meaning)…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="row wrap">
        {(['all', 'due', 'later'] as DueFilter[]).map((f) => (
          <button
            key={f}
            className={`small ${dueFilter === f ? 'primary' : ''}`}
            onClick={() => setDueFilter(f)}
          >
            {f === 'all' ? 'All' : f === 'due' ? 'Due now' : 'Not due yet'}
          </button>
        ))}
        <select
          className="small"
          value={levelFilter}
          onChange={(e) => setLevelFilter(Number(e.target.value))}
          aria-label="Filter by level"
        >
          <option value={0}>All levels</option>
          {[1, 2, 3, 4, 5, 6].map((l) => (
            <option key={l} value={l}>
              Level {l}
            </option>
          ))}
        </select>
      </div>
      {showAdd && <AddWordForm defaultLevel={settings.level} onAdded={() => { setShowAdd(false); void reload(); }} onError={setErr} />}
      <div className="list">
        {filtered.length === 0 && <p className="muted">No words match — tap words while reading to grow your list.</p>}
        {filtered.map((w) => (
          <WordRowItem
            key={w.id}
            w={w}
            open={!!openIds[w.id]}
            rate={settings.tts_rate}
            voiceUri={settings.tts_voice}
            onToggle={() => setOpenIds((m) => ({ ...m, [w.id]: !m[w.id] }))}
          />
        ))}
      </div>
    </div>
  );
}

function WordRowItem({
  w,
  open,
  rate,
  voiceUri,
  onToggle,
}: {
  w: WordRow;
  open: boolean;
  rate: number;
  voiceUri: string;
  onToggle: () => void;
}) {
  const due = w.card?.due_date ? isDue(w.card.due_date) : true;
  return (
    <div className="row list-item">
      <div className="grow" onClick={onToggle}>
        <div className="row">
          <span className="ko grow">{w.lemma}</span>
        </div>
        <div className="small">
          <span className="muted">{posLabel(w.pos)}</span> · {w.meaning_en}
        </div>
        {open ? (
          <div className="small muted">
            <p>
              example: <span lang="ko">{w.example_ko || w.surface_example}</span>
              {w.example_en ? ` — ${w.example_en}` : ''}
            </p>
            <p>
              source: {SOURCE_LABEL[w.source ?? 'reading'] ?? w.source} · level {w.level}
            </p>
            {w.card && (
              <p>
                next review {shortDate(w.card.due_date)} · interval {w.card.interval_days}d · reps {w.card.reps} · lapses {w.card.lapses}
              </p>
            )}
          </div>
        ) : (
          <div className={`small ${due ? 'due' : 'muted'}`}>
            {due ? 'due now' : `next: ${shortDate(w.card?.due_date ?? '')}`}
            {w.card ? ` · every ${w.card.interval_days}d` : ''}
          </div>
        )}
      </div>
      <SpeakButton text={w.lemma} rate={rate} voiceUri={voiceUri} label={w.lemma} />
    </div>
  );
}

// ---------------- Add manually ----------------

function AddWordForm({
  defaultLevel,
  onAdded,
  onError,
}: {
  defaultLevel: number;
  onAdded: () => void;
  onError: (e: string) => void;
}) {
  const [lemma, setLemma] = useState('');
  const [meaning, setMeaning] = useState('');
  const [example, setExample] = useState('');
  const [level, setLevel] = useState(defaultLevel);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!lemma.trim() || !meaning.trim()) return;
    setBusy(true);
    try {
      await api.addWord({
        lemma: lemma.trim(),
        surface: lemma.trim(),
        meaning_en: meaning.trim(),
        example_ko: example.trim() || undefined,
        level,
        source: 'manual',
      });
      onAdded();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'could not add word');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h4>Add a word</h4>
      <input lang="ko" placeholder="Word (e.g. 사과)" value={lemma} onChange={(e) => setLemma(e.target.value)} />
      <input placeholder="Meaning in English" value={meaning} onChange={(e) => setMeaning(e.target.value)} />
      <input lang="ko" placeholder="Example sentence (optional)" value={example} onChange={(e) => setExample(e.target.value)} />
      <div className="controls">
        <label className="control">
          <span className="small muted">Level</span>
          <select id="add-level" value={level} onChange={(e) => setLevel(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((l) => (
              <option key={l} value={l}>
                Level {l}
              </option>
            ))}
          </select>
        </label>
        <button
          className="control-suggest primary small"
          disabled={busy || lemma.trim() === '' || meaning.trim() === ''}
          onClick={add}
        >
          {busy ? 'Saving…' : 'Save word'}
        </button>
      </div>
    </div>
  );
}

// ---------------- Discover (LLM suggestions) ----------------

function DiscoverCard({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState('');
  const [count, setCount] = useState(5);
  const [level, setLevel] = useState(1);
  const [suggestions, setSuggestions] = useState<WordSuggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(0);

  useEffect(() => {
    void api.getSettings().then((s) => setLevel(s.level));
  }, []);

  const run = async () => {
    setBusy(true);
    setErr('');
    setAdded({});
    setSaved(0);
    try {
      const { suggestions } = await api.suggestWords({
        level,
        topic: topic.trim() || undefined,
        count,
      });
      setSuggestions(suggestions);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not get suggestions');
    } finally {
      setBusy(false);
    }
  };

  const addOne = async (s: WordSuggestion) => {
    if (added[s.lemma]) return;
    try {
      await api.addWord({
        lemma: s.lemma,
        surface: s.lemma,
        meaning_en: s.meaning_en,
        pos: s.pos,
        level,
        source: 'suggested',
        example_ko: s.example_ko,
        example_en: s.example_en,
      });
      setAdded((m) => ({ ...m, [s.lemma]: true }));
      setSaved((n) => n + 1);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not add word');
    }
  };

  const addAll = async () => {
    for (const s of suggestions ?? []) await addOne(s);
  };

  return (
    <div className="card">
      <div className="row">
        <div className="grow">
          <b>Discover new words</b>
          <p className="small muted">Ask the trainer for fresh vocabulary to grow your list.</p>
        </div>
        <button className="small primary" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Suggest words'}
        </button>
      </div>
      {open && (
        <div className="stack">
          <input placeholder="Optional topic (e.g. cooking, travel)…" value={topic} onChange={(e) => setTopic(e.target.value)} />
          <div className="controls">
            <label className="control">
              <span className="small muted">Match my level</span>
              <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6].map((l) => (
                  <option key={l} value={l}>
                    Level {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="control">
              <span className="small muted">How many</span>
              <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
                {[3, 5, 10].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <button className="control-suggest primary small" disabled={busy} onClick={run}>
              {busy ? 'Thinking…' : 'Suggest'}
            </button>
          </div>
          {err && <div className="error-banner">{err}</div>}
          {suggestions && (
            <>
              <div className="row">
                <p className="small muted grow">
                  {suggestions.length === 0 ? 'Nothing new found — your list already covers the topic.' : `${suggestions.length} suggestions`}
                  {saved > 0 ? ` · ${saved} saved` : ''}
                </p>
                {suggestions.length > 0 && <button className="small" onClick={addAll}>Add all</button>}
              </div>
              <div className="list">
                {suggestions.map((s) => (
                  <div className="row list-item" key={s.lemma}>
                    <div className="grow">
                      <div className="row">
                        <span className="ko grow">{s.lemma}</span>
                        <span className="small muted">{posLabel(s.pos)}</span>
                      </div>
                      <div className="small muted">{s.meaning_en}</div>
                      <div className="small muted">
                        <span lang="ko">{s.example_ko}</span> — {s.example_en}
                      </div>
                    </div>
                    <button className="small" disabled={added[s.lemma]} onClick={() => addOne(s)}>
                      {added[s.lemma] ? 'Added' : 'Add'}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function isDue(iso: string): boolean {
  const due = new Date(`${iso}T00:00:00`);
  return !isNaN(due.getTime()) && due.getTime() <= Date.now();
}

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}