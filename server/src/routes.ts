import fs from 'node:fs';
import path from 'node:path';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Ctx } from './ctx.js';
import { copyFor, langFor } from './config.js';
import { addDays } from './dates.js';
import { mimeToExt } from './services/audio.js';
import { compareReadAloud, compareStrings } from './services/diff.js';
import * as tts from './services/tts.js';
import { DailyCapReachedError } from './llm/errors.js';
import { wordSuggestSystem, wordSuggestPrompt } from './prompts/wordSuggest.js';
import { WordSuggestionsSchema } from './schema/content.js';

type PReq<TBody = unknown> = FastifyRequest<{ Params: { id: string }; Body: TBody }>;
type Pack = ReturnType<Ctx['content']['packForSession']>;
interface SpeakingPackLike {
  speaking_prompt: { target: string; native: string };
  level: number;
}

export async function registerRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db, cfg, auth, content, review } = ctx;

  app.get('/api/health', async () => ({ ok: true, tz: effectiveTz(db, cfg) }));

  // Deployment-level meta. Unauthenticated on purpose: the login page and the
  // PWA manifest both need it before anyone has a session, so this cannot depend
  // on an enrollment. Enrollment-aware data lives on /api/account (phase 7).
  app.get('/api/meta', async () => {
    const defaultUiLang = cfg.defaultUiLang;
    return {
      defaultUiLang,
      supportedTargetLangs: cfg.supportedTargetLangs,
      supportedUiLangs: cfg.supportedUiLangs,
      targetLangs: [...cfg.langs.values()].map((p) => ({
        code: p.code,
        name: p.name,
        endonym: p.endonym,
        htmlLang: p.htmlLang,
      })),
      uiLangs: [...cfg.copies.keys()],
      appName: copyFor(cfg, defaultUiLang).appName,
      appTagline: copyFor(cfg, defaultUiLang).appTagline,
      copy: cfg.copies.get(defaultUiLang),
    };
  });

  // ---------- Auth (§10) ----------
  app.post('/api/login', async (req: FastifyRequest<{ Body: { password?: string } }>, reply) => {
    const parsed = z.object({ password: z.string() }).safeParse(req.body ?? {});
    if (!parsed.success || !auth.checkPassword(parsed.data.password)) {
      return reply.code(401).send({ error: 'invalid password' });
    }
    reply.setCookie(auth.cookieName, auth.createToken(), auth.cookieOptions());
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(auth.cookieName, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (_req) => ({ authenticated: true }));

  // ---------- Settings ----------
  const settingsSchema = z.object({
    level: z.number().int().min(1).max(6).optional(),
    tts_rate: z.number().min(0.5).max(2).optional(),
    tts_voice: z.string().nullable().optional(),
    show_romanization: z.boolean().optional(),
    keep_recordings_days: z.number().int().min(0).optional(),
    timezone: z.string().min(2).max(64).optional(),
  });

  app.get('/api/settings', async () => readSettings(db, cfg));

  app.put('/api/settings', async (req: FastifyRequest<{ Body: unknown }>, reply) => {
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const s = parsed.data;
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (s.level !== undefined) { sets.push('level=?'); params.push(s.level); }
    if (s.tts_rate !== undefined) { sets.push('tts_rate=?'); params.push(s.tts_rate); }
    if (s.tts_voice !== undefined) { sets.push('tts_voice=?'); params.push(s.tts_voice); }
    if (s.show_romanization !== undefined) { sets.push('show_romanization=?'); params.push(s.show_romanization ? 1 : 0); }
    if (s.keep_recordings_days !== undefined) { sets.push('keep_recordings_days=?'); params.push(s.keep_recordings_days); }
    if (s.timezone !== undefined && s.timezone !== null) { sets.push('timezone=?'); params.push(s.timezone); }
    if (sets.length) {
      params.push(1);
      db.prepare(`UPDATE settings SET ${sets.join(',')} WHERE id=?`).run(...params);
    }
    return readSettings(db, cfg);
  });

  // ---------- Home ----------
  app.get('/api/home', async () => {
    const tomorrowReady = db
      .prepare("SELECT 1 FROM passages WHERE source='llm' AND used=0 AND intended_date=? LIMIT 1")
      .get(addDays(content.today(), 1))
      ? true
      : false;
    return {
      tz: effectiveTz(db, cfg),
      todaySession: content.getTodaySession(),
      settings: readSettings(db, cfg),
      tomorrowPackReady: tomorrowReady,
    };
  });

  // ---------- Session (§6) ----------
  app.get('/api/session/today', async () => ({ session: content.getTodaySession() }));

  app.post('/api/session/start', async () => ({ session: content.startTodaySession() }));

  app.post('/api/session/:id/step', async (req: PReq<{ step?: string }>, reply) => {
    const parsed = z.object({ step: z.string().min(1).max(40) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    content.setStep(Number(req.params.id), parsed.data.step);
    return { ok: true };
  });

  app.post('/api/session/:id/word-tap', async (req: PReq<{ surface?: string }>, reply) => {
    const parsed = z.object({ surface: z.string().min(1) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return content.addWord(Number(req.params.id), parsed.data.surface);
  });

  app.get('/api/session/:id/warmup', async (req: PReq) => ({ cards: content.dueCards(10) }));

  app.post('/api/srs/review', async (req: FastifyRequest<{ Body: { word_id?: number; rating?: string } }>, reply) => {
    const parsed = z
      .object({ word_id: z.number().int(), rating: z.enum(['again', 'hard', 'good', 'easy']) })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return content.reviewCard(parsed.data.word_id, parsed.data.rating);
  });

  app.post('/api/session/:id/read', async (req: PReq<{ answers?: number[] }>, reply) => {
    const parsed = z
      .object({ answers: z.array(z.number().int().min(0).max(3)).length(3) })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return content.gradeQuestions(Number(req.params.id), parsed.data.answers);
  });

  // ---------- Writing (M3) ----------
  app.post('/api/session/:id/writing', async (req: PReq<{ text?: string }>, reply) => {
    const parsed = z.object({ text: z.string().min(1).max(4000) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const sessionId = Number(req.params.id);
    const pack = content.packForSession(sessionId) as Pack;
    const entryId = review.createWritingEntry(sessionId, pack, parsed.data.text);
    let feedback: unknown = null;
    let queued = true;
    if (ctx.callManager) {
      try {
        queued = !(await review.gradeWritingEntry(entryId));
        if (!queued) feedback = JSON.parse(review.getWritingEntry(entryId)!.feedback_json as string);
      } catch {
        queued = true;
      }
    }
    return { entry_id: entryId, queued, feedback };
  });

  app.get('/api/writing/:id', async (req: PReq) => {
    const entry = review.getWritingEntry(Number(req.params.id));
    if (!entry) return { entry: null };
    return { entry };
  });

  // ---------- Listening (M4) ----------
  app.post('/api/session/:id/listening', async (req: PReq<{ transcripts?: string[] }>, reply) => {
    const parsed = z
      .object({ transcripts: z.array(z.string().max(500)).min(1).max(10) })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const sessionId = Number(req.params.id);
    const pack = content.packForSession(sessionId) as Pack;
    const targets = pack.sentences.slice(0, 3);
    const perSentence = parsed.data.transcripts.slice(0, 3).map((typed, i) => {
      const target = targets[i]?.target ?? '';
      const diff = compareStrings(target, typed);
      return { target, typed, ...diff };
    });
    const score = content.listenScore(sessionId, perSentence.map((p) => p.percent));
    const entries = perSentence.map((p, i) => ({ index: i, target: p.target, typed: p.typed, score: p.percent }));
    if (entries.length) content.saveDictationEntries(sessionId, entries);
    return { score, perSentence };
  });

  // ---------- Speaking (M5) ----------
  app.post('/api/session/:id/speaking/read-aloud', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const sessionId = Number(req.params.id);
    const pack = content.packForSession(sessionId) as Pack;
    const ct = (req.headers['content-type'] ?? '').toLowerCase();
    // Typed transcript (desktop/keyboard): compare client text directly.
    if (ct.includes('json')) {
      const parsed = z
        .object({ sentence_index: z.number().int().min(0).max(9), transcript: z.string().max(500) })
        .safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const target = pack.sentences[parsed.data.sentence_index]?.target ?? '';
      const diff = compareReadAloud(target, parsed.data.transcript);
      const attemptId = review.createReadAloudAttempt(sessionId, target, parsed.data.transcript, diff.percent);
      return reply.send({
        target,
        ...diff,
        transcript: parsed.data.transcript,
        attempt_id: attemptId,
        note_native: 'A mismatch may be a recognizer error, not only a pronunciation error.',
      });
    }
    // Raw audio: transcribe server-side (reliable on Android, unlike the Web Speech API).
    const index = Number(req.headers['x-sentence-index'] ?? -1);
    if (!Number.isInteger(index) || index < 0 || index > 9) {
      return reply.code(400).send({ error: 'missing or invalid x-sentence-index header' });
    }
    const buf = req.body as Buffer | undefined;
    if (!buf || buf.length === 0) return reply.code(400).send({ error: 'empty recording' });
    const target = pack.sentences[index]?.target ?? '';
    const ext = mimeToExt(ct || 'audio/webm');
    let transcript: string;
    try {
      // The session's own language: a French passage must not be transcribed
      // with a Korean prompt.
      transcript = await review.transcribeAudio(buf, ext, content.sessionLang(sessionId));
    } catch (e) {
      req.log.warn({ err: e }, 'read-aloud transcription failed');
      return reply.code(502).send({ error: e instanceof Error ? e.message : 'transcription failed' });
    }
    const diff = compareReadAloud(target, transcript);
    const attemptId = review.createReadAloudAttempt(sessionId, target, transcript, diff.percent);
    return {
      target,
      ...diff,
      transcript,
      attempt_id: attemptId,
      note_native: 'A mismatch may be a recognizer error, not only a pronunciation error.',
    };
  });

  app.post('/api/session/:id/speaking/free-response', async (req: PReq, reply) => {
    const sessionId = Number(req.params.id);
    const pack = content.packForSession(sessionId) as Pack;
    return handleFreeResponse(req, reply, ctx, sessionId, pack);
  });

  app.get('/api/speaking/:id', async (req: PReq) => {
    const attempt = review.getSpeakingAttempt(Number(req.params.id));
    if (!attempt) return { attempt: null };
    const feedback = attempt.feedback_json ? JSON.parse(attempt.feedback_json as string) : null;
    return { attempt, feedback };
  });

  // Verbatim transcription of an uploaded recording (used where the client-side
  // Web Speech API is unreliable, e.g. Android for the practice read-aloud drill).
  app.post('/api/transcribe', async (req: FastifyRequest, reply) => {
    const buf = req.body as Buffer | undefined;
    if (!buf || buf.length === 0) return reply.code(400).send({ error: 'empty recording' });
    const mime = (req.headers['content-type'] ?? 'audio/webm').toLowerCase();
    let transcript: string;
    try {
      transcript = await review.transcribeAudio(buf, mimeToExt(mime));
    } catch (e) {
      req.log.warn({ err: e }, 'transcription failed');
      return reply.code(502).send({ error: e instanceof Error ? e.message : 'transcription failed' });
    }
    return { transcript };
  });

  // ---------- Completion / wrap-up (M6) ----------
  app.post('/api/session/:id/complete', async (req: PReq<{ duration_s?: number }>, reply) => {
    const parsed = z.object({ duration_s: z.number().int().min(0).default(0) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const result = content.completeSession(Number(req.params.id), parsed.data.duration_s);
    if (ctx.callManager) content.prefetchTomorrow().catch((e) => console.warn('[session] prefetch failed:', e));
    cleanupRecordings(db, cfg);
    return result;
  });

  app.post('/api/level', async (req: FastifyRequest<{ Body: { action?: string } }>, reply) => {
    const parsed = z.object({ action: z.enum(['up', 'down']) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return content.applyLevelChange(parsed.data.action);
  });

  app.post('/api/retry-queue', async () => ({ result: await review.retryQueued() }));

  // ---------- Words ----------
  app.get('/api/words', async (req) => {
    const q = typeof (req.query as { q?: unknown }).q === 'string' ? (req.query as { q: string }).q : '';
    const rows = q
      ? db
          .prepare(
            `SELECT w.id, w.lemma, w.surface_example, w.meaning_native, w.pos, w.level, w.source, w.example_target, w.example_native,
                    c.ease, c.interval_days, c.due_date, c.reps, c.lapses
             FROM words w LEFT JOIN srs_cards c ON c.word_id = w.id
             WHERE w.lemma LIKE ? OR w.meaning_native LIKE ? OR w.surface_example LIKE ?
             ORDER BY w.first_seen_at DESC, w.id DESC LIMIT 200`,
          )
          .all(`%${q}%`, `%${q}%`, `%${q}%`)
      : db
          .prepare(
            `SELECT w.id, w.lemma, w.surface_example, w.meaning_native, w.pos, w.level, w.source, w.example_target, w.example_native,
                    c.ease, c.interval_days, c.due_date, c.reps, c.lapses
             FROM words w LEFT JOIN srs_cards c ON c.word_id = w.id
             ORDER BY w.first_seen_at DESC, w.id DESC LIMIT 200`,
          )
          .all();
    return { words: rows };
  });

  app.post('/api/words', async (req: FastifyRequest<{ Body: unknown }>, reply) => {
    const parsed = z
      .object({
        lemma: z.string().min(1),
        meaning_native: z.string().min(1),
        surface_example: z.string().optional(),
        pos: z.string().optional(),
        level: z.number().int().min(1).max(6).optional(),
        source: z.enum(['manual', 'suggested']).optional(),
        example_target: z.string().optional(),
        example_native: z.string().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return content.addWordManually(parsed.data);
  });

  app.get('/api/srs/due', async () => ({
    cards: content.dueCards(10),
    due_total: content.countDueCards(),
  }));

  app.post('/api/words/suggest', async (req: FastifyRequest<{ Body: unknown }>, reply) => {
    const parsed = z
      .object({
        level: z.number().int().min(1).max(6).optional(),
        topic: z.string().min(1).max(60).optional(),
        count: z.number().int().min(1).max(10).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!ctx.callManager) return reply.code(503).send({ error: 'LLM not configured' });
    const settings = db.prepare('SELECT level FROM settings WHERE id=1').get() as { level: number };
    try {
      const promptCtx = { profile: content.profileFor() };
      const suggestions = await ctx.callManager.generateJSON({
        system: wordSuggestSystem(promptCtx, parsed.data.level ?? settings.level),
        prompt: wordSuggestPrompt(
          promptCtx,
          parsed.data.count ?? 5,
          parsed.data.topic ?? null,
          (db.prepare('SELECT lemma FROM words').all() as { lemma: string }[]).map((r) => r.lemma),
        ),
        schema: WordSuggestionsSchema,
      });
      const known = new Set(
        (db.prepare('SELECT lemma FROM words').all() as { lemma: string }[]).map((r) => r.lemma.toLowerCase()),
      );
      return { suggestions: suggestions.words.filter((w) => !known.has(w.lemma.toLowerCase())) };
    } catch (err) {
      if (err instanceof DailyCapReachedError) return reply.code(429).send({ error: err.message });
      throw err;
    }
  });

  // ---------- Session history ----------
  app.get('/api/sessions', async () => ({ sessions: content.listDoneSessions() }));

  app.get('/api/sessions/:id/detail', async (req: PReq, reply) => {
    const detail = content.sessionDetail(Number(req.params.id));
    if (!detail) return reply.code(404).send({ error: 'no completed session found' });
    return { detail };
  });

  // ---------- Progress (M6) ----------
  app.get('/api/progress', async () => {
    const sessions = db
      .prepare(
        "SELECT id, date, read_score, write_score, listen_score, speak_score, vocab_score, duration_s FROM sessions WHERE status='done' ORDER BY date",
      )
      .all() as Array<Record<string, unknown>>;
    return {
      settings: readSettings(db, cfg),
      sessions,
      streakCalendar: (db.prepare("SELECT date FROM sessions WHERE status='done' ORDER BY date").all() as Array<{ date: string }>).map((r) => r.date),
      history: content.history(),
    };
  });

  // Wipe all learning-derived state and start over (keeps settings like TTS).
  app.delete('/api/progress', async (req: FastifyRequest, reply) => {
    const parsed = z.object({ confirm: z.literal('reset') }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'must send {"confirm":"reset"}' });
    const del = (t: string) => Number(db.prepare(`DELETE FROM ${t}`).run().changes ?? 0);
    const deleted = {
      writing_entries: del('writing_entries'),
      speaking_attempts: del('speaking_attempts'),
      dictation_entries: del('dictation_entries'),
      srs_cards: del('srs_cards'),
      sessions: del('sessions'),
      words: del('words'),
      level_history: del('level_history'),
    };
    db.prepare('UPDATE settings SET level=1, streak=0, last_session_date=NULL WHERE id=1').run();
    // Scoped to the caller's language: another language's passages belong to a
    // different enrollment and must survive this reset.
    db.prepare('UPDATE passages SET used=0, intended_date=NULL WHERE target_lang=?').run(
      content.primaryLang,
    );
    return { ok: true, deleted };
  });

  // ---------- Speaking practice (standalone screen) ----------
  // A random pack, but only ever from the caller's own language: one database
  // holds every supported language's passages.
  const randomPack = (targetLang: string) =>
    db
      .prepare('SELECT payload_json FROM passages WHERE target_lang=? ORDER BY RANDOM() LIMIT 1')
      .get(targetLang) as { payload_json: string } | undefined;

  app.get('/api/practice/read', async () => {
    const p = randomPack(content.primaryLang);
    if (!p) return { pack: null };
    return { pack: JSON.parse(p.payload_json) };
  });

  app.post('/api/practice/read-aloud', async (req: FastifyRequest<{ Body: { target?: string; transcript?: string } }>, reply) => {
    const parsed = z.object({ target: z.string().min(1), transcript: z.string().max(500) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const diff = compareReadAloud(parsed.data.target, parsed.data.transcript);
    review.createReadAloudAttempt(null, parsed.data.target, parsed.data.transcript, diff.percent);
    return { target: parsed.data.target, ...diff };
  });

  app.post('/api/practice/free-response', async (req: FastifyRequest, reply) => {
    const targetLang = content.primaryLang;
    const settings = readSettings(db, cfg);
    const p = randomPack(targetLang);
    const pack: SpeakingPackLike = p
      ? (JSON.parse(p.payload_json) as SpeakingPackLike)
      : {
          level: settings.level,
          speaking_prompt: langFor(cfg, targetLang).fallbacks.speakingPrompt,
        };
    return handleFreeResponse(req, reply, ctx, null, pack);
  });

  // ---------- Neural TTS (listen buttons) ----------
  app.get('/api/tts', async (req: FastifyRequest<{ Querystring: { text?: string; voice?: string; rate?: string } }>, reply) => {
    const text = (req.query.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'text is required' });
    if (text.length > 400) return reply.code(400).send({ error: 'text too long' });
    const rate = Number(req.query.rate ?? 0) || 0;
    try {
      const stream = await tts.synthesize({ text, voice: req.query.voice, rate });
      reply.header('content-type', 'audio/mpeg');
      reply.header('cache-control', 'public, max-age=3600');
      return reply.send(stream);
    } catch (err) {
      console.error('[tts] synthesis failed:', err instanceof Error ? err.message : err);
      return reply.code(502).send({ error: 'TTS unavailable' });
    }
  });

  // ---------- LLM status (Settings screen) ----------
  app.get('/api/llm/status', async () => {
    if (!ctx.callManager) {
      return {
        enabled: false,
        provider: null,
        model: null,
        callsToday: 0,
        cap: cfg.llmDailyCap,
        lastError: null,
      };
    }
    const stats = ctx.callManager.stats();
    return {
      enabled: true,
      provider: ctx.callManager.providerName,
      model: ctx.callManager.providerModel,
      callsToday: stats.callsToday,
      cap: stats.cap,
      lastError: stats.lastError,
    };
  });
}

// ---------- helpers ----------

function effectiveTz(db: DatabaseSync, cfg: Ctx['cfg']): string {
  const s = db.prepare('SELECT timezone FROM settings WHERE id=1').get() as
    | { timezone: string | null }
    | undefined;
  return s?.timezone || cfg.tz;
}

interface SettingsRow {
  level: number;
  tts_rate: number;
  tts_voice: string;
  show_romanization: number;
  keep_recordings_days: number;
  streak: number;
  last_session_date: string | null;
}

export function readSettings(db: DatabaseSync, cfg: Ctx['cfg']) {
  const s = db.prepare('SELECT * FROM settings WHERE id=1').get() as Record<string, unknown>;
  return {
    level: Number(s.level) || 1,
    tts_rate: Number(s.tts_rate) || 1,
    tts_voice: (s.tts_voice as string | null) || 'ko-KR-SunHiNeural',
    show_romanization: Boolean(s.show_romanization),
    keep_recordings_days: Number(s.keep_recordings_days) || 14,
    streak: Number(s.streak) || 0,
    last_session_date: (s.last_session_date as string | null) ?? null,
    timezone: effectiveTz(db, cfg),
  };
}

async function handleFreeResponse(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: Ctx,
  sessionId: number | null,
  pack: SpeakingPackLike,
) {
  const mime = (req.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
  const buf = req.body as Buffer | undefined;
  if (!buf || buf.length === 0) return reply.code(400).send({ error: 'empty recording' });
  if (buf.length > 50 * 1024 * 1024) return reply.code(413).send({ error: 'recording too large' });

  const ext = mimeToExt(mime);
  const attemptId = ctx.review.createFreeSpeechAttempt(sessionId, pack);
  const dir = path.join(ctx.cfg.dataDir, 'recordings');
  fs.mkdirSync(dir, { recursive: true });
  const audioPath = path.join(dir, `freespeech_${Date.now()}_${attemptId}.${ext}`);
  fs.writeFileSync(audioPath, buf, { flag: 'wx' });
  ctx.review.setAttemptAudioPath(attemptId, audioPath);

  let feedback: unknown = null;
  let queued = true;
  if (ctx.callManager) {
    try {
      queued = !(await ctx.review.gradeSpeakingAttempt(attemptId));
      if (!queued) feedback = JSON.parse(ctx.review.getSpeakingAttempt(attemptId)!.feedback_json as string);
    } catch (err) {
      if (!(err instanceof DailyCapReachedError)) {
        console.warn('[speaking] grading failed, will retry later:', err instanceof Error ? err.message : err);
      }
      queued = true;
    }
  }
  return { attempt_id: attemptId, queued, feedback };
}

function cleanupRecordings(db: DatabaseSync, cfg: Ctx['cfg']): void {
  const days = (db.prepare('SELECT keep_recordings_days FROM settings WHERE id=1').get() as {
    keep_recordings_days: number;
  }).keep_recordings_days;
  if (days === 0) return;
  const dir = path.join(cfg.dataDir, 'recordings');
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      /* ignore */
    }
  }
}