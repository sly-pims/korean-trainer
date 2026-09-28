import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { Auth } from './auth.js';
import { Config, copyFor, langFor, REPO_ROOT } from './config.js';
import { Ctx } from './ctx.js';
import { openDb } from './db.js';
import { ensureSettingsRow, enrollmentById } from './enrollments.js';
import { CallManager } from './llm/callManager.js';
import { GeminiProvider } from './llm/gemini.js';
import { registerRoutes } from './routes.js';
import { checkFfmpeg } from './services/audio.js';
import { ContentService } from './services/content.js';
import { ReviewService } from './services/review.js';

export interface BuildOptions {
  config: Config;
  logger?: boolean;
}

/**
 * Routes reachable without a session: they cannot know whose data to return.
 *
 * Logout belongs here. If it did not, the one moment a client most needs to
 * clear a cookie — after it has expired, or after the account behind it is
 * gone — would be the one moment the request is refused, and the stale cookie
 * would stick around to be replayed.
 */
const PUBLIC_ROUTES = ['/api/login', '/api/health', '/api/meta', '/api/logout'];

/**
 * Exact match, not `startsWith`.
 *
 * A prefix test quietly exempts anything that merely begins with a public
 * route's name, so adding `/api/meta` would open `/api/meta-debug` to the
 * unauthenticated world the day somebody wrote it. Query strings are stripped
 * because callers do not get to smuggle a path in as a parameter.
 */
