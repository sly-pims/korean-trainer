import fs from 'node:fs';
import path from 'node:path';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Ctx, Enrollment } from './ctx.js';
import { copyFor, langFor } from './config.js';
import { badId, idParam, notFound, ownedRow } from './authz.js';
import {
  availableTargetLangs,
  createEnrollment,
  enrollmentForUser,
  enrollmentsForUser,
  ensureSettingsRow,
  userById,
} from './enrollments.js';
import { mimeToExt } from './services/audio.js';
import { compareReadAloud, compareStrings } from './services/diff.js';
import * as tts from './services/tts.js';
import { UnknownVoiceError, resolveVoice } from './lang.js';
import type { LanguageProfile } from './lang.js';
import { DailyCapReachedError } from './llm/errors.js';
import { wordSuggestSystem, wordSuggestPrompt } from './prompts/wordSuggest.js';
import { WordSuggestionsSchema } from './schema/content.js';
import { errorBody } from './errors.js';

type PReq<TBody = unknown> = FastifyRequest<{ Params: { id: string }; Body: TBody }>;
type Pack = ReturnType<Ctx['content']['packForSession']>;
interface SpeakingPackLike {
  speaking_prompt: { target: string; native: string };
  level: number;
}

export async function registerRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db, cfg, auth, content, review } = ctx;

  /**
   * The enrollment for this request, or a hard failure.
   *
   * The auth preHandler guarantees it for every route except the handful of
   * public ones, and those never call this. Throwing rather than defaulting is
   * the point: the pre-enrollment version of this file had
   * `const activeProfile = () => content.profileFor()`, which quietly used the
   * deployment's primary language whenever the answer was not known. A missing
   * enrollment is a bug, and a bug that throws is better than one that teaches
   * somebody the wrong language.
   */
  const enrollmentOf = (req: FastifyRequest): Enrollment => {
    if (!req.enrollment) throw new Error('no enrollment on an authenticated route');
    return req.enrollment;
  };

  /** The language profile of whoever is asking. */
  const activeProfile = (req: FastifyRequest): LanguageProfile =>
    content.profileFor(enrollmentOf(req).targetLang);

  /**
   * The session named in the path, or a reply already sent.
   *
   * Two failure modes, two answers, and the difference matters:
   * a malformed id is the caller's mistake (400) and a well-formed id that is
   * not theirs is deliberately indistinguishable from one that does not exist
   * (404). Returning `undefined` after sending the reply is what keeps a caller
   * from forgetting to return and then writing to somebody else's row.
   */
  const ownSession = (
    req: FastifyRequest,
    raw: string,
    reply: FastifyReply,
  ): Record<string, unknown> | undefined => {
    const id = idParam(raw);
    if (id === null) {
      badId(reply);
      return undefined;
    }
    const row = ownedRow(db, 'sessions', id, enrollmentOf(req).id);
    if (!row) {
      notFound(reply);
      return undefined;
    }
    return row;
  };

  const localizedTodaySession = async (e: Enrollment) => {
    const session = content.getTodaySession(e.id);
    return session ? content.localizeSession(session, e.nativeLang) : null;
  };

  app.get('/api/health', async () => ({ ok: true, tz: cfg.tz }));

  // Deployment-level meta. Unauthenticated on purpose: the login page needs it
  // before anyone has a session. Anything enrollment-aware lives on /api/account.
  app.get('/api/meta', async () => ({
    defaultUiLang: cfg.defaultUiLang,
    supportedTargetLangs: cfg.supportedTargetLangs,
    supportedUiLangs: cfg.supportedUiLangs,
    targetLangs: [...cfg.langs.values()].map(describeLanguage),
    uiLangs: [...cfg.copies.keys()],
    appName: copyFor(cfg, cfg.defaultUiLang).appName,
    appTagline: copyFor(cfg, cfg.defaultUiLang).appTagline,
    copy: cfg.copies.get(cfg.defaultUiLang),
  }));

  // ---------- Auth (§10) ----------
  app.post('/api/login', async (req: FastifyRequest<{ Body: { username?: string; password?: string } }>, reply) => {
    const parsed = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
    }
    // One code for "no such user" and "wrong password": telling them apart is a
    // free account-enumeration oracle, and neither gets a successful login.
    if (!auth.checkCredentials(db, parsed.data.username, parsed.data.password)) {
      return reply.code(401).send(errorBody('invalid_credentials', 'invalid username or password'));
    }
    const user = db.prepare('SELECT id FROM users WHERE username=?').get(parsed.data.username) as { id: number };
    const account = userById(db, user.id);
    if (!account) return reply.code(401).send(errorBody('invalid_credentials', 'invalid username or password'));

    // The first enrollment is the default landing spot. A user with none cannot
    // happen (every account gets one), but if it ever did, refusing is better
    // than handing back a session that resolves to nothing.
    const [first] = enrollmentsForUser(db, account.id);
    if (!first) return reply.code(500).send(errorBody('unauthorized', 'account has no enrollment'));

    reply.setCookie(auth.cookieName, auth.createToken(account.id, first.id), auth.cookieOptions());
    return { ok: true, account: accountPayload(db, cfg, content, account, first) };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(auth.cookieName, auth.clearCookieOptions());
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const e = enrollmentOf(req);
    return { authenticated: true, username: e.username, enrollment_id: e.id, target_lang: e.targetLang };
  });

  // ---------- Account & enrollments ----------
  app.get('/api/account', async (req) => {
    const e = enrollmentOf(req);
    const user = userById(db, e.userId);
    if (!user) throw new Error(`enrollment ${e.id} has no user`);
    return accountPayload(db, cfg, content, user, e);
  });

  /**
   * Add a language to the caller's own account.
   *
   * The username and the owner come from the session, never from the body, so
   * this cannot create an account for somebody else no matter what is posted.
   *
   * Adding is not switching. The returned account still describes the enrollment
   * the cookie points at, and the new one is reported alongside it, because a
   * payload claiming to be in French while the cookie still says Korean is how a
   * client ends up rendering the wrong language's copy and saving settings into
   * the wrong row. `/api/enrollments/:id/activate` is the only thing that moves.
   */
  app.post('/api/enrollments', async (req: FastifyRequest<{ Body: unknown }>, reply) => {
    const parsed = z
      .object({
        target_lang: z.string().min(2).max(8),
        native_lang: z.string().min(2).max(8).optional(),
        ui_lang: z.string().min(2).max(8).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
    const { target_lang, native_lang, ui_lang } = parsed.data;
    if (!cfg.supportedTargetLangs.includes(target_lang)) {
      return reply.code(400).send(errorBody('language_not_supported', `target language "${target_lang}" is not offered by this deployment`));
    }
    const native = native_lang ?? cfg.defaultUiLang;
    const ui = ui_lang ?? (cfg.supportedUiLangs.includes(native) ? native : cfg.defaultUiLang);
    if (!cfg.langs.has(native) && !cfg.supportedUiLangs.includes(native)) {
      return reply.code(400).send(errorBody('language_not_supported', `native language "${native}" is not offered`));
    }
    if (!cfg.supportedUiLangs.includes(ui)) {
      return reply.code(400).send(errorBody('language_not_supported', `interface language is not offered (have: ${cfg.supportedUiLangs.join(', ')})`));
    }

    const me = enrollmentOf(req);
    const { enrollment, created } = createEnrollment(db, me.userId, {
      targetLang: target_lang,
      nativeLang: native,
      uiLang: ui,
    });
    ensureSettingsRow(db, enrollment.id, langFor(cfg, target_lang).defaultVoice, cfg.tz);
    reply.code(created ? 201 : 200);
    const user = userById(db, me.userId);
    return {
      created,
      enrollment: {
        id: enrollment.id,
        targetLang: enrollment.targetLang,
        nativeLang: enrollment.nativeLang,
        uiLang: enrollment.uiLang,
        displayName: enrollment.displayName,
        lang: describeLanguage(content.profileFor(enrollment.targetLang)),
      },
      // `me`, not `enrollment`: the session has not moved yet.
      account: accountPayload(db, cfg, content, user!, me),
    };
  });

  /**
   * Switch the active language.
   *
   * Re-signs the cookie rather than storing an "active enrollment" column: the
   * choice then lives only in the client, cannot get out of sync between two
   * devices, and a stale cookie is harmless.
   */
  app.post('/api/enrollments/:id/activate', async (req: PReq, reply) => {
    const me = enrollmentOf(req);
    const id = idParam(req.params.id);
    if (id === null) return badId(reply);
    const target = enrollmentForUser(db, me.userId, id);
    if (!target) return notFound(reply);
    reply.setCookie(auth.cookieName, auth.createToken(me.userId, target.id), auth.cookieOptions());
    const user = userById(db, me.userId);
    return { ok: true, account: accountPayload(db, cfg, content, user!, target) };
  });

  // ---------- Settings ----------
  const settingsSchema = z.object({
    level: z.number().int().min(1).max(6).optional(),
    tts_rate: z.number().min(0.5).max(2).optional(),
    tts_voice: z.string().nullable().optional(),
    show_romanization: z.boolean().optional(),
    keep_recordings_days: z.number().int().min(0).optional(),
    timezone: z.string().min(2).max(64).optional(),
  });

  app.get('/api/settings', async (req) =>
    readSettings(db, cfg, activeProfile(req), enrollmentOf(req).id),
  );

  app.put('/api/settings', async (req: FastifyRequest<{ Body: unknown }>, reply) => {
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
    const e = enrollmentOf(req);
    const s = parsed.data;
    // Reject a voice from another language rather than storing it: /api/tts
    // refuses it, so persisting it would only leave the settings screen showing
    // a selection the server will not honour.
    if (s.tts_voice) {
      try {
        resolveVoice(content.profileFor(e.targetLang), s.tts_voice);
      } catch (err) {
        if (err instanceof UnknownVoiceError) return reply.code(400).send(errorBody('unknown_voice', err.message));
        throw err;
      }
    }
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (s.level !== undefined) { sets.push('level=?'); params.push(s.level); }
    if (s.tts_rate !== undefined) { sets.push('tts_rate=?'); params.push(s.tts_rate); }
    if (s.tts_voice !== undefined) { sets.push('tts_voice=?'); params.push(s.tts_voice); }
    if (s.show_romanization !== undefined) { sets.push('show_romanization=?'); params.push(s.show_romanization ? 1 : 0); }
    if (s.keep_recordings_days !== undefined) { sets.push('keep_recordings_days=?'); params.push(s.keep_recordings_days); }
    if (s.timezone !== undefined && s.timezone !== null) { sets.push('timezone=?'); params.push(s.timezone); }
    if (sets.length) {
      params.push(e.id);
      db.prepare(`UPDATE settings SET ${sets.join(',')} WHERE enrollment_id=?`).run(...params);
    }
    return readSettings(db, cfg, activeProfile(req), e.id);
  });

  // ---------- Home ----------
  app.get('/api/home', async (req) => {
    const e = enrollmentOf(req);
    return {
      tz: effectiveTz(db, cfg, e.id),
      todaySession: await localizedTodaySession(e),
      settings: readSettings(db, cfg, content.profileFor(e.targetLang), e.id),
      tomorrowPackReady: content.tomorrowReady(e.id, e.targetLang),
    };
  });

  // ---------- Session (§6) ----------
  app.get('/api/session/today', async (req) => ({ session: await localizedTodaySession(enrollmentOf(req)) }));

  app.post('/api/session/start', async (req) => {
    const e = enrollmentOf(req);
    const session = content.startTodaySession(e.id, e.targetLang);
    return { session: await content.localizeSession(session, e.nativeLang) };
  });

  app.post('/api/session/:id/step', async (req: PReq<{ step?: string }>, reply) => {
    const parsed = z.object({ step: z.string().min(1).max(40) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
    const row = ownSession(req, req.params.id, reply);
    if (!row) return reply;
    content.setStep(row.id as number, parsed.data.step);
    return { ok: true };
  });

  app.post('/api/session/:id/word-tap', async (req: PReq<{ surface?: string }>, reply) => {
    const parsed = z.object({ surface: z.string().min(1) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
    const e = enrollmentOf(req);
    const row = ownSession(req, req.params.id, reply);
    if (!row) return reply;
    const pack = await content.nativePackForSession(row.id as number, e.nativeLang);
    return content.addWord(e.id, row.id as number, parsed.data.surface, pack);
  });

  /**
   * The warm-up deck shown at the start of a session.
   *
   * The cards are the caller's either way, so this never needed a lookup to stay
   * private — but the path names a session, and a route that accepts an id it
   * then ignores is one more id for somebody to expect to be checked. Verify it
   * so that the answer for another person's session is the same 404 as every
   * other session route, rather than a 200 that quietly suggests the id means
   * something.
   */
  app.get('/api/session/:id/warmup', async (req: PReq, reply) => {
    if (!ownSession(req, req.params.id, reply)) return reply;
    return { cards: content.dueCards(enrollmentOf(req).id, 10) };
  });

  app.post('/api/srs/review', async (req: FastifyRequest<{ Body: { word_id?: number; rating?: string } }>, reply) => {
    const parsed = z
      .object({ word_id: z.number().int(), rating: z.enum(['again', 'hard', 'good', 'easy']) })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
    const e = enrollmentOf(req);
    // reviewCard filters through the word's own enrollment, so a foreign
    // word_id is a miss rather than a write to somebody else's card.
    const card = content.reviewCard(e.id, parsed.data.word_id, parsed.data.rating);
    if (!card) return notFound(reply);
    return card;
  });

  app.post('/api/session/:id/read', async (req: PReq<{ answers?: number[] }>, reply) => {
    const parsed = z
      .object({ answers: z.array(z.number().int().min(0).max(3)).length(3) })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
    const row = ownSession(req, req.params.id, reply);
    if (!row) return reply;
    return content.gradeQuestions(row.id as number, parsed.data.answers);
  });

  // ---------- Writing (M3) ----------
  app.post('/api/session/:id/writing', async (req: PReq<{ text?: string }>, reply) => {
    const parsed = z.object({ text: z.string().min(1).max(4000) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
    const e = enrollmentOf(req);
    const row = ownSession(req, req.params.id, reply);
    if (!row) return reply;
    const sessionId = row.id as number;
    const pack = content.packForSession(sessionId) as Pack;
    const entryId = review.createWritingEntry(e.id, sessionId, pack, parsed.data.text);
    let feedback: unknown = null;
    let queued = true;
    if (ctx.callManager) {
      try {
        queued = !(await review.gradeWritingEntry(entryId, e.id));
        if (!queued) feedback = JSON.parse(review.getWritingEntry(entryId, e.id)!.feedback_json as string);
      } catch {
        queued = true;
      }
    }
    return { entry_id: entryId, queued, feedback };
  });

  app.get('/api/writing/:id', async (req: PReq, reply) => {
    const e = enrollmentOf(req);
    const id = idParam(req.params.id);
    if (id === null) return badId(reply);
    const entry = review.getWritingEntry(id, e.id);
    if (!entry) return notFound(reply);
    return { entry };
  });

  // ---------- Listening (M4) ----------
  app.post('/api/session/:id/listening', async (req: PReq<{ transcripts?: string[] }>, reply) => {
    const parsed = z
      .object({ transcripts: z.array(z.string().max(500)).min(1).max(10) })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
    const e = enrollmentOf(req);
    const row = ownSession(req, req.params.id, reply);
    if (!row) return reply;
    const sessionId = row.id as number;
    const pack = content.packForSession(sessionId) as Pack;
    const targets = pack.sentences.slice(0, 3);
    const perSentence = parsed.data.transcripts.slice(0, 3).map((typed, i) => {
      const target = targets[i]?.target ?? '';
      const diff = compareStrings(target, typed);
      return { target, typed, ...diff };
    });
    const score = content.listenScore(sessionId, perSentence.map((p) => p.percent));
    const entries = perSentence.map((p, i) => ({ index: i, target: p.target, typed: p.typed, score: p.percent }));
    if (entries.length) content.saveDictationEntries(e.id, sessionId, entries);
    return { score, perSentence };
  });

  // ---------- Speaking (M5) ----------
  app.post('/api/session/:id/speaking/read-aloud', async (req: PReq, reply) => {
    const e = enrollmentOf(req);
    const row = ownSession(req, req.params.id, reply);
    if (!row) return reply;
    const sessionId = row.id as number;
    const pack = content.packForSession(sessionId) as Pack;
    const ct = (req.headers['content-type'] ?? '').toLowerCase();
    // Typed transcript (desktop/keyboard): compare client text directly.
    if (ct.includes('json')) {
      const parsed = z
        .object({ sentence_index: z.number().int().min(0).max(9), transcript: z.string().max(500) })
        .safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
      const target = pack.sentences[parsed.data.sentence_index]?.target ?? '';
      const diff = compareReadAloud(target, parsed.data.transcript);
      const attemptId = review.createReadAloudAttempt(e.id, sessionId, target, parsed.data.transcript, diff.percent);
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
      return reply.code(400).send(errorBody('sentence_index_required', 'missing or invalid x-sentence-index header'));
    }
    const buf = req.body as Buffer | undefined;
    if (!buf || buf.length === 0) return reply.code(400).send(errorBody('empty_recording', 'empty recording'));
    const target = pack.sentences[index]?.target ?? '';
    const ext = mimeToExt(ct || 'audio/webm');
    let transcript: string;
    try {
      // The session's own language: a French passage must not be transcribed
      // with a Korean prompt.
      transcript = await review.transcribeAudio(buf, ext, content.sessionLang(sessionId));
    } catch (e) {
      req.log.warn({ err: e }, 'read-aloud transcription failed');
      return reply.code(502).send(errorBody('transcription_failed', e instanceof Error ? e.message : 'transcription failed'));
    }
    const diff = compareReadAloud(target, transcript);
    const attemptId = review.createReadAloudAttempt(e.id, sessionId, target, transcript, diff.percent);
    return {
      target,
      ...diff,
      transcript,
      attempt_id: attemptId,
      note_native: 'A mismatch may be a recognizer error, not only a pronunciation error.',
    };
  });

  app.post('/api/session/:id/speaking/free-response', async (req: PReq, reply) => {
    const e = enrollmentOf(req);
    const row = ownSession(req, req.params.id, reply);
    if (!row) return reply;
    const pack = content.packForSession(row.id as number) as Pack;
    return handleFreeResponse(req, reply, ctx, e.id, row.id as number, pack);
  });

  app.get('/api/speaking/:id', async (req: PReq, reply) => {
    const e = enrollmentOf(req);
    const id = idParam(req.params.id);
    if (id === null) return badId(reply);
    const attempt = review.getSpeakingAttempt(id, e.id);
    if (!attempt) return notFound(reply);
    const feedback = attempt.feedback_json ? JSON.parse(attempt.feedback_json as string) : null;
    return { attempt, feedback };
  });

  // Verbatim transcription of an uploaded recording (used where the client-side
  // Web Speech API is unreliable, e.g. Android for the practice read-aloud drill).
  app.post('/api/transcribe', async (req: FastifyRequest, reply) => {
    const buf = req.body as Buffer | undefined;
    if (!buf || buf.length === 0) return reply.code(400).send(errorBody('empty_recording', 'empty recording'));
    const mime = (req.headers['content-type'] ?? 'audio/webm').toLowerCase();
    let transcript: string;
    try {
      transcript = await review.transcribeAudio(buf, mimeToExt(mime), enrollmentOf(req).targetLang);
    } catch (e) {
      req.log.warn({ err: e }, 'transcription failed');
      return reply.code(502).send(errorBody('transcription_failed', e instanceof Error ? e.message : 'transcription failed'));
    }
    return { transcript };
  });

  // ---------- Completion / wrap-up (M6) ----------
  app.post('/api/session/:id/complete', async (req: PReq<{ duration_s?: number }>, reply) => {
    const parsed = z.object({ duration_s: z.number().int().min(0).default(0) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
    const e = enrollmentOf(req);
    const row = ownSession(req, req.params.id, reply);
    if (!row) return reply;
    const result = content.completeSession(e.id, row.id as number, parsed.data.duration_s);
    const level = readSettings(db, cfg, content.profileFor(e.targetLang), e.id).level;
    if (ctx.callManager) {
      content.prefetchTomorrow(e.id, e.targetLang, level, e.nativeLang).catch((err) =>
        console.warn('[session] prefetch failed:', err),
      );
    }
    sweepRecordings(db, cfg, e.id);
    return result;
  });

  app.post('/api/level', async (req: FastifyRequest<{ Body: { action?: string } }>, reply) => {
    const parsed = z.object({ action: z.enum(['up', 'down']) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
    return content.applyLevelChange(enrollmentOf(req).id, parsed.data.action);
  });

  // Deployment-wide: the queue is a property of this instance's LLM budget, and
  // a queued attempt is graded in its own enrollment's language.
  app.post('/api/retry-queue', async () => ({ result: await review.retryQueued() }));

  // ---------- Words ----------
  app.get('/api/words', async (req) => {
    const e = enrollmentOf(req);
    const q = typeof (req.query as { q?: unknown }).q === 'string' ? (req.query as { q: string }).q : '';
    const rows = q
      ? db
          .prepare(
            `SELECT w.id, w.lemma, w.surface_example, w.meaning_native, w.pos, w.level, w.source, w.example_target, w.example_native,
                    c.ease, c.interval_days, c.due_date, c.reps, c.lapses
             FROM words w LEFT JOIN srs_cards c ON c.word_id = w.id
             WHERE w.enrollment_id=? AND (w.lemma LIKE ? OR w.meaning_native LIKE ? OR w.surface_example LIKE ?)
             ORDER BY w.first_seen_at DESC, w.id DESC LIMIT 200`,
          )
          .all(e.id, `%${q}%`, `%${q}%`, `%${q}%`)
      : db
          .prepare(
            `SELECT w.id, w.lemma, w.surface_example, w.meaning_native, w.pos, w.level, w.source, w.example_target, w.example_native,
                    c.ease, c.interval_days, c.due_date, c.reps, c.lapses
             FROM words w LEFT JOIN srs_cards c ON c.word_id = w.id
             WHERE w.enrollment_id=?
             ORDER BY w.first_seen_at DESC, w.id DESC LIMIT 200`,
          )
          .all(e.id);
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
    if (!parsed.success) return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
    return content.addWordManually(enrollmentOf(req).id, parsed.data);
  });

  app.get('/api/srs/due', async (req) => {
    const e = enrollmentOf(req);
    return { cards: content.dueCards(e.id, 10), due_total: content.countDueCards(e.id) };
  });

  app.post('/api/words/suggest', async (req: FastifyRequest<{ Body: unknown }>, reply) => {
    const parsed = z
      .object({
        level: z.number().int().min(1).max(6).optional(),
        topic: z.string().min(1).max(60).optional(),
        count: z.number().int().min(1).max(10).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
    if (!ctx.callManager) return reply.code(503).send(errorBody('llm_not_configured', 'LLM not configured'));
    const e = enrollmentOf(req);
    const settings = readSettings(db, cfg, content.profileFor(e.targetLang), e.id);
    // Only this enrollment's own words are "already known", and only in this
    // enrollment's language profile.
    const known = content.knownLemmas(e.id);
    const knownLower = new Set(known.map((l) => l.toLowerCase()));
    try {
      const nativeProfile = cfg.langs.get(e.nativeLang);
      const promptCtx = {
        profile: content.profileFor(e.targetLang),
        native: {
          code: e.nativeLang,
          name: nativeProfile?.name ?? (e.nativeLang === 'en' ? 'English' : e.nativeLang === 'ko' ? 'Korean' : e.nativeLang),
        },
      };
      const suggestions = await ctx.callManager.generateJSON({
        system: wordSuggestSystem(promptCtx, parsed.data.level ?? settings.level),
        prompt: wordSuggestPrompt(promptCtx, parsed.data.count ?? 5, parsed.data.topic ?? null, known),
        schema: WordSuggestionsSchema,
      });
      return { suggestions: suggestions.words.filter((w) => !knownLower.has(w.lemma.toLowerCase())) };
    } catch (err) {
      if (err instanceof DailyCapReachedError)
        return reply.code(429).send(errorBody('daily_cap_reached', err.message));
      throw err;
    }
  });

  // ---------- Session history ----------
  app.get('/api/sessions', async (req) => ({ sessions: content.listDoneSessions(enrollmentOf(req).id) }));

  app.get('/api/sessions/:id/detail', async (req: PReq, reply) => {
    const row = ownSession(req, req.params.id, reply);
    if (!row) return reply;
    const detail = await content.sessionDetail(row.id as number, enrollmentOf(req).nativeLang);
    if (!detail) return reply.code(404).send(errorBody('no_completed_session', 'no completed session found'));
    return { detail };
  });

  // ---------- Progress (M6) ----------
  app.get('/api/progress', async (req) => {
    const e = enrollmentOf(req);
    const sessions = db
      .prepare(
        "SELECT id, date, read_score, write_score, listen_score, speak_score, vocab_score, duration_s FROM sessions WHERE enrollment_id=? AND status='done' ORDER BY date",
      )
      .all(e.id) as Array<Record<string, unknown>>;
    return {
      settings: readSettings(db, cfg, content.profileFor(e.targetLang), e.id),
      sessions,
      streakCalendar: (db
        .prepare("SELECT date FROM sessions WHERE enrollment_id=? AND status='done' ORDER BY date")
        .all(e.id) as Array<{ date: string }>).map((r) => r.date),
      history: content.history(e.id),
    };
  });

  /**
   * Wipe this enrollment's learning history, and only this enrollment's.
   *
   * This used to be `DELETE FROM <table>` with no WHERE at all, which meant one
   * person pressing "reset progress" destroyed every account's. The recordings
   * on disk go with it, because a DELETE does not reach the filesystem.
   */
  app.delete('/api/progress', async (req: FastifyRequest, reply) => {
    const parsed = z.object({ confirm: z.literal('reset') }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorBody('reset_confirm_required', 'must send {"confirm":"reset"}'));
    const e = enrollmentOf(req);
    const recordings = review.cleanupRecordings(e.id);
    const deleted = content.resetEnrollment(e.id);
    return { ok: true, deleted, recordings };
  });

  // ---------- Speaking practice (standalone screen) ----------
  app.get('/api/practice/read', async (req) => {
    const e = enrollmentOf(req);
    const selected = content.randomPack(e.targetLang);
    const pack = selected ? await content.nativePack(selected.passageId, e.nativeLang, selected.pack) : null;
    return { pack };
  });

  app.post('/api/practice/read-aloud', async (req: FastifyRequest<{ Body: { target?: string; transcript?: string } }>, reply) => {
    const parsed = z.object({ target: z.string().min(1), transcript: z.string().max(500) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorBody('validation_failed', parsed.error.message));
    const e = enrollmentOf(req);
    const diff = compareReadAloud(parsed.data.target, parsed.data.transcript);
    review.createReadAloudAttempt(e.id, null, parsed.data.target, parsed.data.transcript, diff.percent);
    return { target: parsed.data.target, ...diff };
  });

  app.post('/api/practice/free-response', async (req: FastifyRequest, reply) => {
    const e = enrollmentOf(req);
    const profile = content.profileFor(e.targetLang);
    const settings = readSettings(db, cfg, profile, e.id);
    const selected = content.randomPack(e.targetLang);
    const localized = selected ? await content.nativePack(selected.passageId, e.nativeLang, selected.pack) : null;
    const pack: SpeakingPackLike = localized ?? {
      level: settings.level,
      speaking_prompt: profile.fallbacks.speakingPrompt,
    };
    return handleFreeResponse(req, reply, ctx, e.id, null, pack);
  });

  // ---------- Neural TTS (listen buttons) ----------
  // The voice must belong to the caller's target language: TTS only ever speaks
  // target-language text, so the voice and the text have to be the same language.
  app.get('/api/tts', async (req: FastifyRequest<{ Querystring: { text?: string; voice?: string; rate?: string } }>, reply) => {
    const text = (req.query.text ?? '').trim();
    if (!text) return reply.code(400).send(errorBody('text_required', 'text is required'));
    if (text.length > 400) return reply.code(400).send(errorBody('text_too_long', 'text too long'));
    const rate = Number(req.query.rate ?? 0) || 0;
    try {
      const stream = await tts.synthesize({
        text,
        profile: activeProfile(req),
        voice: req.query.voice,
        rate,
      });
      reply.header('content-type', 'audio/mpeg');
      reply.header('cache-control', 'private, max-age=3600');
      return reply.send(stream);
    } catch (err) {
      // A voice from another language is the caller's mistake, not an outage.
      if (err instanceof UnknownVoiceError) return reply.code(400).send(errorBody('unknown_voice', err.message));
      console.error('[tts] synthesis failed:', err instanceof Error ? err.message : err);
      return reply.code(502).send(errorBody('tts_unavailable', 'TTS unavailable'));
    }
  });

  // ---------- LLM status (Settings screen) ----------
  // Deployment-wide, like the retry queue: the key, the model and today's call
  // count belong to the instance, not to a learner.
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

function describeLanguage(p: LanguageProfile) {
  return { code: p.code, name: p.name, endonym: p.endonym, htmlLang: p.htmlLang };
}

/**
 * Everything the client needs to render "who am I, and what am I learning".
 *
 * One endpoint rather than six: the client would otherwise have to stitch this
 * together from calls whose answers could disagree with each other mid-load, and
 * a page that half-renders with the wrong language profile is the exact bug this
 * phase exists to remove.
 */
function accountPayload(
  db: DatabaseSync,
  cfg: Ctx['cfg'],
  content: Ctx['content'],
  user: { id: number; username: string; displayName: string },
  active: Enrollment,
) {
  const profile = content.profileFor(active.targetLang);
  return {
    user: { id: user.id, username: user.username, display_name: user.displayName },
    activeEnrollmentId: active.id,
    enrollments: enrollmentsForUser(db, user.id).map((e) => ({
      id: e.id,
      targetLang: e.targetLang,
      nativeLang: e.nativeLang,
      uiLang: e.uiLang,
      displayName: e.displayName,
      lang: describeLanguage(content.profileFor(e.targetLang)),
    })),
    /** Target languages this deployment offers that this account has not added. */
    availableTargetLangs: availableTargetLangs(db, user.id, cfg.supportedTargetLangs),
    targetLangs: [...cfg.langs.values()].map(describeLanguage),
    uiLangs: [...cfg.copies.keys()],
    lang: languageDescriptor(profile),
    copy: copyFor(cfg, active.uiLang),
    settings: readSettings(db, cfg, profile, active.id),
  };
}

function effectiveTz(db: DatabaseSync, cfg: Ctx['cfg'], enrollmentId: number): string {
  const s = db.prepare('SELECT timezone FROM settings WHERE enrollment_id=?').get(enrollmentId) as
    | { timezone: string | null }
    | undefined;
  return s?.timezone || cfg.tz;
}

/**
 * The stored voice, or the active language's default.
 *
 * The stored value can be stale in two ways: an older build wrote a hardcoded
 * Korean voice here, and a deployment's language list can change under a saved
 * setting. Both are repaired the same way — fall back to the profile default
 * rather than hand the client a voice /api/tts would then reject. This is
 * deliberately more forgiving than `resolveVoice`, which throws: a read should
 * never 500 because of a setting written by an earlier build.
 */
function storedVoice(profile: LanguageProfile, stored: string | null): string {
  try {
    return resolveVoice(profile, stored);
  } catch (err) {
    if (err instanceof UnknownVoiceError) return profile.defaultVoice;
    throw err;
  }
}

/**
 * The client-facing description of a target language.
 *
 * The web app used to hardcode all of this: a three-entry list of Korean voices
 * in Settings, `"Beginner 2"` where the profile says `TOPIK 2`, and a `ko-KR`
 * fallback in useTts. Everything needed to render the language correctly is
 * already in the profile, so it travels with the settings the screens fetch —
 * and now describes whichever enrollment is active rather than one global
 * language.
 */
export function languageDescriptor(profile: LanguageProfile) {
  return {
    code: profile.code,
    name: profile.name,
    endonym: profile.endonym,
    /** One ordinary word in this language, for the "add a word" placeholder. */
    lexiconExample: profile.lexiconExample,
    htmlLang: profile.htmlLang,
    /** BCP-47 tag for speech recognition and TTS. */
    locale: profile.locale,
    defaultVoice: profile.defaultVoice,
    /** The complete allowlist; /api/tts will refuse anything else. */
    voices: profile.voices,
    levelScaleName: profile.levelScaleName,
    topics: profile.topics,
    /** Level number to its name on this language's scale, e.g. `3` -> `TOPIK 3`. */
    levels: Object.fromEntries(
      Object.entries(profile.levels).map(([level, entry]) => [
        level,
        { name: entry.name, note: entry.note },
      ]),
    ),
  };
}

export function readSettings(
  db: DatabaseSync,
  cfg: Ctx['cfg'],
  profile: LanguageProfile,
  enrollmentId: number,
) {
  const s = db.prepare('SELECT * FROM settings WHERE enrollment_id=?').get(enrollmentId) as Record<string, unknown>;
  return {
    level: Number(s.level) || 1,
    tts_rate: Number(s.tts_rate) || 1,
    tts_voice: storedVoice(profile, s.tts_voice as string | null),
    show_romanization: Boolean(s.show_romanization),
    keep_recordings_days: Number(s.keep_recordings_days) || 14,
    streak: Number(s.streak) || 0,
    last_session_date: (s.last_session_date as string | null) ?? null,
    timezone: effectiveTz(db, cfg, enrollmentId),
    lang: languageDescriptor(profile),
  };
}

async function handleFreeResponse(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: Ctx,
  enrollmentId: number,
  sessionId: number | null,
  pack: SpeakingPackLike,
) {
  const mime = (req.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
  const buf = req.body as Buffer | undefined;
  if (!buf || buf.length === 0) return reply.code(400).send(errorBody('empty_recording', 'empty recording'));
  if (buf.length > 50 * 1024 * 1024) return reply.code(413).send(errorBody('recording_too_large', 'recording too large'));

  const ext = mimeToExt(mime);
  const attemptId = ctx.review.createFreeSpeechAttempt(enrollmentId, sessionId, pack);
  const dir = path.join(ctx.cfg.dataDir, 'recordings');
  fs.mkdirSync(dir, { recursive: true });
  // The enrollment id is in the filename so the retention sweep below can stay
  // per-person: with two accounts sharing one data directory, a filename that
  // only carried a timestamp would make one account's setting delete the other
  // account's audio.
  const audioPath = path.join(dir, `freespeech_e${enrollmentId}_${Date.now()}_${attemptId}.${ext}`);
  fs.writeFileSync(audioPath, buf, { flag: 'wx' });
  ctx.review.setAttemptAudioPath(attemptId, enrollmentId, audioPath);

  let feedback: unknown = null;
  let queued = true;
  if (ctx.callManager) {
    try {
      queued = !(await ctx.review.gradeSpeakingAttempt(attemptId, enrollmentId));
      if (!queued) feedback = JSON.parse(ctx.review.getSpeakingAttempt(attemptId, enrollmentId)!.feedback_json as string);
    } catch (err) {
      if (!(err instanceof DailyCapReachedError)) {
        console.warn('[speaking] grading failed, will retry later:', err instanceof Error ? err.message : err);
      }
      queued = true;
    }
  }
  return { attempt_id: attemptId, queued, feedback };
}

/**
 * Age out one enrollment's recordings, per that enrollment's own retention
 * setting. `keep_recordings_days === 0` means keep forever, as before.
 */
function sweepRecordings(db: DatabaseSync, cfg: Ctx['cfg'], enrollmentId: number): void {
  const days = (db.prepare('SELECT keep_recordings_days FROM settings WHERE enrollment_id=?').get(enrollmentId) as {
    keep_recordings_days: number;
  }).keep_recordings_days;
  if (days === 0) return;
  const dir = path.join(cfg.dataDir, 'recordings');
  if (!fs.existsSync(dir)) return;
  const prefix = `freespeech_e${enrollmentId}_`;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith(prefix)) continue;
    const full = path.join(dir, f);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      /* ignore */
    }
  }
}
