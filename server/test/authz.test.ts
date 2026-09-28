import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { cleanupTempArtifacts, type TestApp } from './fixtures.js';
import { authzSignedInFixture } from './helpers/authzFixture.js';

/**
 * Two accounts, one database.
 *
 * Every route that names a row by id is an opportunity to read somebody else's
 * history, because the ids are sequential integers: if `/api/sessions/1/detail`
 * does not check who owns session 1, then "1" is everybody's first session and
 * the second account on the deployment reads the first account's day one.
 *
 * The rule these tests pin: a row that is not yours is **404, not 403**. The
 * distinction is the whole point — a 403 proves the row exists, which turns the
 * id space into a working enumeration oracle.
 */

let app: TestApp;

beforeEach(async () => {
  app = await authzSignedInFixture();
});

afterEach(() => {
  cleanupTempArtifacts();
});

describe('a session that belongs to somebody else', () => {
  it('is a 404 from every route that takes a session id', async () => {
    const { otherSessionId, mySessionId, myCookie } = app;
    // Use the real ids: the fixture inserts the caller's session first, so
    // hardcoding `1` would test the caller's own row and pass for free.
    expect(otherSessionId).toBeGreaterThan(0);
    expect(otherSessionId).not.toBe(mySessionId);
    const paths: [string, unknown?][] = [
      ['/step', { step: 'reading' }],
      ['/word-tap', { surface: '가족' }],
      ['/read', { answers: [0, 0, 0] }],
      ['/writing', { text: 'hello' }],
      ['/listening', { transcripts: ['a', 'b', 'c'] }],
      ['/complete', { duration_s: 10 }],
    ];
    for (const [suffix, payload] of paths) {
      const url = `/api/session/${otherSessionId}${suffix}`;
      const res = await app.post(url, payload, myCookie);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().code, url).toBe('not_found');
    }
  });

  it('is a 404 rather than a 403, so ids cannot be probed', async () => {
    // Same answer for "no such row" and "not your row". If this ever returns
    // 403 for one and 404 for the other, the ids are enumerable.
    const { myCookie, otherSessionId } = app;
    const missing = await app.post('/api/session/999999/step', { step: 'reading' }, myCookie);
    const foreign = await app.post(`/api/session/${otherSessionId}/step`, { step: 'reading' }, myCookie);
    expect(missing.statusCode).toBe(404);
    expect(foreign.statusCode).toBe(missing.statusCode);
    expect(foreign.json()).toEqual(missing.json());
  });

  it('refuses a non-numeric id with a 400, not a 404 or a 500', async () => {
    const res = await app.post('/api/session/not-a-number/step', { step: 'reading' }, app.myCookie);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation_failed');
  });

  it('is a 404 from the history detail route', async () => {
    const res = await app.get(`/api/sessions/${app.otherSessionId}/detail`, app.myCookie);
    expect(res.statusCode).toBe(404);
  });

  it('cannot be completed, which would corrupt the other person’s streak', async () => {
    // The streak lives in the caller's `settings` row, so completing somebody
    // else's session would bump their counter and move `last_session_date`.
    const otherEnrollment = (
      app.db
        .prepare('SELECT enrollment_id FROM sessions WHERE id=?')
        .get(app.otherSessionId) as { enrollment_id: number }
    ).enrollment_id;
    const settingsBefore = app.db
      .prepare('SELECT streak, last_session_date FROM settings WHERE enrollment_id=?')
      .get(otherEnrollment);
    const sessionBefore = app.db
      .prepare('SELECT status, current_step, duration_s FROM sessions WHERE id=?')
      .get(app.otherSessionId);

    const res = await app.post(`/api/session/${app.otherSessionId}/complete`, { duration_s: 60 }, app.myCookie);
    expect(res.statusCode).toBe(404);

    expect(
      app.db.prepare('SELECT status, current_step, duration_s FROM sessions WHERE id=?').get(app.otherSessionId),
    ).toEqual(sessionBefore);
    expect(
      app.db.prepare('SELECT streak, last_session_date FROM settings WHERE enrollment_id=?').get(otherEnrollment),
    ).toEqual(settingsBefore);
  });
});

describe('a row that belongs to somebody else', () => {
  it('is a 404 from the writing and speaking read routes', async () => {
    const { otherWritingId, otherSpeakingId, myCookie } = app;
    for (const [url, id] of [
      ['/api/writing/', otherWritingId],
      ['/api/speaking/', otherSpeakingId],
    ] as const) {
      const res = await app.get(`${url}${id}`, myCookie);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().code, url).toBe('not_found');
    }
  });

  it('cannot have its SRS card reviewed into the other person’s schedule', async () => {
    const { otherWordId, myCookie } = app;
    const before = app.db.prepare('SELECT * FROM srs_cards WHERE word_id=?').get(otherWordId);
    const res = await app.post('/api/srs/review', { word_id: otherWordId, rating: 'easy' }, myCookie);
    expect(res.statusCode).toBe(404);
    const after = app.db.prepare('SELECT * FROM srs_cards WHERE word_id=?').get(otherWordId);
    expect(after).toEqual(before);
  });
});

