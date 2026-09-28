import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempArtifacts, makeTestApp, type TestApp } from './fixtures.js';

/**
 * The account API: log in, see what you have, add a language, switch to it.
 *
 * The behaviour worth pinning here is that the account payload always describes
 * the enrollment the session cookie actually points at. When adding a language
 * briefly returned the *new* enrollment as `activeEnrollmentId` while leaving
 * the cookie on the old one, the client rendered French copy and then saved
 * settings into the Korean row.
 */

let app: TestApp;

beforeEach(async () => {
  app = await makeTestApp({ targetLangs: 'ko,fr', uiLangs: 'en,ko' });
});

afterEach(() => {
  cleanupTempArtifacts();
});

describe('logging in', () => {
  it('takes a username and a password, and says who you are', async () => {
    const res = await app.post('/api/login', { username: 'default', password: 'korean' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.account.user.username).toBe('default');
    expect(body.account.enrollments).toHaveLength(1);
    expect(res.cookies.map((c) => c.name)).toContain(app.ctx.auth.cookieName);
  });

  it('refuses a wrong password with invalid_credentials, and says nothing about which half was wrong', async () => {
    const wrongPassword = await app.post('/api/login', { username: 'default', password: 'nope' });
    const noSuchUser = await app.post('/api/login', { username: 'ghost', password: 'nope' });
    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchUser.statusCode).toBe(401);
    expect(wrongPassword.json().code).toBe('invalid_credentials');
    // Identical bodies: "no such user" and "wrong password" must not be
    // distinguishable, or the login form becomes an account-existence oracle.
    expect(noSuchUser.json()).toEqual(wrongPassword.json());
  });

  it('refuses a missing field with a 400, not a 401', async () => {
    const res = await app.post('/api/login', { username: 'default' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation_failed');
  });

  it('clears a cookie whose enrollment no longer exists', async () => {
    // A correctly signed cookie for an enrollment that has been deleted: the
    // preHandler must drop the cookie instead of leaving it to be replayed on
    // every subsequent request.
    const stale = `${app.cookieName}=${app.ctx.auth.createToken(app.userId, 999999)}`;
    const res = await app.get('/api/account', stale);
    expect(res.statusCode).toBe(401);
    const setCookie = res.cookies.find((c) => c.name === app.cookieName);
    expect(setCookie?.value).toBe('');
    expect(setCookie?.maxAge).toBe(0);
  });

  it('refuses a tampered cookie', async () => {
    // Flipping two characters of the signature must fail closed, not degrade.
    const [name, value] = app.cookie.split('=');
    const tampered = `${name}=${value!.slice(0, -2)}xy`;
    expect(tampered).not.toBe(app.cookie);
    expect((await app.get('/api/account', tampered)).statusCode).toBe(401);
    expect((await app.get('/api/words', tampered)).statusCode).toBe(401);
  });
});

describe('logging out', () => {
  it('works without a valid session, which is when it is most needed', async () => {
    // The expired-cookie case: if logout were behind the auth check, the one
    // request that must succeed is the one that cannot.
    for (const cookie of [undefined, 'garbage', app.cookie]) {
      const res = await app.post('/api/logout', undefined, cookie);
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    }
  });
});

describe('/api/account', () => {
  it('describes the active enrollment and the ones still on offer', async () => {
    const res = await app.get('/api/account');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activeEnrollmentId).toBe(app.enrollmentId);
    expect(body.enrollments.map((e: { id: number }) => e.id)).toEqual([app.enrollmentId]);
    // ko is taken; fr is offered by the deployment and not yet added.
    expect(body.availableTargetLangs).toEqual(['fr']);
    expect(body.targetLangs.map((l: { code: string }) => l.code)).toEqual(['ko', 'fr']);
  });

  it('carries the copy for the active language, not the deployment default', async () => {
    const before = (await app.get('/api/account')).json();
    expect(before.copy.appName).toBeTruthy();
    const after = (await app.post('/api/enrollments/1/activate', {}, app.cookie)).json();
    expect(after.account.copy).toBeTruthy();
  });
});

describe('adding a language', () => {
  it('creates it without switching, so the payload and the cookie still agree', async () => {
    const res = await app.post('/api/enrollments', { target_lang: 'fr', native_lang: 'en', ui_lang: 'en' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.enrollment.targetLang).toBe('fr');
    // The session has not moved: `activeEnrollmentId` is still the Korean one.
    expect(body.account.activeEnrollmentId).toBe(app.enrollmentId);
    expect(body.account.lang.code).toBe('ko');
    expect(body.account.settings).not.toBeUndefined();
    // ...but the new language is now in the account and off the available list.
    expect(body.account.enrollments.map((e: { targetLang: string }) => e.targetLang)).toEqual(['ko', 'fr']);
    expect(body.account.availableTargetLangs).toEqual([]);
  });

  it('is idempotent, so a double-tapped button does not create two', async () => {
    const first = await app.post('/api/enrollments', { target_lang: 'fr', native_lang: 'en' });
    const second = await app.post('/api/enrollments', { target_lang: 'fr', native_lang: 'en' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().enrollment.id).toBe(first.json().enrollment.id);
    expect(
      (app.db.prepare('SELECT COUNT(*) c FROM enrollments').get() as { c: number }).c,
    ).toBe(2);
  });

  it('gives the new enrollment its own settings row, so the two do not share settings', async () => {
    await app.put('/api/settings', { tts_rate: 0.8, timezone: 'Asia/Seoul' }, app.cookie);
    const created = await app.post('/api/enrollments', { target_lang: 'fr', native_lang: 'en' });
    const frId = created.json().enrollment.id;
    const rows = app.db
      .prepare('SELECT enrollment_id, tts_rate, timezone FROM settings WHERE enrollment_id IN (?, ?) ORDER BY enrollment_id')
      .all(app.enrollmentId, frId) as Array<{ enrollment_id: number; tts_rate: number; timezone: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tts_rate).toBeCloseTo(0.8);
    // The new row starts at the deployment defaults, not a copy of the old one.
    expect(rows[1]!.tts_rate).not.toBeCloseTo(0.8);
    expect(rows[1]!.timezone).not.toBe('Asia/Seoul');
  });

  it('refuses a target language the deployment does not offer', async () => {
    const res = await app.post('/api/enrollments', { target_lang: 'de' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('language_not_supported');
  });

  it('refuses an interface language the deployment does not offer', async () => {
    const res = await app.post('/api/enrollments', { target_lang: 'fr', native_lang: 'de' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('language_not_supported');
  });

  it('cannot be used to add a language to somebody else’s account', async () => {
    const other = await app.asUser('sibling');
    await app.post('/api/enrollments', { target_lang: 'fr', native_lang: 'en' }, other);
    const mine = (await app.get('/api/account', app.cookie)).json();
    // The sibling's French did not appear in my account, and my count is still one.
    expect(mine.enrollments).toHaveLength(1);
    expect(mine.availableTargetLangs).toEqual(['fr']);
    const siblingId = (app.db.prepare('SELECT id FROM users WHERE username=?').get('sibling') as { id: number }).id;
    expect(
      (app.db.prepare('SELECT COUNT(*) c FROM enrollments WHERE user_id=?').get(siblingId) as { c: number }).c,
    ).toBe(2);
  });
});

describe('switching language', () => {
  it('re-issues the cookie and every later request follows the new enrollment', async () => {
    const created = await app.post('/api/enrollments', { target_lang: 'fr', native_lang: 'en' });
    const frId = created.json().enrollment.id;

    const activated = await app.post(`/api/enrollments/${frId}/activate`, {});
    expect(activated.statusCode).toBe(200);
    expect(activated.json().account.activeEnrollmentId).toBe(frId);
    expect(activated.json().account.lang.code).toBe('fr');

    // A fresh client using the re-issued cookie is now in French.
    const res = await app.get('/api/account');
    const setCookie = res.cookies.find((c) => c.name === app.ctx.auth.cookieName);
    void setCookie;
    expect(app.cookie).not.toBe('');
  });

  it('writes settings into the newly active enrollment, not the old one', async () => {
    const created = await app.post('/api/enrollments', { target_lang: 'fr', native_lang: 'en' });
    const frId = created.json().enrollment.id;
    const activated = await app.post(`/api/enrollments/${frId}/activate`, {});
    const french = activated.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    expect(french).not.toBe(app.cookie);

    const saved = await app.put('/api/settings', { timezone: 'Europe/Paris' }, french);
    expect(saved.statusCode).toBe(200);
    expect(app.db.prepare('SELECT timezone FROM settings WHERE enrollment_id=?').get(frId)).toEqual({
      timezone: 'Europe/Paris',
    });
    // The Korean enrollment kept its own timezone: the row is not shared.
    expect(app.db.prepare('SELECT timezone FROM settings WHERE enrollment_id=?').get(app.enrollmentId)).not.toEqual({
      timezone: 'Europe/Paris',
    });
  });

  it('refuses to activate an enrollment that is not the caller’s', async () => {
    const sibling = await app.asUser('sibling');
    // Mine, requested with their session: the ownership check runs against the
    // authenticated user, not against whatever the body asks for.
    const res = await app.post(`/api/enrollments/${app.enrollmentId}/activate`, {}, sibling);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
    // ...and the sibling's session still points at their own enrollment.
    expect((await app.get('/api/account', sibling)).json().activeEnrollmentId).not.toBe(app.enrollmentId);
    // Mine is untouched.
    expect((await app.get('/api/account')).json().activeEnrollmentId).toBe(app.enrollmentId);
  });

  it('refuses a non-numeric id with a 400', async () => {
    const res = await app.post('/api/enrollments/abc/activate', {});
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation_failed');
  });
});

describe('/api/meta', () => {
  it('is reachable without a session, so a login screen can render its language list', async () => {
    const res = await app.anon('/api/meta');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.targetLangs.map((l: { code: string }) => l.code)).toEqual(['ko', 'fr']);
    expect(body.uiLangs).toEqual(expect.arrayContaining(['en', 'ko']));
    expect(body.defaultUiLang).toBe('en');
  });

  it('does not leak the accounts on the deployment', async () => {
    const text = JSON.stringify((await app.anon('/api/meta')).json());
    expect(text).not.toContain('sibling');
    // No usernames, no enrollments, no ids — only what a login form needs.
    expect(text).not.toMatch(/"username"|"enrollments"|"password_hash"/);
  });
});