const isPublicRoute = (url: string): boolean => {
  const path = url.split('?')[0] ?? url;
  return PUBLIC_ROUTES.includes(path.replace(/\/+$/, '') || '/');
};

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const { config } = opts;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 * 1024 });

  fs.mkdirSync(config.dataDir, { recursive: true });
  const recordingsDir = path.join(config.dataDir, 'recordings');
  fs.mkdirSync(recordingsDir, { recursive: true });

  const primaryLang = config.supportedTargetLangs[0]!;
  const primaryProfile = langFor(config, primaryLang);

  const db = openDb(config.dbPath, {
    defaultVoice: primaryProfile.defaultVoice,
    bootstrapUser: {
      username: config.bootstrapUsername,
      password: config.authPassword,
      displayName: config.bootstrapDisplayName,
    },
    // The account this deployment has always had: the deployment's primary
    // target language, explained in the default UI language. Phase 8 and the
    // add-language flow are what move anyone off these two.
    bootstrapEnrollment: {
      targetLang: primaryLang,
      nativeLang: config.defaultUiLang,
      uiLang: config.defaultUiLang,
    },
  });

  // The timezone belongs to the person, not the box: two people in different
  // countries must not share one "today", or a session rolls over at the wrong
  // hour for one of them. Every date calculation takes an enrollment id.
  const getTz = (enrollmentId: number): string => {
    const row = db.prepare('SELECT timezone FROM settings WHERE enrollment_id=?').get(enrollmentId) as
      | { timezone: string | null }
      | undefined;
    return row?.timezone || config.tz;
  };

  // A brand-new account has no settings row yet, and every screen assumes one.
  for (const e of db.prepare('SELECT id, target_lang FROM enrollments').all() as {
    id: number;
    target_lang: string;
  }[]) {
    ensureSettingsRow(db, e.id, langFor(config, e.target_lang).defaultVoice, config.tz);
  }

  let callManager: CallManager | null = null;
  if (config.llmProvider === 'gemini' && config.geminiApiKey) {
    const provider = new GeminiProvider(config.geminiApiKey, config.geminiModel);
    callManager = new CallManager(provider, db, config.llmDailyCap, () => config.tz);
  } else {
    console.warn(
      `[config] LLM disabled${config.llmProvider === 'gemini' ? ' (no GEMINI_API_KEY set)' : ` (unknown LLM_PROVIDER "${config.llmProvider}")`} — seed content only.`,
    );
  }

  const auth = new Auth(config.sessionSecret, config.cookieSecure);
  const content = new ContentService(db, getTz, callManager, config.langs, REPO_ROOT);
  const review = new ReviewService(db, callManager, recordingsDir, config.ffmpegPath, config.langs);

  // ffmpeg health check: needed to convert recordings before Gemini grading.
  checkFfmpeg(config.ffmpegPath).catch((err) => {
    console.warn(
      `[audio] ffmpeg not found at ${config.ffmpegPath} — speaking feedback disabled. ${err instanceof Error ? err.message : ''}`,
    );
  });

  const ctx: Ctx = { db, cfg: config, auth, content, review, callManager };

  // Seed content bank: validate and import any new entries, per language.
  try {
    const result = content.loadSeed();
    console.log(
      `[seed] ${result.total} packs across ${config.supportedTargetLangs.join(', ')}: ${result.imported} imported, ${result.existing} existing, ${result.failed} failed`,
    );
    for (const err of result.errors) console.warn(`[seed] ${err}`);
  } catch (err) {
    console.error('[seed] failed to load seed bank:', err instanceof Error ? err.message : err);
  }

  // Retry queued grading from previous opens. Instance-global on purpose: the
  // queue is a property of the deployment's LLM budget, not of a person, and a
  // queued attempt has to be graded in its own language either way.
  if (callManager && callManager.stats().callsToday < config.llmDailyCap) {
    review.retryQueued().then((r) => {
      console.log(
        `[review] retry queue: writing ${r.writing.graded}/${r.writing.tried}, speaking ${r.speaking.graded}/${r.speaking.tried}`,
      );
    });
  }

  await app.register(fastifyCookie);

  // Raw-body parser for audio uploads (MediaRecorder blobs).
  app.addContentTypeParser(
    /^audio\/|^video\/|^application\/octet-stream/,
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  /**
   * Identity, resolved once per request.
   *
   * The cookie is HMAC-signed and carries both the user and the active
   * enrollment, so nothing here trusts a request parameter. The enrollment is
   * re-read from the database rather than taken from the token payload, so a
   * token that outlives a deleted account or enrollment stops working instead of
   * resolving to a row that no longer exists.
   *
   * The manifest is deliberately *not* exempt: it is a static asset, but naming
   * the installed app in the learner's own language is worth having a session
   * for, and it falls back to the deployment default when there isn't one.
   */
  app.addHook('preHandler', async (req, reply) => {
    const url = req.raw.url ?? '';
    if (isPublicRoute(url)) return;

    const token = req.cookies?.[auth.cookieName];
    const identity = auth.verifyToken(token);
    if (!identity) {
      if (url.startsWith('/api/')) {
        return reply.code(401).send({ code: 'unauthorized', error: 'unauthorized' });
      }
      return; // the manifest: fall back to deployment defaults below
    }
    const enrollment = enrollmentById(db, identity.enrollmentId);
    if (!enrollment || enrollment.userId !== identity.userId) {
      // A valid signature for an account or enrollment that is gone.
      reply.clearCookie(auth.cookieName, auth.clearCookieOptions());
      if (url.startsWith('/api/')) {
        return reply.code(401).send({ code: 'unauthorized', error: 'unauthorized' });
      }
      return;
    }
    req.enrollment = enrollment;
  });

  // Registered before @fastify/static so it wins over the built manifest file.
  // Named from the session when there is one, so an installed PWA carries the
  // learner's own language, and from the deployment default otherwise.
  app.get('/manifest.webmanifest', async (req, reply) => {
    const uiLang = req.enrollment?.uiLang ?? config.defaultUiLang;
    const copy = copyFor(config, uiLang);
    return reply
      .header('content-type', 'application/manifest+json')
      .send({
        name: copy.appName,
        short_name: copy.appName,
        description: copy.appTagline,
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f7f7f8',
        theme_color: '#0b57d0',
        lang: langFor(config, req.enrollment?.targetLang ?? primaryLang).htmlLang,
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      });
  });

  await registerRoutes(app, ctx);

  // Serve the built frontend in production; falls back to index.html for the SPA.
  const webDist = config.webDist;
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) {
        return reply.code(404).send({ code: 'not_found', error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, ctx };
}
