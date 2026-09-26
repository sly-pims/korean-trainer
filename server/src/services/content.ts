import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addDays, nowIso, todayString } from '../dates.js';
import type { LanguageProfile, Langs } from '../lang.js';
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
    private langs: Langs = new Map(),
    private repoRoot: string = '',
  ) {}

  /**
   * The language used when a caller has not yet told us which one it wants.
   * Every passage read is language-scoped; this only exists until enrollments
   * (phase 7) make the caller's language explicit.
   */
  get primaryLang(): string {
    return [...this.langs.keys()][0] ?? 'ko';
  }

  /**
   * The profile for a target language, or a hard failure.
   *
   * Silently substituting another language here is how a French learner ends up
   * being taught from a Korean prompt, so an unconfigured language stops the
   * request instead.
   */
  profileFor(targetLang: string = this.primaryLang): LanguageProfile {
    const profile = this.langs.get(targetLang);
    if (!profile) throw new Error(`no language profile configured for "${targetLang}"`);
    return profile;
  }

  // ---- Seed bank (§9) ----

  /**
   * Import every supported language's seed bank. Passages are a shared content
   * pool, so the dedup key is (target_lang, payload) — a French pack must not
   * be considered a duplicate of a Korean one with an identical body.
   */
  loadSeed(): SeedLoadResult {
    const result: SeedLoadResult = {
      total: 0,
      imported: 0,
      existing: 0,
      failed: 0,
      errors: [],
    };
    const exists = this.db.prepare(
      'SELECT 1 FROM passages WHERE source=? AND target_lang=? AND payload_json=?',
    );
    const insert = this.db.prepare(
      'INSERT INTO passages (target_lang, level, topic, payload_json, source, used, created_at) VALUES (?,?,?,?,?,0,?)',
    );
    const tx = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    tx.run();
    try {
      for (const [targetLang, profile] of this.langs) {
        const file = path.resolve(this.repoRoot, profile.seedFile);
        let arr: unknown[];
        try {
          arr = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[];
        } catch (err) {
          result.failed++;
          result.errors.push(
            `cannot read seed bank for ${targetLang} (${profile.seedFile}): ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        for (const entry of arr) {
          result.total++;
          const parsed = validateContentPack(entry);
          if (!parsed.success) {
            result.failed++;
            result.errors.push(`invalid ${targetLang} pack: ${parsed.error.message}`);
            continue;
          }
          const pack = filterGlossaryByPassage(parsed.data);
          const payload = JSON.stringify(pack);
          if (exists.get('seed', targetLang, payload)) {
            result.existing++;
            continue;
          }
          insert.run(targetLang, pack.level, pack.topic, payload, 'seed', nowIso());
          result.imported++;
        }
      }
    } finally {
      commit.run();
    }
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
  startTodaySession(targetLang = this.primaryLang): SessionWithPack {
    const existing = this.getTodaySession();
    if (existing) return existing;

    const today = this.today();
    let p = this.db
      .prepare(
        'SELECT * FROM passages WHERE target_lang=? AND used=0 AND intended_date=? ORDER BY id LIMIT 1',
      )
      .get(targetLang, today) as unknown as PassageRow | undefined;
    if (!p) {
      p = this.db
        .prepare('SELECT * FROM passages WHERE target_lang=? AND used=0 ORDER BY created_at, id LIMIT 1')
        .get(targetLang) as unknown as PassageRow | undefined;
    }
    if (!p) {
      // Recycle this language's seed bank so the app never shows an empty day.
      // Scoped to target_lang: recycling must not free up another language's
      // passages, which a different enrollment may be relying on.
      this.db.prepare('UPDATE passages SET used=0 WHERE target_lang=?').run(targetLang);
      p = this.db
        .prepare('SELECT * FROM passages WHERE target_lang=? ORDER BY id LIMIT 1')
        .get(targetLang) as unknown as PassageRow;
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

  /** The language a session's passage is in, for prompt and voice resolution. */
  sessionLang(sessionId: number): string {
    const s = this.db.prepare('SELECT passage_id FROM sessions WHERE id=?').get(sessionId) as
      | { passage_id: number }
      | undefined;
    if (!s) throw new Error(`no session ${sessionId}`);
    const p = this.db.prepare('SELECT target_lang FROM passages WHERE id=?').get(s.passage_id) as
      | { target_lang: string }
      | undefined;
    if (!p) throw new Error(`no passage for session ${sessionId}`);
    return p.target_lang;
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
          `INSERT INTO words (lemma, surface_example, meaning_native, pos, level, first_seen_at, source_passage_id, source, example_target, example_native)
           VALUES (?,?,?,?,?,?,?,'reading',NULL,NULL)`,
        )
        .run(
          entry.lemma,
          surface,
          entry.meaning_native,
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
    meaning_native: string;
    pos?: string;
    level?: number;
    source?: 'manual' | 'suggested';
    example_target?: string;
    example_native?: string;
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
        `INSERT INTO words (lemma, surface_example, meaning_native, pos, level, first_seen_at, source, example_target, example_native)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.lemma,
        input.surface_example ?? input.lemma,
        input.meaning_native,
        input.pos ?? 'noun',
        level,
        this.today(),
        input.source ?? 'manual',
        input.example_target ?? null,
        input.example_native ?? null,
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
        `SELECT w.id as word_id, w.lemma, w.surface_example, w.meaning_native, w.pos, w.level,
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
      'INSERT INTO dictation_entries (session_id, sentence_index, target_text, typed_text, score, created_at) VALUES (?,?,?,?,?,?)',
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
      let title_target: string | null = null;
      try {
        title_target = (JSON.parse(payload_json as string) as { title_target?: unknown }).title_target as string ?? null;
      } catch {
        /* keep null */
      }
      return { ...rest, title_target };
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
        q_target: q.q_target,
        q_native: q.q_native,
        choices: q.choices,
        chosen_index: chosen,
        answer_index: q.answer_index,
        correct: chosen !== null && chosen === q.answer_index,
        explanation_native: q.explanation_native,
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
        .prepare('SELECT id, sentence_index, target_text, typed_text, score FROM dictation_entries WHERE session_id=? ORDER BY sentence_index, id')
        .all(sessionId) as Array<Record<string, unknown>>
    ).map((d) => {
      const diff = compareStrings(d.target_text as string, d.typed_text as string);
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

  recentTopics(limit = 6, targetLang = this.primaryLang): string[] {
    const rows = this.db
      .prepare(
        'SELECT topic, MAX(created_at) AS newest FROM passages WHERE target_lang = ? GROUP BY topic ORDER BY newest DESC',
      )
      .all(targetLang) as Array<{ topic: string }>;
    return rows.map((r) => r.topic).slice(0, limit);
  }

  capacity(): { callsToday: number; cap: number | null } {
    if (!this.callManager) return { callsToday: 0, cap: null };
    return { callsToday: this.callManager.callsToday(), cap: this.callManager.stats().cap };
  }

  /** §8.1 content-pack generation via the LLM; falls back to a seed pack. */
  async generatePack(
    level: number,
    requestedTopic?: string,
    recentTopics?: string[],
    targetLang = this.primaryLang,
  ): Promise<{
    pack: import('../schema/content.js').ContentPack;
    source: 'llm';
  }> {
    if (!this.callManager) throw new Error('No LLM provider configured');
    const { contentPackSystem, contentPackWithTopicPrompt } = await import(
      '../prompts/contentPack.js'
    );
    const ctx = { profile: this.profileFor(targetLang) };
    const topicList = ctx.profile.topics;
    const recent = recentTopics ?? this.recentTopics(6, targetLang);
    const pool =
      requestedTopic && requestedTopic !== 'any'
        ? [requestedTopic]
        : topicList.filter((t) => !recent.includes(t));
    const topic = pool.length ? pool[Math.floor(Math.random() * pool.length)] : topicList[0] ?? 'daily life';
    const pack = await this.callManager.generateJSON({
      system: contentPackSystem(ctx, level),
      prompt: contentPackWithTopicPrompt(ctx, level, topic, recent),
      schema: ContentPackSchema,
    });
    return { pack: filterGlossaryByPassage(pack), source: 'llm' };
  }

  /** Generate tomorrow's pack in the background; never duplicate; never fail loudly. */
  async prefetchTomorrow(targetLang = this.primaryLang): Promise<void> {
    if (!this.callManager) return;
    try {
      const tomorrow = addDays(this.today(), 1);
      const existing = this.db
        .prepare(
          "SELECT id FROM passages WHERE target_lang=? AND source='llm' AND used=0 AND intended_date=?",
        )
        .get(targetLang, tomorrow);
      if (existing) return;
      const settings = this.db.prepare('SELECT level FROM settings WHERE id=1').get() as {
        level: number;
      };
      const { pack } = await this.generatePack(settings.level, undefined, undefined, targetLang);
      this.db
        .prepare(
          'INSERT INTO passages (target_lang, level, topic, payload_json, source, used, intended_date, created_at) VALUES (?,?,?,?,?,0,?,?)',
        )
        .run(targetLang, pack.level, pack.topic, JSON.stringify(pack), 'llm', tomorrow, nowIso());
    } catch (err) {
      if (err instanceof DailyCapReachedError) {
        console.warn('[content] prefetch skipped (daily cap)');
        return;
      }
      console.warn('[content] prefetch failed, seed will be used:', err instanceof Error ? err.message : err);
    }
  }
}