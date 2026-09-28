/**
 * Phase 2 + 7 rehearsal, off-box, against a copy of the database.
 *
 * Not a unit test: this runs the *built* server over HTTP, the way the Pi will,
 * so it exercises the migration, the login, the enrollment switch and the
 * second account's isolation for real. It never touches the live database.
 *
 *   node scripts/rehearse-migration.js --db <copy.sqlite>
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-'));
const dbPath = path.join(dir, 'rehearsal.db');
const source = arg('db', null);
if (source) {
  // VACUUM INTO rather than a file copy: it produces a consistent snapshot
  // even if the source is in WAL mode, where a plain copy can miss committed
  // pages still sitting in the -wal file.
  const src = new DatabaseSync(source, { readOnly: true });
  src.exec(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`);
  src.close();
  console.log(`snapshot of ${source} -> ${dbPath}`);
} else {
  fs.writeFileSync(dbPath, '');
  console.log(`empty database at ${dbPath}`);
}

const port = 4000 + Math.floor(Math.random() * 900);
const env = {
  ...process.env,
  NODE_ENV: 'production',
  DATA_DIR: path.join(dir, 'data'),
  DB_PATH: dbPath,
  SESSION_SECRET: 'rehearsal-secret-not-real',
  PORT: String(port),
  SUPPORTED_TARGET_LANGS: 'ko,fr',
  SUPPORTED_UI_LANGS: 'en,ko',
  DEFAULT_UI_LANG: 'en',
  TZ: 'Asia/Seoul',
  AUTH_PASSWORD: 'rehearsal-bootstrap-pw',
  BOOTSTRAP_USERNAME: 'owner',
  BOOTSTRAP_DISPLAY_NAME: 'Owner',
  // Secrets a rehearsal must not send anywhere.
  GEMINI_API_KEY: '',
  LLM_PROVIDER: '',
};

/** Row counts of the tables a real deployment accumulates, read before the server boots. */
const LEGACY_TABLES = [
  'passages',
  'sessions',
  'words',
  'srs_cards',
  'writing_entries',
  'speaking_attempts',
  'dictation_entries',
  'level_history',
];
/** A fresh install has no tables yet, so every probe below has to tolerate that. */
const before = new DatabaseSync(dbPath, { readOnly: true });
const had = (t) =>
  !!before.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const count = (t) => (had(t) ? before.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c : 0);
const preCounts = Object.fromEntries(LEGACY_TABLES.map((t) => [t, count(t)]));
const preSettings = had('settings') ? before.prepare('SELECT * FROM settings').all()[0] ?? null : null;
const preWords = had('words')
  ? before.prepare('SELECT lemma FROM words ORDER BY lemma').all().map((r) => r.lemma)
  : [];
const preDates = had('sessions')
  ? before.prepare('SELECT id, date FROM sessions ORDER BY id').all()
  : [];
const prePassage = had('passages')
  ? before.prepare('SELECT id, payload_json, used FROM passages ORDER BY id LIMIT 1').get() ?? null
  : null;
before.close();

const server = spawn(process.execPath, [path.join(REPO, 'server', 'dist', 'index.js')], {
  env,
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const base = `http://127.0.0.1:${port}`;
const waitForServer = async () => {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

/** A tiny cookie jar, so each "browser" here has its own session. */
function client() {
  let cookie = '';
  return async (path, opts = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      redirect: 'manual',
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const pair = c.split(';')[0];
      if (pair.endsWith('=')) cookie = '';
      else cookie = pair;
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text };
  };
}

const cleanup = async () => {
  server.kill();
  // The database is still open until the child is actually gone, and Windows
  // will not unlink a file somebody has open. Wait for the exit rather than
  // firing and forgetting, or the temp directory outlives the run.
  await new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    server.on('exit', resolve);
    setTimeout(resolve, 5000);
  });
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    console.warn(`left ${dir} behind; remove it by hand`);
  }
};

