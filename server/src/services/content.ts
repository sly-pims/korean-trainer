import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { addDays, nowIso, todayString } from '../dates.js';
import { DailyCapReachedError } from '../llm/errors.js';
import { CallManager } from '../llm/callManager.js';
import { validateContentPack } from '../prompts/contentPack.js';
import { ContentPackSchema } from '../schema/content.js';
import { filterGlossaryByPassage } from './glossary.js';
import { compareReadAloud, compareStrings } from './diff.js';
import { reviewCard as sm2Review } from './srs.js';
import { computeStreak } from './streak.js';

export interface SeedLoadResult {
  total: number;
  imported: number;
  existing: number;
  failed: number;
  errors: string[];
}

export interface SessionRow {
  id: number;
  date: string;
  passage_id: number | null;
  status: 'in_progress' | 'done';
  current_step: string;
  read_score: number | null;
  write_score: number | null;
  listen_score: number | null;
  speak_score: number | null;
  vocab_score: number | null;
  duration_s: number | null;
  read_answers_json: string | null;
}

export interface PassageRow {
  id: number;
  level: number;
  topic: string;
  payload_json: string;
  source: 'llm' | 'seed';
  used: number;
  intended_date: string | null;
  created_at: string;
}

export interface SessionWithPack {
  session: SessionRow;
  pack: import('../schema/content.js').ContentPack;
  passage: PassageRow;
}

export interface LevelSuggestion {
  action: 'up' | 'down' | 'stay';
  suggestedLevel: number;
  overall: number;
}

/**
 * Owns passages (seed + llm), the daily-session lifecycle, pack generation
 * and prefetch (§8.1, §6.2) and the level suggestion.
 */
export class ContentService {
  constructor(
    private db: DatabaseSync,
    private getTz: () => string,
    private callManager: CallManager | null = null,
    private seedPath = 'seed/passages.json',
  ) {}

  // ---- Seed bank (§9) ----

  loadSeed(): SeedLoadResult {
    const raw = fs.readFileSync(this.seedPath, 'utf8');
    const arr: unknown[] = JSON.parse(raw);
    const result: SeedLoadResult = { total: arr.length, imported: 0, existing: 0, failed: 0, errors: [] };
    const exists = this.db.prepare('SELECT 1 FROM passages WHERE source=? AND payload_json=?');
    const insert = this.db.prepare(
      'INSERT INTO passages (level, topic, payload_json, source, used, created_at) VALUES (?,?,?,?,0,?)',
    );
    const checkExisting = this.db.prepare("SELECT COUNT(*) AS c FROM passages WHERE source = 'seed'");
    const before = (checkExisting.get() as { c: number }).c;
    void before;
    const tx = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    tx.run();
    for (const entry of arr) {
      const parsed = validateContentPack(entry);
      if (!parsed.success) {
        result.failed++;
        result.errors.push(`invalid pack: ${parsed.error.message}`);
        continue;
      }
      const pack = filterGlossaryByPassage(parsed.data);
      const payload = JSON.stringify(pack);
      if (exists.get('seed', payload)) {
        result.existing++;
        continue;
      }
      insert.run(pack.level, pack.topic, payload, 'seed', nowIso());
      result.imported++;
    }
    commit.run();
    return result;
  }

  // ---- Session lifecycle ----

  today() {
    return todayString(this.getTz());
  }

  getTodaySession(): SessionWithPack | null {
    const today = this.today();
    const s = this.db.prepare('SELECT * FROM sessions WHERE date = ?').get(today) as
      | SessionRow
      | undefined;
    if (!s) return null;
    return this.sessionWithPack(s);
  }

  /** Start (idempotent) today's session: pick a passage, mark it used. */
  startTodaySession(): SessionWithPack {
    const existing = this.getTodaySession();
    if (existing) return existing;

    const today = this.today();
    let p = this.db
      .prepare('SELECT * FROM passages WHERE used=0 AND intended_date=? ORDER BY id LIMIT 1')
      .get(today) as unknown as PassageRow | undefined;
    if (!p) {
      p = this.db
        .prepare('SELECT * FROM passages WHERE used=0 ORDER BY created_at, id LIMIT 1')
        .get() as unknown as PassageRow | undefined;
    }
    if (!p) {
      // Recycle the seed bank so the app never shows an empty day.
      this.db.prepare('UPDATE passages SET used=0').run();
      p = this.db.prepare('SELECT * FROM passages ORDER BY id LIMIT 1').get() as unknown as PassageRow;
    }

    this.db.prepare('UPDATE passages SET used=1 WHERE id=?').run(p.id);
    const res = this.db
      .prepare('INSERT INTO sessions (date, passage_id, status) VALUES (?,?,?)')
      .run(today, p.id, 'in_progress');
    const s = this.db
      .prepare('SELECT * FROM sessions WHERE id=?')
      .get(Number(res.lastInsertRowid)) as unknown as SessionRow;
    return this.sessionWithPack(s);
  }

