import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type OpenDbOptions } from '../src/db.js';
import { createEnrollment, ensureSettingsRow } from '../src/enrollments.js';

/**
 * Test fixtures for the multi-account app.
 *
 * Two things changed underneath every server test: `openDb` now takes options
 * rather than a voice string, and login takes a username. Rather than repeat
 * those in each file, they live here once — a test that hand-rolls a login
 * payload is a test that can keep passing after login stops accepting
 * passwords.
 */

export const TEST_PASSWORD = 'korean';
export const TEST_VOICE = 'test-voice';

export const TEST_OPEN_DB: OpenDbOptions = {
  defaultVoice: TEST_VOICE,
  bootstrapUser: { username: 'default', password: TEST_PASSWORD, displayName: 'Learner' },
  bootstrapEnrollment: { targetLang: 'ko', nativeLang: 'en', uiLang: 'en' },
};

/** `openDb` with the standard options, for tests that only need a database. */
export function openTestDb(file: string, overrides: Partial<OpenDbOptions> = {}): DatabaseSync {
  return openDb(file, { ...TEST_OPEN_DB, ...overrides });
}

const tempDirs: string[] = [];
const openApps: Array<{ close: () => Promise<unknown> }> = [];

/** A temp directory that {@link cleanupTempArtifacts} will remove. */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempArtifacts(): void {
  for (const app of openApps.splice(0)) {
    try {
      void app.close();
    } catch {
      /* ignore */
    }
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export interface TestApp {
  app: Awaited<ReturnType<typeof buildApp>>['app'];
  ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
  db: DatabaseSync;
  cfg: Config;
  /** The bootstrap account's id, and its first enrollment's id. */
  userId: number;
  enrollmentId: number;
  /** The session cookie's name, for asserting on `Set-Cookie`. */
  cookieName: string;
  /**
   * A ready-made cookie for the bootstrap account on its first enrollment.
   *
   * Signable without a request, unlike {@link TestApp.login}, so a test that is
   * not about logging in does not have to log in. The `get`/`post`/`put`/`del`
   * helpers send it by default; use {@link TestApp.anon} to send nothing.
   */
  cookie: string;
  /**
   * A request with no session cookie at all.
   *
   * The reason the helpers default to {@link TestApp.cookie} rather than to
   * nothing: the authorization tests are mostly about what a logged-in caller
   * can and cannot reach, and making each of them pass the same string adds
   * noise without adding safety. A test that needs the login gate itself has to
   * ask for it by name, which is the point.
   */
  anon: (url: string, method?: 'GET' | 'POST' | 'PUT' | 'DELETE', payload?: unknown) => Promise<import('light-my-request').Response>;
  /** Log in and return a replayable `Cookie` header. */
  login: (username?: string, password?: string) => Promise<string>;
  /** A cookie header for an arbitrary account, creating it if needed. */
  asUser: (username: string, password?: string) => Promise<string>;
  /** A cookie header with a different enrollment selected. */
  switchTo: (enrollmentId: number) => string;
  /**
   * The same helpers with a cookie, for switching accounts mid-test.
   *
   * `get` takes the cookie second and the others third, so that
   * `get(url, cookie)` reads the way it looks and a body never has to be passed
   * just to reach the cookie argument. Every call sends {@link TestApp.cookie}
   * unless told otherwise.
   */
  get: (url: string, cookie?: string) => Promise<import('light-my-request').Response>;
  post: (url: string, payload?: unknown, cookie?: string) => Promise<import('light-my-request').Response>;
  put: (url: string, payload?: unknown, cookie?: string) => Promise<import('light-my-request').Response>;
  del: (url: string, payload?: unknown, cookie?: string) => Promise<import('light-my-request').Response>;
  inject: typeof import('../src/app.js') extends never ? never : (opts: Parameters<Awaited<ReturnType<typeof buildApp>>['app']['inject']>[0]) => Promise<import('light-my-request').Response>;
}

export interface TestAppOptions {
  /** Deployment's target languages, first one being the primary. */
  targetLangs?: string;
  uiLangs?: string;
  defaultUiLang?: string;
  env?: Record<string, string | undefined>;
}

/**
 * A running app on a throwaway database, with the bootstrap account in place.
 *
 * `targetLangs` is the deployment's list and the first entry is the primary one,
 * which is also the bootstrap enrollment's language — the same thing a real
 * deployment does, so a test that adds a second language sees the same ordering
 * the app would.
 */
export async function makeTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const dir = tempDir('korean-test-');
  const targetLangs = opts.targetLangs ?? 'ko';
  const uiLangs = opts.uiLangs ?? 'en';
  const cfg = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-secret-123',
    SUPPORTED_TARGET_LANGS: targetLangs,
    SUPPORTED_UI_LANGS: uiLangs,
    DEFAULT_UI_LANG: opts.defaultUiLang ?? uiLangs.split(',')[0]!,
    DATA_DIR: path.join(dir, 'data'),
    DB_PATH: path.join(dir, 'data', 'test.db'),
    ...opts.env,
  });

  const built = await buildApp({ config: cfg });
  const { app, ctx } = built;
  openApps.push(app);
  const { db } = ctx;

  const first = db.prepare('SELECT id FROM users WHERE username=?').get('default') as { id: number };
  const firstEnrollment = db
    .prepare('SELECT id FROM enrollments WHERE user_id=? ORDER BY id LIMIT 1')
    .get(first.id) as { id: number };

  const cookieOf = (res: import('light-my-request').Response): string => {
    const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (!cookie) throw new Error(`login did not set a cookie (status ${res.statusCode}: ${res.body})`);
    return cookie;
  };

  const login = async (username = 'default', password = TEST_PASSWORD): Promise<string> => {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    return cookieOf(res);
  };

  /**
   * A cookie for an account that may not exist yet.
   *
   * The first call *creates* the account, because most of the interesting
   * tests are about two people who each have their own history, and writing that
   * fixture by hand in every file is how the two accounts end up sharing one.
   */
  const asUser = async (username: string, password = `pw-${username}`): Promise<string> => {
    const existing = db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number } | undefined;
    if (!existing) {
      db.prepare(
        'INSERT INTO users (username, password_hash, display_name, is_bootstrap, created_at) VALUES (?,?,?,0,?)',
      ).run(username, hashPassword(password), username, new Date().toISOString());
      const id = db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number };
      const primary = targetLangs.split(',')[0]!.trim();
      const ui = cfg.defaultUiLang;
      const { enrollment } = createEnrollment(db, id.id, { targetLang: primary, nativeLang: ui, uiLang: ui });
      ensureSettingsRow(db, enrollment.id, TEST_VOICE, cfg.tz);
    }
    return login(username, password);
  };

  const cookie = `${ctx.auth.cookieName}=${ctx.auth.createToken(first.id, firstEnrollment.id)}`;
  const headers = (withCookie: string | undefined) => (withCookie ? { headers: { cookie: withCookie } } : {});
  const withBody = (method: string, url: string, payload: unknown, withCookie: string) =>
    app.inject({
      method: method as 'POST',
      url,
      ...(method === 'GET' ? {} : { payload: payload ?? {} }),
      ...headers(withCookie),
    });
  const body = (method: 'POST' | 'PUT' | 'DELETE') => (url: string, payload?: unknown, withCookie = cookie) =>
    withBody(method, url, payload, withCookie);

  return {
    app,
    ctx,
    db,
    cfg,
    userId: first.id,
    enrollmentId: firstEnrollment.id,
    cookieName: ctx.auth.cookieName,
    cookie,
    login,
    asUser,
    /** Re-signs a cookie for another enrollment, the way the activate route does. */
    switchTo: (enrollmentId: number) => `${ctx.auth.cookieName}=${ctx.auth.createToken(first.id, enrollmentId)}`,
    get: (url, withCookie = cookie) => withBody('GET', url, undefined, withCookie),
    post: body('POST'),
    put: body('PUT'),
    del: body('DELETE'),
    /** No cookie at all: `anon(url)`, `anon(url, 'POST', payload)`. */
    anon: (url, method = 'GET', payload) => withBody(method, url, payload, ''),
    inject: (injectOpts) => app.inject(injectOpts),
  };
}