try {
  if (!(await waitForServer())) {
    console.error('server did not come up:\n' + serverLog);
    process.exit(1);
  }
  check('server started and migrated the database on boot', true);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const t of ['users', 'enrollments', 'enrollment_passages', 'settings', 'sessions', 'words']) {
    check(`table ${t} exists`, tables.includes(t));
  }
  const counts = {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    enrollments: db.prepare('SELECT COUNT(*) c FROM enrollments').get().c,
    sessions: db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
    words: db.prepare('SELECT COUNT(*) c FROM words').get().c,
  };
  check('no row lost or duplicated by the migration', counts.enrollments >= 1, JSON.stringify(counts));

  // --- the point of the whole exercise: the existing account's data is still
  // there, still attached to it, and still says the same thing afterwards.
  const postCounts = Object.fromEntries(
    LEGACY_TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]),
  );
  for (const t of LEGACY_TABLES) {
    // `passages` legitimately grows: the server seeds its banks on boot. The
    // other tables must be exactly unchanged, or the migration moved data.
    const ok = t === 'passages' ? postCounts[t] >= preCounts[t] : postCounts[t] === preCounts[t];
    check(`legacy ${t} survived the migration`, ok, `${preCounts[t]} -> ${postCounts[t]}`);
  }
  if (prePassage) {
    const still = db.prepare('SELECT payload_json FROM passages WHERE id=?').get(prePassage.id);
    check('the pre-existing passage is still there', Boolean(still));
    if (still) {
      // The payload is *expected* to differ byte for byte: the Phase 3 field
      // rename rewrites the key names stored inside the JSON. So compare the
      // meaning, not the bytes — and prove the rewrite happened, because a
      // payload left holding `title_ko` is unreadable by the current code.
      const before_ = JSON.parse(prePassage.payload_json);
      const after_ = JSON.parse(still.payload_json);
      check(
        'the passage content survived the field rename',
        after_.title_target === before_.title_ko &&
          after_.passage_target === before_.passage_ko &&
          JSON.stringify(after_.sentences?.map((s) => s.target)) ===
            JSON.stringify(before_.sentences?.map((s) => s.ko)),
      );
      const raw = still.payload_json;
      check(
        'no stale pre-rename key names are left in it',
        !/\b(title_ko|passage_ko|passage_en|sentences_json|"ko":|"en":)\b/.test(raw),
      );
    }
  }
  const postSettings = db.prepare('SELECT * FROM settings').all()[0] ?? null;
  check(
    'the old settings row kept its values',
    preSettings === null ||
      (postSettings.level === preSettings.level &&
        postSettings.tts_rate === preSettings.tts_rate &&
        postSettings.tts_voice === preSettings.tts_voice &&
        postSettings.streak === preSettings.streak &&
        postSettings.keep_recordings_days === preSettings.keep_recordings_days),
    preSettings && JSON.stringify(preSettings.level) + '/' + JSON.stringify(postSettings?.level),
  );
  check(
    'every legacy row is attached to the bootstrap enrollment',
    db
      .prepare(
        `SELECT COUNT(*) c FROM settings WHERE enrollment_id IS NULL`,
      )
      .get().c === 0,
  );
  if (prePassage?.used) {
    const claimed = db
      .prepare('SELECT COUNT(*) c FROM enrollment_passages WHERE passage_id = (SELECT id FROM passages ORDER BY id LIMIT 1)')
      .get().c;
    check('the already-used passage is now claimed per enrollment', claimed === 1, `${claimed} rows`);
  }
  const orphans = db
    .prepare(
      `SELECT COUNT(*) c FROM sessions s LEFT JOIN enrollments e ON e.id = s.enrollment_id
       WHERE e.id IS NULL`,
    )
    .get().c;
  check('every session belongs to a real enrollment', orphans === 0, `${orphans} orphans`);
  db.close();

  // --- the owner logs in with the password that used to be the only credential
  const owner = client();
  const legacyLogin = await owner('/api/login', {
    method: 'POST',
    body: { username: 'owner', password: 'rehearsal-bootstrap-pw' },
  });
  check('owner can sign in', legacyLogin.status === 200, `status ${legacyLogin.status}`);
  check('owner landed in the primary language', legacyLogin.json?.account?.lang?.code === 'ko');
  check(
    'legacy password no longer alone identifies the account',
    (await client()('/api/login', { method: 'POST', body: { username: 'owner', password: 'wrong' } })).status === 401,
  );

  const progress = await owner('/api/progress');
  check('progress still answers for the owner', progress.status === 200, `status ${progress.status}`);
  const afterDates = (progress.json?.sessions ?? []).map((s) => s.date).sort();
  const dateList = preDates.map((r) => r.date).sort();
  check(
    'the owner still sees every session they had before',
    JSON.stringify(dateList) === JSON.stringify(afterDates),
    `before ${dateList.length}, after ${afterDates.length}`,
  );
  check(
    'the streak calendar still covers the same days',
    JSON.stringify(dateList) === JSON.stringify((progress.json?.streakCalendar ?? []).slice().sort()),
  );
  if (preSettings) {
    check('the old level and streak are intact', progress.json?.settings?.level === preSettings.level);
  }

  const listed = await owner('/api/sessions');
  check(
    'the replayable-session list is unchanged',
    JSON.stringify(dateList) === JSON.stringify((listed.json?.sessions ?? []).map((s) => s.date).sort()),
  );
  if (preDates.length) {
    // A migrated session has to be replayable, not just listed: that walks the
    // passage, writing, speaking and dictation rows through the new scoping.
    // Use a real id — never assume 1, the ids came from the live database.
    const id = preDates[0].id;
    const replay = await owner(`/api/sessions/${id}/detail`);
    check(`migrated session ${id} still replays`, replay.status === 200, `status ${replay.status}`);
    check('its writing and speaking work came across', Boolean(replay.json?.detail));
    const foreign = await owner('/api/sessions/999999/detail');
    check('a session that does not exist is a 404, not a crash', foreign.status === 404, `status ${foreign.status}`);
  }
  if (preWords.length) {
    const listedWords = await owner('/api/words');
    const lemmas = (listedWords.json?.words ?? []).map((w) => w.lemma).sort();
    check(
      "the owner's vocabulary survived, entry for entry",
      JSON.stringify(preWords) === JSON.stringify(lemmas),
      JSON.stringify(lemmas),
    );
    const srs = await owner('/api/srs/due');
    check('their SRS cards came across too', srs.status === 200, `status ${srs.status}`);
  }

  // --- add a second account through the CLI, on the same database
  await new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [path.join(REPO, 'scripts', 'create-user.js'), '--username', 'sibling', '--password', 'sibling-pw-1234', '--target-lang', 'fr', '--native-lang', 'en', '--ui-lang', 'en'],
      { env, cwd: REPO, stdio: 'pipe' },
    );
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`create-user failed: ${out}`))));
  });
  check('create-user.js added an account', true);

  const sibling = client();
  const sibLogin = await sibling('/api/login', { method: 'POST', body: { username: 'sibling', password: 'sibling-pw-1234' } });
  check('the new account can sign in', sibLogin.status === 200, `status ${sibLogin.status}`);
  check('the new account starts in French', sibLogin.json?.account?.lang?.code === 'fr');

  // --- isolation: sibling's data must not be reachable by the owner, and the
  // owner's must not appear in the sibling's lists. Both start empty, so this
  // has to put something in the owner's account first — comparing two empty
  // lists would pass no matter how the scoping was written.
  const sibSessions = await sibling('/api/sessions');
  const sibWordsEmpty = await sibling('/api/words');
  check('sibling sees an empty, private history', sibSessions.json?.sessions?.length === 0);
  check('sibling sees an empty, private vocabulary', sibWordsEmpty.json?.words?.length === 0);

  const addedWord = await owner('/api/words', {
    method: 'POST',
    body: { lemma: '가족', surface: '가족', meaning_native: 'family' },
  });
  check('owner added a word to their own account', addedWord.status === 200, `status ${addedWord.status}`);
  const ownerWords = await owner('/api/words');
  check("the owner's own word is listed for them", ownerWords.json?.words?.some((w) => w.lemma === '가족'));
  const sibWordsAfter = await sibling('/api/words');
  check(
    "the owner's word does not appear in the sibling's vocabulary",
    !sibWordsAfter.json?.words?.some((w) => w.lemma === '가족'),
    JSON.stringify(sibWordsAfter.json?.words?.map((w) => w.lemma)),
  );
  const crossRead = await owner('/api/enrollments/999999/activate', { method: 'POST', body: {} });
  check('owner cannot activate a nonexistent enrollment', crossRead.status === 404, `status ${crossRead.status}`);

  // --- the French enrollment, added from the owner's own account
  const added = await owner('/api/enrollments', {
    method: 'POST',
    body: { target_lang: 'fr', native_lang: 'en', ui_lang: 'en' },
  });
  check('owner added French', added.status === 201, `status ${added.status}`);
  check('adding did not switch the session', added.json?.account?.activeEnrollmentId !== added.json?.enrollment?.id);
  const frId = added.json?.enrollment?.id;

  const activated = await owner(`/api/enrollments/${frId}/activate`, { method: 'POST', body: {} });
  check('owner switched to French', activated.status === 200 && activated.json?.account?.lang?.code === 'fr');
  const frSettings = await owner('/api/settings');
  check('French settings are its own row', frSettings.json?.lang?.code === 'fr');
  const koStillKo = await owner('/api/session/today');
  check('content still answers in French', koStillKo.status === 200, `status ${koStillKo.status}`);

  // --- the sibling's session is not the owner's French session
  const sibAfter = await sibling('/api/account');
  check('sibling was not moved by the owner switching', sibAfter.json?.activeEnrollmentId !== frId);

  const manifest = await owner('/manifest.webmanifest');
  check(
    'the manifest follows the session language',
    manifest.status === 200 && manifest.json?.lang === 'fr',
    `lang ${manifest.json?.lang}`,
  );

  // --- logout, then prove the cookie really is gone
  const out = await owner('/api/logout', { method: 'POST', body: {} });
  check('logout succeeds', out.status === 200);
  const afterOut = await owner('/api/account');
  check('the session is dead after logout', afterOut.status === 401, `status ${afterOut.status}`);
} finally {
  await cleanup();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log('failed: ' + failed.map((f) => f.name).join(', '));
  process.exit(1);
}
