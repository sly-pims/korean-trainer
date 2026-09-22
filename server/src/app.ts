import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { Auth } from './auth.js';
import { Config } from './config.js';
import { Ctx } from './ctx.js';
import { openDb } from './db.js';
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

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const { config } = opts;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 * 1024 });

  fs.mkdirSync(config.dataDir, { recursive: true });
  const recordingsDir = path.join(config.dataDir, 'recordings');
  fs.mkdirSync(recordingsDir, { recursive: true });

  const db = openDb(config.dbPath);
  const seedTz = db.prepare('SELECT timezone FROM settings WHERE id=1').get() as
    | { timezone: string | null }
    | undefined;
  if (!seedTz?.timezone) {
    db.prepare('UPDATE settings SET timezone=?, created_at=? WHERE id=1').run(
      config.tz,
      new Date().toISOString(),
    );
  }

  const getTz = () => {
    const row = db.prepare('SELECT timezone FROM settings WHERE id=1').get() as
      | { timezone: string | null }
      | undefined;
    return row?.timezone || config.tz;
  };

  let callManager: CallManager | null = null;
  if (config.llmProvider === 'gemini' && config.geminiApiKey) {
    const provider = new GeminiProvider(config.geminiApiKey, config.geminiModel);
    callManager = new CallManager(provider, db, config.llmDailyCap, getTz);
  } else {
    console.warn(
      `[config] LLM disabled${config.llmProvider === 'gemini' ? ' (no GEMINI_API_KEY set)' : ` (unknown LLM_PROVIDER "${config.llmProvider}")`} — seed content only.`,
    );
  }

  const auth = new Auth(config.sessionSecret, config.authPassword, config.cookieSecure);
  const content = new ContentService(db, getTz, callManager, config.seedPath);
  const review = new ReviewService(db, callManager, recordingsDir, config.ffmpegPath);

  // ffmpeg health check (§8.3): needed to convert recordings before Gemini grading.
  checkFfmpeg(config.ffmpegPath).catch((err) => {
    console.warn(
      `[audio] ffmpeg not found at ${config.ffmpegPath} — speaking feedback disabled. ${err instanceof Error ? err.message : ''}`,
    );
  });

  const ctx: Ctx = { db, cfg: config, auth, content, review, callManager };

  // Seed content bank (§9): validate and import any new entries.
  try {
    const result = content.loadSeed();
    console.log(
      `[seed] ${result.total} packs: ${result.imported} imported, ${result.existing} existing, ${result.failed} failed`,
    );
    for (const err of result.errors) console.warn(`[seed] ${err}`);
  } catch (err) {
    console.error('[seed] failed to load seed bank:', err instanceof Error ? err.message : err);
  }

  // Retry queued grading from previous opens (§4.2 #5, #6).
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

  // Auth middleware (§10): signed cookie on everything except login + health.
  app.addHook('preHandler', async (req, reply) => {
    const url = req.raw.url ?? '';
    if (url.startsWith('/api/login') || url.startsWith('/api/health')) return;
    if (url.startsWith('/api/')) {
      const token = req.cookies?.[auth.cookieName];
      if (!auth.verifyToken(token)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    }
  });

  await registerRoutes(app, ctx);

  // Serve the built frontend in production; falls back to index.html for the SPA.
  const webDist = config.webDist;
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, ctx };
}