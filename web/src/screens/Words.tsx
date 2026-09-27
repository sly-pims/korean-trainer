import { useEffect, useMemo, useState } from 'react';
import { api, humanizeLevel, posLabel } from '../api';
import { SrsCard } from '../components/SrsCard';
import { SpeakButton } from '../components/SpeakButton';
import { useSrsReview } from '../hooks/useSrsReview';
import { useCopy } from '../copy';
import type { LanguageDescriptor, Settings, WordRow, WordSuggestion } from '../types';

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
  const { t } = useCopy();
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
          <b>{t('words.srsReview')}</b>
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
                  lang={settings.lang}
                  onReview={reviewAndRefresh}
                />
              )}
              <button className="ghost" onClick={() => { setOpen(false); void load(); }}>
                Stop practice
              </button>
            </>
          ) : (
            <p className="muted">{t('words.allClear')}</p>
          )}
        </>
      )}
    </div>
  );
}

// ---------------- Browse & search ----------------

function BrowseCard({ refreshKey }: { refreshKey: number }) {
  const { t, serverError } = useCopy();
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
      setErr(serverError(e));
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
      if (q && !w.lemma.toLowerCase().includes(q) && !w.meaning_native.toLowerCase().includes(q) && !(w.surface_example ?? '').toLowerCase().includes(q)) {
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
        <h3 className="grow">{t('words.listTitle')}</h3>
        <button className="small" onClick={() => setShowAdd((v) => !v)}>
          + {t('common.add')}
        </button>
      </div>
      <input placeholder={t('words.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="row wrap">
        {(['all', 'due', 'later'] as DueFilter[]).map((f) => (
          <button
            key={f}
            className={`small ${dueFilter === f ? 'primary' : ''}`}
            onClick={() => setDueFilter(f)}
          >
            {f === 'all' ? t('words.all') : f === 'due' ? t('words.due') : t('words.later')}
          </button>
        ))}
        <select
          className="small"
          value={levelFilter}
          onChange={(e) => setLevelFilter(Number(e.target.value))}
          aria-label={t('words.filterByLevel')}
        >
          <option value={0}>{t('common.allLevels')}</option>
          {[1, 2, 3, 4, 5, 6].map((l) => (
            <option key={l} value={l}>
              {humanizeLevel(l, settings.lang.levels)}
            </option>
          ))}
        </select>
      </div>
      {showAdd && <AddWordForm defaultLevel={settings.level} lang={settings.lang} onAdded={() => { setShowAdd(false); void reload(); }} onError={setErr} />}
      <div className="list">
        {filtered.length === 0 && <p className="muted">{t('words.noMatch')}</p>}
        {filtered.map((w) => (
          <WordRowItem
            key={w.id}
            w={w}
            open={!!openIds[w.id]}
            rate={settings.tts_rate}
            voiceUri={settings.tts_voice}
            lang={settings.lang}
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
  lang,
  onToggle,
}: {
  w: WordRow;
  open: boolean;
  rate: number;
  voiceUri: string;
  lang: LanguageDescriptor;
  onToggle: () => void;
}) {
  const { t } = useCopy();
  const due = w.card?.due_date ? isDue(w.card.due_date) : true;
  return (
    <div className="row list-item">
      <div className="grow" onClick={onToggle}>
        <div className="row">
          <span className="target-text grow">{w.lemma}</span>
        </div>
        <div className="small">
          <span className="muted">{posLabel(w.pos)}</span> · {w.meaning_native}
        </div>
        {open ? (
          <div className="small muted">
            <p>
              {t('words.labelExample')}:{' '}
              <span lang={lang.htmlLang}>{w.example_target || w.surface_example}</span>
              {w.example_native ? ` — ${w.example_native}` : ''}
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
      <SpeakButton text={w.lemma} rate={rate} voiceUri={voiceUri} lang={lang} label="speak.playWord" labelParams={{ word: w.lemma }} />
    </div>
  );
}

// ---------------- Add manually ----------------

function AddWordForm({
  defaultLevel,
  lang,
  onAdded,
  onError,
}: {
  defaultLevel: number;
  lang: LanguageDescriptor;
  onAdded: () => void;
  onError: (e: string) => void;
}) {
  const { t, serverError } = useCopy();
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
        meaning_native: meaning.trim(),
        example_target: example.trim() || undefined,
        level,
        source: 'manual',
      });
      onAdded();
    } catch (e) {
      onError(serverError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h4>{t('words.addTitle')}</h4>
      <input lang={lang.htmlLang} placeholder={t('words.addLemmaPlaceholder', { example: lang.lexiconExample })} value={lemma} onChange={(e) => setLemma(e.target.value)} />
      <input placeholder={t('words.addMeaningPlaceholder')} value={meaning} onChange={(e) => setMeaning(e.target.value)} />
      <input lang={lang.htmlLang} placeholder={t('words.addExamplePlaceholder')} value={example} onChange={(e) => setExample(e.target.value)} />
      <div className="controls">
        <label className="control">
          <span className="small muted">{t('common.level')}</span>
          <select id="add-level" value={level} onChange={(e) => setLevel(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((l) => (
              <option key={l} value={l}>
              {humanizeLevel(l, lang.levels)}
            </option>
            ))}
          </select>
        </label>
        <button
          className="control-suggest primary small"
          disabled={busy || lemma.trim() === '' || meaning.trim() === ''}
          onClick={add}
        >
          {busy ? t('words.saving') : t('words.saveWord')}
        </button>
      </div>
    </div>
  );
}

// ---------------- Discover (LLM suggestions) ----------------

function DiscoverCard({ onChanged }: { onChanged: () => void }) {
  const { t, serverError } = useCopy();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState('');
  const [count, setCount] = useState(5);
  const [level, setLevel] = useState(1);
  const [suggestions, setSuggestions] = useState<WordSuggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(0);
  // Kept whole, not just the level: the suggestion examples need htmlLang.
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    void api.getSettings().then((s) => {
      setLevel(s.level);
      setSettings(s);
    });
  }, []);

  // Settings carry htmlLang, which decides how the example is announced and
  // which font the browser picks, so the card waits for them like the others.
  if (!settings) return <div className="spinner" />;

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
      setErr(serverError(e));
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
        meaning_native: s.meaning_native,
        pos: s.pos,
        level,
        source: 'suggested',
        example_target: s.example_target,
        example_native: s.example_native,
      });
      setAdded((m) => ({ ...m, [s.lemma]: true }));
      setSaved((n) => n + 1);
      onChanged();
    } catch (e) {
      setErr(serverError(e));
    }
  };

  const addAll = async () => {
    for (const s of suggestions ?? []) await addOne(s);
  };

  return (
    <div className="card">
      <div className="row">
        <div className="grow">
          <b>{t('words.discoverTitle')}</b>
          <p className="small muted">{t('words.discoverHint')}</p>
        </div>
        <button className="small primary" onClick={() => setOpen((v) => !v)}>
          {open ? t('words.hide') : t('words.suggestWords')}
        </button>
      </div>
      {open && (
        <div className="stack">
          <input placeholder={t('words.topicPlaceholder')} value={topic} onChange={(e) => setTopic(e.target.value)} />
          <div className="controls">
            <label className="control">
              <span className="small muted">{t('words.matchLevel')}</span>
              <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6].map((l) => (
                  <option key={l} value={l}>
                    {/* Before settings arrive there is nothing to name the level
                        with, so show the bare number rather than a proficiency
                        label that would belong to another language's scale. */}
                    {settings ? humanizeLevel(l, settings.lang.levels) : l}
                  </option>
                ))}
              </select>
            </label>
            <label className="control">
              <span className="small muted">{t('words.howMany')}</span>
              <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
                {[3, 5, 10].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <button className="control-suggest primary small" disabled={busy} onClick={run}>
              {busy ? t('words.thinking') : t('words.suggest')}
            </button>
          </div>
          {err && <div className="error-banner">{err}</div>}
          {suggestions && (
            <>
              <div className="row">
                <p className="small muted grow">
                  {suggestions.length === 0 ? t('words.nothingNew') : t('words.nSuggestions', { count: suggestions.length })}
                  {saved > 0 ? ` · ${t('words.nSaved', { saved })}` : ''}
                </p>
                {suggestions.length > 0 && <button className="small" onClick={addAll}>{t('common.addAll')}</button>}
              </div>
              <div className="list">
                {suggestions.map((s) => (
                  <div className="row list-item" key={s.lemma}>
                    <div className="grow">
                      <div className="row">
                        <span className="target-text grow">{s.lemma}</span>
                        <span className="small muted">{posLabel(s.pos)}</span>
                      </div>
                      <div className="small muted">{s.meaning_native}</div>
                      <div className="small muted">
                        <span lang={settings.lang.htmlLang}>{s.example_target}</span> — {s.example_native}
                      </div>
                    </div>
                    <button className="small" disabled={added[s.lemma]} onClick={() => addOne(s)}>
                      {added[s.lemma] ? t('common.added') : t('common.add')}
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