  sessionWithPack(s: SessionRow): SessionWithPack {
    const p = this.db.prepare('SELECT * FROM passages WHERE id=?').get(s.passage_id) as unknown as PassageRow;
    return { session: s, pack: JSON.parse(p.payload_json), passage: p };
  }

  setStep(sessionId: number, step: string): void {
    this.db.prepare('UPDATE sessions SET current_step=? WHERE id=?').run(step, sessionId);
  }

  packForSession(sessionId: number) {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId) as unknown as SessionRow;
    const p = this.db.prepare('SELECT * FROM passages WHERE id=?').get(s.passage_id) as unknown as PassageRow;
    return JSON.parse(p.payload_json);
  }

  // ---- §6.2 level suggestion ----

  suggestLevel(): LevelSuggestion | null {
    const sessions = this.db
      .prepare("SELECT * FROM sessions WHERE status='done' ORDER BY date DESC LIMIT 3")
      .all() as unknown as SessionRow[];
    if (sessions.length < 3) return null;
    const perSession = sessions.map((s) => {
      const scores = [s.read_score, s.write_score, s.listen_score, s.speak_score].filter(
        (x): x is number => x !== null,
      );
      if (!scores.length) return null;
      return scores.reduce((a, b) => a + b, 0) / scores.length;
    });
    const present = perSession.filter((x): x is number => x !== null);
    if (present.length < 3) return null;
    const overall = present.reduce((a, b) => a + b, 0) / present.length;
    const level = (this.db.prepare('SELECT level FROM settings WHERE id=1').get() as { level: number })
      .level;
    if (overall >= 80 && level < 6) {
      return { action: 'up', suggestedLevel: level + 1, overall };
    }
    if (overall < 50 && level > 1) {
      return { action: 'down', suggestedLevel: level - 1, overall };
    }
    return { action: 'stay', suggestedLevel: level, overall };
  }

  applyLevelChange(action: 'up' | 'down'): { level: number } {
    const row = this.db.prepare('SELECT level FROM settings WHERE id=1').get() as { level: number };
    const from = row.level;
    const to = action === 'up' ? Math.min(6, from + 1) : Math.max(1, from - 1);
    this.db.prepare('UPDATE settings SET level=? WHERE id=1').run(to);
    this.db
      .prepare('INSERT INTO level_history (change_date, from_level, to_level, reason) VALUES (?,?,?,?)')
      .run(this.today(), from, to, action === 'up' ? 'score >= 80' : 'score < 50');
    return { level: to };
  }

  history() {
    return this.db
      .prepare('SELECT * FROM level_history ORDER BY change_date DESC')
      .all() as Array<Record<string, unknown>>;
  }

  // ---- Words & SRS (M1) ----

  addWord(sessionId: number, surface: string): {
    found: boolean;
    word?: Record<string, unknown>;
    isNew?: boolean;
  } {
    const pack = this.packForSession(sessionId) as import('../schema/content.js').ContentPack;
    const entry = pack.glossary.find((g) => g.surface === surface);
    if (!entry) return { found: false };
    const today = this.today();
    const existing = this.db.prepare('SELECT * FROM words WHERE lemma=?').get(entry.lemma) as
      | Record<string, unknown>
      | undefined;
    let wordId: number;
    if (existing) {
      wordId = existing.id as number;
      this.db.prepare('UPDATE words SET surface_example=? WHERE id=?').run(surface, wordId);
    } else {
      const res = this.db
        .prepare(
          `INSERT INTO words (lemma, surface_example, meaning_en, pos, level, first_seen_at, source_passage_id, source, example_ko, example_en)
           VALUES (?,?,?,?,?,?,?,'reading',NULL,NULL)`,
        )
        .run(
          entry.lemma,
          surface,
          entry.meaning_en,
          entry.pos,
          pack.level,
          today,
          null,
        );
      wordId = Number(res.lastInsertRowid);
    }
    const card = this.db.prepare('SELECT * FROM srs_cards WHERE word_id=?').get(wordId) as
      | Record<string, unknown>
      | undefined;
    const isNew = !existing;
    if (!card) {
      this.db
        .prepare(
          'INSERT INTO srs_cards (word_id, ease, interval_days, due_date, reps, lapses) VALUES (?,2.5,0,?,0,0)',
        )
        .run(wordId, today);
    }
    return { found: true, isNew, word: this.wordRow(wordId) };
  }

  addWordManually(input: {
    lemma: string;
    surface_example?: string;
    meaning_en: string;
    pos?: string;
    level?: number;
    source?: 'manual' | 'suggested';
    example_ko?: string;
    example_en?: string;
  }): Record<string, unknown> {
    const settings = this.db.prepare('SELECT level FROM settings WHERE id=1').get() as {
      level: number;
    };
    const level = input.level ?? settings.level;
    const existing = this.db.prepare('SELECT * FROM words WHERE lemma=?').get(input.lemma) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      return { word: this.wordRow(existing.id as number), isNew: false };
    }
    const res = this.db
      .prepare(
        `INSERT INTO words (lemma, surface_example, meaning_en, pos, level, first_seen_at, source, example_ko, example_en)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.lemma,
        input.surface_example ?? input.lemma,
        input.meaning_en,
        input.pos ?? 'noun',
        level,
        this.today(),
        input.source ?? 'manual',
        input.example_ko ?? null,
        input.example_en ?? null,
      );
    const wordId = Number(res.lastInsertRowid);
    this.db
      .prepare(
        'INSERT INTO srs_cards (word_id, ease, interval_days, due_date, reps, lapses) VALUES (?,2.5,0,?,0,0)',
      )
      .run(wordId, this.today());
    return { word: this.wordRow(wordId), isNew: true };
  }

  wordRow(id: number): Record<string, unknown> {
    const w = this.db.prepare('SELECT * FROM words WHERE id=?').get(id) as Record<string, unknown>;
    const c = this.db.prepare('SELECT * FROM srs_cards WHERE word_id=?').get(id) as
      | Record<string, unknown>
      | undefined;
    return { ...w, card: c ?? null };
  }

  dueCards(limit = 10): Array<Record<string, unknown>> {
    const today = this.today();
    return this.db
      .prepare(
        `SELECT w.id as word_id, w.lemma, w.surface_example, w.meaning_en, w.pos, w.level,
                c.ease, c.interval_days, c.due_date, c.reps, c.lapses
         FROM srs_cards c JOIN words w ON w.id = c.word_id
         WHERE c.due_date <= ?
         ORDER BY c.due_date, c.word_id
         LIMIT ?`,
      )
      .all(today, limit) as Array<Record<string, unknown>>;
  }

  countDueCards(): number {
    const today = this.today();
    return (this.db.prepare('SELECT COUNT(*) AS c FROM srs_cards WHERE due_date <= ?').get(today) as {
      c: number;
    }).c;
  }

  reviewCard(wordId: number, rating: import('./srs.js').Rating): Record<string, unknown> {
    const today = this.today();
    const card = this.db.prepare('SELECT * FROM srs_cards WHERE word_id=?').get(wordId) as {
      ease: number;
      interval_days: number;
      reps: number;
      lapses: number;
    };
    const next = sm2Review(
      { ease: card.ease, intervalDays: card.interval_days, reps: card.reps, lapses: card.lapses },
      rating,
      today,
    );
    this.db
      .prepare(
        'UPDATE srs_cards SET ease=?, interval_days=?, due_date=?, reps=?, lapses=? WHERE word_id=?',
      )
      .run(next.ease, next.intervalDays, next.dueDate, next.reps, next.lapses, wordId);
    return this.wordRow(wordId);
  }

  // ---- Grade comprehension questions (read step) ----

  gradeQuestions(sessionId: number, answers: number[]): { score: number; correct: boolean[] } {
    const pack = this.packForSession(sessionId) as import('../schema/content.js').ContentPack;
    const correct = pack.questions.map((q, i) => (answers[i] ?? -1) === q.answer_index);
    const score = Math.round((correct.filter(Boolean).length / pack.questions.length) * 100);
    this.db
      .prepare('UPDATE sessions SET read_score=?, read_answers_json=? WHERE id=?')
      .run(score, JSON.stringify(answers), sessionId);
    return { score, correct };
  }

  // ---- Dictation persistence (history) ----

  saveDictationEntries(
    sessionId: number,
    entries: { index: number; target: string; typed: string; score: number }[],
  ): void {
    this.db.prepare('DELETE FROM dictation_entries WHERE session_id=?').run(sessionId);
    const ins = this.db.prepare(
      'INSERT INTO dictation_entries (session_id, sentence_index, target_ko, typed_text, score, created_at) VALUES (?,?,?,?,?,?)',
    );
    for (const e of entries) {
      ins.run(sessionId, e.index, e.target, e.typed, e.score, new Date().toISOString());
    }
  }

  // ---- Session history ----

  listDoneSessions() {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.date, s.read_score, s.write_score, s.listen_score, s.speak_score, s.vocab_score, s.duration_s,
                p.topic, p.payload_json
         FROM sessions s JOIN passages p ON p.id = s.passage_id
         WHERE s.status='done'
         ORDER BY s.date DESC, s.id DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const { payload_json, ...rest } = r;
      let title_ko: string | null = null;
      try {
        title_ko = (JSON.parse(payload_json as string) as { title_ko?: unknown }).title_ko as string ?? null;
      } catch {
        /* keep null */
      }
      return { ...rest, title_ko };
    });
  }

  sessionDetail(sessionId: number): Record<string, unknown> | null {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId) as unknown as
      | SessionRow
      | undefined;
    if (!s || s.status !== 'done') return null;
    const p = this.db.prepare('SELECT * FROM passages WHERE id=?').get(s.passage_id) as unknown as PassageRow;
    const pack = JSON.parse(p.payload_json) as import('../schema/content.js').ContentPack;
    const answers: (number | null)[] = s.read_answers_json ? (JSON.parse(s.read_answers_json) as number[]) : [];
    const read = pack.questions.map((q, i) => {
      const chosen = answers[i] ?? null;
      return {
        index: i,
        q_ko: q.q_ko,
        q_en: q.q_en,
        choices: q.choices,
        chosen_index: chosen,
        answer_index: q.answer_index,
        correct: chosen !== null && chosen === q.answer_index,
        explanation_en: q.explanation_en,
      };
    });
    const writing = (
      this.db
        .prepare('SELECT id, prompt_json, user_text, feedback_json FROM writing_entries WHERE session_id=? ORDER BY id')
        .all(sessionId) as Array<Record<string, unknown>>
    ).map((w) => ({
      id: w.id,
      prompt: JSON.parse(w.prompt_json as string),
      user_text: w.user_text,
      feedback: w.feedback_json ? (JSON.parse(w.feedback_json as string) as unknown) : null,
    }));
    const dictation = (
      this.db
        .prepare('SELECT id, sentence_index, target_ko, typed_text, score FROM dictation_entries WHERE session_id=? ORDER BY sentence_index, id')
        .all(sessionId) as Array<Record<string, unknown>>
    ).map((d) => {
      const diff = compareStrings(d.target_ko as string, d.typed_text as string);
      return { ...d, segments: diff.segments, percent: diff.percent };
    });
    const attempts = this.db
      .prepare('SELECT id, mode, prompt_json, transcript, feedback_json, score FROM speaking_attempts WHERE session_id=? ORDER BY id')
      .all(sessionId) as Array<Record<string, unknown>>;
    const speaking = attempts.map((a) => {
      const mode = a.mode as string;
      if (mode === 'read_aloud') {
        const target = (JSON.parse(a.prompt_json as string) as { target?: string }).target ?? '';
        const transcript = (a.transcript as string | null) ?? '';
        const diff = compareReadAloud(target, transcript);
        return {
          id: a.id,
          mode,
          target,
          transcript,
          score: a.score,
          percent: diff.percent,
          segments: diff.segments,
          feedback: null,
        };
      }
      const prompt = JSON.parse((a.prompt_json as string) ?? '{}');
      return {
        id: a.id,
        mode,
        target: null,
        transcript: a.transcript ?? null,
        score: a.score,
        percent: null,
        segments: null,
        feedback: a.feedback_json ? (JSON.parse(a.feedback_json as string) as unknown) : null,
        prompt,
      };
    });
    return {
      session: {
        id: s.id,
        date: s.date,
        status: s.status,
        current_step: s.current_step,
        read_score: s.read_score,
        write_score: s.write_score,
        listen_score: s.listen_score,
        speak_score: s.speak_score,
        vocab_score: s.vocab_score,
        duration_s: s.duration_s,
      },
      pack,
      read,
      writing,
      dictation,
      speaking,
    };
  }

  listenScore(sessionId: number, perSentence: number[]): number {
    const score = perSentence.length
      ? Math.round(perSentence.reduce((a, b) => a + b, 0) / perSentence.length)
      : 0;
    this.db.prepare('UPDATE sessions SET listen_score=? WHERE id=?').run(score, sessionId);
    return score;
  }

  // ---- Completion (wrap-up) ----

  completeSession(sessionId: number, durationS: number): {
    streak: number;
    suggestion: LevelSuggestion | null;
    scores: {
      read: number | null;
      write: number | null;
      listen: number | null;
      speak: number | null;
      vocab: number | null;
    };
  } {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId) as unknown as SessionRow;
    const today = this.today();
    const vocab = (
      this.db.prepare('SELECT COUNT(*) c FROM words WHERE first_seen_at=?').get(today) as { c: number }
    ).c;
    const speak = (
      this.db
        .prepare(
          `SELECT AVG(score) a FROM speaking_attempts WHERE session_id=? AND mode='free_speech' AND score IS NOT NULL`,
        )
        .get(sessionId) as { a: number | null }
    ).a;
    const speakScore = speak === null ? null : Math.round((speak / 5) * 100);

    this.db
      .prepare(
        'UPDATE sessions SET status=?, duration_s=?, vocab_score=?, speak_score=? WHERE id=?',
      )
      .run('done', durationS, vocab, speakScore, sessionId);

    const settings = this.db.prepare('SELECT * FROM settings WHERE id=1').get() as {
      streak: number;
      last_session_date: string | null;
    };
    const streak = computeStreak(settings.streak, settings.last_session_date, today);
    this.db.prepare('UPDATE settings SET streak=?, last_session_date=? WHERE id=1').run(streak, today);

    const suggestion = this.suggestLevel();
    const done = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId) as unknown as SessionRow;
    return {
      streak,
      suggestion,
      scores: {
        read: done.read_score,
        write: done.write_score,
        listen: done.listen_score,
        speak: speakScore,
        vocab,
      },
    };
  }

  // ---- LLM pack generation (M2) ----

  recentTopics(limit = 6): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT topic FROM passages ORDER BY MAX(created_at) DESC')
      .all() as Array<{ topic: string }>;
    return rows.map((r) => r.topic).slice(0, limit);
  }

  capacity(): { callsToday: number; cap: number | null } {
    if (!this.callManager) return { callsToday: 0, cap: null };
    return { callsToday: this.callManager.callsToday(), cap: this.callManager.stats().cap };
  }

  /** §8.1 content-pack generation via the LLM; falls back to a seed pack. */
  async generatePack(level: number, requestedTopic?: string, recentTopics?: string[]): Promise<{
    pack: import('../schema/content.js').ContentPack;
    source: 'llm';
  }> {
    if (!this.callManager) throw new Error('No LLM provider configured');
    const { contentPackSystem, contentPackWithTopicPrompt, TOPIC_LIST } = await import(
      '../prompts/contentPack.js'
    );
    const recent = recentTopics ?? this.recentTopics();
    const pool = requestedTopic && requestedTopic !== 'any' ? [requestedTopic] : TOPIC_LIST.filter((t) => !recent.includes(t));
    const topic = pool.length ? pool[Math.floor(Math.random() * pool.length)] : 'daily life';
    const pack = await this.callManager.generateJSON({
      system: contentPackSystem(level),
      prompt: contentPackWithTopicPrompt(level, topic, recent),
      schema: ContentPackSchema,
    });
    return { pack: filterGlossaryByPassage(pack), source: 'llm' };
  }

  /** Generate tomorrow's pack in the background; never duplicate; never fail loudly. */
  async prefetchTomorrow(): Promise<void> {
    if (!this.callManager) return;
    try {
      const tomorrow = addDays(this.today(), 1);
      const existing = this.db
        .prepare("SELECT id FROM passages WHERE source='llm' AND used=0 AND intended_date=?")
        .get(tomorrow);
      if (existing) return;
      const settings = this.db.prepare('SELECT level FROM settings WHERE id=1').get() as {
        level: number;
      };
      const { pack } = await this.generatePack(settings.level);
      this.db
        .prepare(
          'INSERT INTO passages (level, topic, payload_json, source, used, intended_date, created_at) VALUES (?,?,?,?,0,?,?)',
        )
        .run(pack.level, pack.topic, JSON.stringify(pack), 'llm', tomorrow, nowIso());
    } catch (err) {
      if (err instanceof DailyCapReachedError) {
        console.warn('[content] prefetch skipped (daily cap)');
        return;
      }
      console.warn('[content] prefetch failed, seed will be used:', err instanceof Error ? err.message : err);
    }
  }
}