describe('the list endpoints', () => {
  it('show only the caller’s own rows', async () => {
    const { myCookie, otherCookie } = app;
    for (const url of ['/api/words', '/api/sessions', '/api/srs/due', '/api/progress']) {
      const mine = await app.get(url, myCookie);
      const theirs = await app.get(url, otherCookie);
      expect(mine.statusCode, url).toBe(200);
      expect(theirs.statusCode, url).toBe(200);
      expect(mine.json(), url).not.toEqual(theirs.json());
    }
  });

  it('each account sees only its own vocabulary', async () => {
    const mine = (await app.get('/api/words', app.myCookie)).json().words as Array<{ lemma: string }>;
    const theirs = (await app.get('/api/words', app.otherCookie)).json().words as Array<{ lemma: string }>;
    expect(mine.map((w) => w.lemma)).toEqual(['mine']);
    expect(theirs.map((w) => w.lemma)).toEqual(['theirs']);
  });
});

describe('resetting progress', () => {
  it('wipes only the caller’s rows', async () => {
    // This used to be `DELETE FROM <table>` with no WHERE, which meant one
    // person pressing "reset progress" destroyed every account's.
    const { myCookie, otherCookie, otherWordId } = app;
    const res = await app.del('/api/progress', { confirm: 'reset' }, myCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted.words).toBe(1);
    expect(res.json().deleted.sessions).toBe(1);

    expect((app.db.prepare('SELECT COUNT(*) c FROM words').get() as { c: number }).c).toBe(1);
    expect(app.db.prepare('SELECT lemma FROM words WHERE id=?').get(otherWordId)).toBeTruthy();
    expect((await app.get('/api/words', otherCookie)).json().words).toHaveLength(1);
  });

  it('still requires the confirmation word', async () => {
    const res = await app.del('/api/progress', { confirm: 'yes' }, app.myCookie);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('reset_confirm_required');
    expect((app.db.prepare('SELECT COUNT(*) c FROM words').get() as { c: number }).c).toBe(2);
  });

  it('deletes the caller’s recordings from disk, and only theirs', async () => {
    const { myCookie, otherCookie, recordingsDir, myRecording, otherRecording } = app;
    expect(fsExists(myRecording)).toBe(true);
    expect(fsExists(otherRecording)).toBe(true);
    await app.del('/api/progress', { confirm: 'reset' }, myCookie);
    expect(fsExists(myRecording)).toBe(false);
    expect(fsExists(otherRecording)).toBe(true);
    expect(recordingsDir).toContain('recordings');
    void otherCookie;
  });
});

describe('the timezone', () => {
  it('belongs to the enrollment, not the process', async () => {
    // Two people in different countries must not share one "today", or a
    // session rolls over at the wrong hour for one of them.
    app.db.prepare('UPDATE settings SET timezone=? WHERE enrollment_id=?').run('Asia/Seoul', app.enrollmentId);
    const mine = (await app.get('/api/home', app.myCookie)).json();
    const theirs = (await app.get('/api/home', app.otherCookie)).json();
    expect(mine.tz).toBe('Asia/Seoul');
    expect(theirs.tz).not.toBe('Asia/Seoul');
  });
});

describe('an unauthenticated request', () => {
  it('is refused everywhere except the endpoints that must work without a session', async () => {
    const privateUrls = [
      '/api/account',
      '/api/home',
      '/api/settings',
      '/api/session/today',
      '/api/words',
      '/api/sessions',
      '/api/progress',
      '/api/llm/status',
    ];
    for (const url of privateUrls) {
      const res = await app.anon(url);
      expect(res.statusCode, url).toBe(401);
      expect(res.json().code, url).toBe('unauthorized');
    }
    // The public ones answer on their own terms: meta describes the deployment,
    // health reports liveness, logout clears a cookie nobody has.
    expect((await app.anon('/api/meta')).statusCode).toBe(200);
    expect((await app.anon('/api/health')).statusCode).toBe(200);
    const out = await app.anon('/api/logout', 'POST');
    expect(out.statusCode).toBe(200);
    expect(out.json().ok).toBe(true);
    // Login without a body is still a bad request, not a session: reaching the
    // handler proves it was public, and the zod check still applies.
    const login = await app.anon('/api/login', 'POST', {});
    expect(login.statusCode).toBe(400);
    expect(login.json().code).toBe('validation_failed');
  });

  it('reaches /api/meta so a signed-out login screen can list the languages', async () => {
    expect((await app.anon('/api/meta')).statusCode).toBe(200);
    expect((await app.anon('/api/account')).statusCode).toBe(401);
  });

  it('is not fooled by a route that merely starts with a public route’s name', async () => {
    // `startsWith` used to decide what was public, so `/api/meta-debug` would
    // have been reachable without a session. Exact matching is the fix.
    const res = await app.anon('/api/meta/../account');
    expect([401, 404]).toContain(res.statusCode);
  });
});

function fsExists(p: string): boolean {
  return existsSync(p);
}
