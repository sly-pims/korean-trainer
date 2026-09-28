import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, type OpenDbOptions } from '../src/db.js';
import { hashPassword, verifyPassword } from '../src/auth.js';

/**
 * The single-user -> multi-account migration.
 *
 * The risk being managed here is not "does the new schema work" — that is
 * covered everywhere else. It is "does an existing database come out the other
 * side with the same person's history intact", because a silent partial
 * migration is the failure that costs the most: the app boots, looks healthy,
 * and somebody's year of vocabulary is gone.
 *
 * So every test here builds a *legacy* database with rows in it, migrates it,
 * and then checks the data rather than the schema.
 */

const LEGACY_PACK = {
  level: 1,
  topic: 'family',
  title_ko: '가족',
  passage_ko: '가족이 네 명이에요.',
  passage_en: 'My family has four people.',
  sentences: [{ ko: '가족이 네 명이에요.', en: 'My family has four people.' }],
  glossary: [{ surface: '가족', lemma: '가족', pos: 'noun', meaning_en: 'family' }],
  questions: [
    {
      q_ko: '가족이 몇 명이에요?',
      q_en: 'How many people?',
      choices: ['네 명', '두 명'],
      answer_index: 0,
      explanation_en: 'The passage says four.',
    },
  ],
  writing_prompt: { ko: '가족을 소개하세요.', en: 'Introduce your family.', target_grammar: '이에요' },
  speaking_prompt: { ko: '가족은 몇 명이에요?', en: 'How many people are in your family?' },
};

const OPTS: OpenDbOptions = {
  defaultVoice: 'ko-KR-SunHiNeural',
  bootstrapUser: { username: 'default', password: 'korean', displayName: 'Learner' },
  bootstrapEnrollment: { targetLang: 'ko', nativeLang: 'en', uiLang: 'en' },
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enroll-migration-'));
  file = path.join(dir, 'legacy.db');
});

afterEach(() => {
  // Windows refuses to delete a directory with an open handle, and a failed
  // assertion can leave one open. Cleanup must never mask the real error.
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* leave it to the OS */
  }
});

/**
 * A database as the last single-user build left it: `settings.id = 1`,
 * `sessions UNIQUE(date)`, `words UNIQUE(lemma)`, and no accounts at all.
 */
function buildLegacyDb(): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE settings (
      id                   INTEGER PRIMARY KEY CHECK (id = 1),
      level                INTEGER NOT NULL DEFAULT 1,
      tts_rate             REAL NOT NULL DEFAULT 1.0,
      tts_voice            TEXT,
      show_romanization    INTEGER NOT NULL DEFAULT 0,
      keep_recordings_days INTEGER NOT NULL DEFAULT 14,
      streak               INTEGER NOT NULL DEFAULT 0,
      last_session_date    TEXT,
      timezone             TEXT,
      created_at           TEXT
    );
    CREATE TABLE passages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      level         INTEGER NOT NULL,
      topic         TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      source        TEXT NOT NULL,
      used          INTEGER NOT NULL DEFAULT 0,
      intended_date TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      date          TEXT NOT NULL UNIQUE,
      passage_id    INTEGER,
      status        TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','done')),
      current_step  TEXT NOT NULL DEFAULT 'warmup',
      read_score    INTEGER, write_score INTEGER, listen_score INTEGER,
      speak_score   INTEGER, vocab_score INTEGER, duration_s INTEGER
    );
    CREATE TABLE words (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      lemma             TEXT NOT NULL UNIQUE,
      surface_example   TEXT NOT NULL,
      meaning_en        TEXT NOT NULL,
      pos               TEXT NOT NULL,
      level             INTEGER NOT NULL,
      first_seen_at     TEXT NOT NULL,
      source_passage_id INTEGER,
      source            TEXT NOT NULL DEFAULT 'reading',
      example_ko        TEXT,
      example_en        TEXT
    );
    CREATE TABLE srs_cards (
      word_id       INTEGER PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
      ease          REAL NOT NULL DEFAULT 2.5,
      interval_days INTEGER NOT NULL DEFAULT 0,
      due_date      TEXT NOT NULL,
      reps          INTEGER NOT NULL DEFAULT 0,
      lapses        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE writing_entries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   INTEGER,
      prompt_json  TEXT NOT NULL,
      user_text    TEXT NOT NULL,
      feedback_json TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE speaking_attempts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    INTEGER,
      mode          TEXT NOT NULL,
      prompt_json   TEXT NOT NULL,
      audio_path    TEXT,
      transcript    TEXT,
      feedback_json TEXT,
      score         REAL,
      created_at    TEXT NOT NULL
    );
    CREATE TABLE dictation_entries (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id     INTEGER,
      sentence_index INTEGER NOT NULL,
      target_ko      TEXT NOT NULL,
      typed_text     TEXT NOT NULL,
      score          REAL,
      created_at     TEXT NOT NULL
    );
    CREATE TABLE level_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      change_date TEXT NOT NULL,
      from_level  INTEGER NOT NULL,
      to_level    INTEGER NOT NULL,
      reason      TEXT
    );
  `);

  db.prepare(
    'INSERT INTO settings (id, level, tts_rate, tts_voice, show_romanization, keep_recordings_days, streak, last_session_date, timezone, created_at) VALUES (1,3,0.9,?,1,30,7,?,?,?)',
  ).run('ko-KR-SunHiNeural', '2026-02-01', 'Asia/Seoul', '2025-06-01');
  db.prepare('INSERT INTO passages (level,topic,payload_json,source,used,intended_date,created_at) VALUES (?,?,?,?,?,?,?)').run(
    1,
    'family',
    JSON.stringify(LEGACY_PACK),
    'seed',
    1,
    null,
    '2026-01-01',
  );
  db.prepare('INSERT INTO passages (level,topic,payload_json,source,used,intended_date,created_at) VALUES (?,?,?,?,?,?,?)').run(
    1,
    'tomorrow',
    JSON.stringify(LEGACY_PACK),
    'llm',
    0,
    '2026-02-02',
    '2026-02-01',
  );
  db.prepare(
    'INSERT INTO sessions (id,date,passage_id,status,current_step,read_score,write_score,listen_score,speak_score,vocab_score,duration_s) VALUES (1,?,1,?,?,80,70,90,60,5,600)',
  ).run('2026-02-01', 'done', 'complete');
  db.prepare(
    'INSERT INTO words (lemma,surface_example,meaning_en,pos,level,first_seen_at,source,example_ko,example_en) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('가족', '가족', 'family', 'noun', 1, '2026-02-01', 'reading', '가족이 있어요.', 'I have a family.');
  db.prepare('INSERT INTO srs_cards (word_id,ease,interval_days,due_date,reps,lapses) VALUES (1,2.6,3,?,4,1)').run(
    '2026-02-04',
  );
  db.prepare(
    'INSERT INTO writing_entries (session_id,prompt_json,user_text,feedback_json,created_at) VALUES (1,?,?,?,?)',
  ).run(
    JSON.stringify({ ko: '가족을 소개하세요.', en: 'Introduce your family.', level: 1 }),
    '저는 가족을 소개합니다.',
    JSON.stringify({ corrected_ko: '저는 가족을 소개합니다', score: 4, issues: [] }),
    '2026-02-01',
  );
  db.prepare(
    'INSERT INTO speaking_attempts (session_id,mode,prompt_json,audio_path,transcript,feedback_json,score,created_at) VALUES (1,?,?,?,?,?,?,?)',
  ).run(
    'free_speech',
    JSON.stringify({ ko: '가족은 몇 명이에요?', en: 'How many people are in your family?', level: 1 }),
    '/tmp/a.webm',
    '가족은 네 명이에요',
    JSON.stringify({ transcript_ko: '가족은 네 명이에요', score: 4, issues: [] }),
    4,
    '2026-02-01',
  );
  db.prepare(
    'INSERT INTO dictation_entries (session_id,sentence_index,target_ko,typed_text,score,created_at) VALUES (1,0,?,?,?,?)',
  ).run('가족이 네 명이에요.', '가족이 네 명이에요.', 100, '2026-02-01');
  db.prepare('INSERT INTO level_history (change_date,from_level,to_level,reason) VALUES (?,?,?,?)').run(
    '2026-01-15',
    2,
    3,
    'score >= 80',
  );
  return db;
}

const columns = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe('a legacy single-user database', () => {
  it('migrates without losing a single row', () => {
    const legacy = buildLegacyDb();
    const before = {
      passages: (legacy.prepare('SELECT COUNT(*) c FROM passages').get() as { c: number }).c,
      sessions: (legacy.prepare('SELECT COUNT(*) c FROM sessions').get() as { c: number }).c,
      words: (legacy.prepare('SELECT COUNT(*) c FROM words').get() as { c: number }).c,
      writing_entries: (legacy.prepare('SELECT COUNT(*) c FROM writing_entries').get() as { c: number }).c,
      speaking_attempts: (legacy.prepare('SELECT COUNT(*) c FROM speaking_attempts').get() as { c: number }).c,
      dictation_entries: (legacy.prepare('SELECT COUNT(*) c FROM dictation_entries').get() as { c: number }).c,
      level_history: (legacy.prepare('SELECT COUNT(*) c FROM level_history').get() as { c: number }).c,
      srs_cards: (legacy.prepare('SELECT COUNT(*) c FROM srs_cards').get() as { c: number }).c,
    };
    legacy.close();

    const db = openDb(file, OPTS);
    for (const [table, count] of Object.entries(before)) {
      const after = (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
      expect(after, table).toBe(count);
    }
    db.close();
  });

  it('preserves the person’s settings, streak, level and timezone', () => {
    buildLegacyDb().close();
    const db = openDb(file, OPTS);
    const s = db.prepare('SELECT * FROM settings').get() as Record<string, unknown>;
    expect(Number(s.level)).toBe(3);
    expect(Number(s.streak)).toBe(7);
    expect(s.last_session_date).toBe('2026-02-01');
    expect(s.timezone).toBe('Asia/Seoul');
    expect(Number(s.tts_rate)).toBeCloseTo(0.9);
    expect(Number(s.keep_recordings_days)).toBe(30);
    expect(s.tts_voice).toBe('ko-KR-SunHiNeural');
    db.close();
  });

  it('keeps the completed session and its scores, now keyed by enrollment', () => {
    buildLegacyDb().close();
    const db = openDb(file, OPTS);
    const enrollmentId = (db.prepare('SELECT id FROM enrollments LIMIT 1').get() as { id: number }).id;
    const s = db.prepare('SELECT * FROM sessions WHERE id=1').get() as Record<string, unknown>;
    expect(s.enrollment_id).toBe(enrollmentId);
    expect(s.status).toBe('done');
    expect(Number(s.read_score)).toBe(80);
    expect(Number(s.duration_s)).toBe(600);
    db.close();
  });

  it('keeps words and their SRS schedules together', () => {
    buildLegacyDb().close();
    const db = openDb(file, OPTS);
    const enrollmentId = (db.prepare('SELECT id FROM enrollments LIMIT 1').get() as { id: number }).id;
    const w = db.prepare('SELECT * FROM words').get() as Record<string, unknown>;
    expect(w.enrollment_id).toBe(enrollmentId);
    expect(w.meaning_native).toBe('family');
    expect(w.example_target).toBe('가족이 있어요.');
    expect(w.example_native).toBe('I have a family.');
    const card = db.prepare('SELECT * FROM srs_cards WHERE word_id=?').get(w.id) as Record<string, unknown>;
    expect(Number(card.ease)).toBeCloseTo(2.6);
    expect(Number(card.reps)).toBe(4);
    expect(card.due_date).toBe('2026-02-04');
    db.close();
  });

  it('keeps the passage that was already consumed consumed, and tomorrow’s waiting', () => {
    // The migration has to reproduce the person's position in the rotation, not
    // just the rows: handing back an already-used passage would put them on day
    // one again, and dropping the intended_date would make them start a second
    // one tomorrow.
    buildLegacyDb().close();
    const db = openDb(file, OPTS);
    const enrollmentId = (db.prepare('SELECT id FROM enrollments LIMIT 1').get() as { id: number }).id;
    const rows = db
      .prepare('SELECT p.topic, ep.used_at, ep.intended_date FROM enrollment_passages ep JOIN passages p ON p.id=ep.passage_id WHERE ep.enrollment_id=?')
      .all(enrollmentId) as Array<{ topic: string; used_at: string | null; intended_date: string | null }>;
    const used = rows.find((r) => r.topic === 'family');
    const waiting = rows.find((r) => r.topic === 'tomorrow');
    expect(used?.used_at).toBeTruthy();
    expect(used?.intended_date).toBeNull();
    expect(waiting?.used_at).toBeNull();
    expect(waiting?.intended_date).toBe('2026-02-02');
    db.close();
  });

  it('rewrites the old field names inside the stored JSON', () => {
    buildLegacyDb().close();
    const db = openDb(file, OPTS);
    const pack = JSON.parse(
      (db.prepare('SELECT payload_json FROM passages WHERE topic=?').get('family') as { payload_json: string })
        .payload_json,
    ) as Record<string, unknown>;
    expect(pack.title_target).toBe('가족');
    expect(pack.passage_target).toBe('가족이 네 명이에요.');
    expect(pack.passage_native).toBe('My family has four people.');
    expect(pack).not.toHaveProperty('title_ko');

    const writing = JSON.parse(
      (db.prepare('SELECT prompt_json FROM writing_entries').get() as { prompt_json: string }).prompt_json,
    ) as Record<string, unknown>;
    // A `{ko,en}` pair is renamed to `{target,native}`; it is a language pair,
    // not a pair of words called "ko" and "en".
    expect(writing).toEqual({ target: '가족을 소개하세요.', native: 'Introduce your family.', level: 1 });
    db.close();
  });

  it('re-keys every child row onto the new account', () => {
    buildLegacyDb().close();
    const db = openDb(file, OPTS);
    const enrollmentId = (db.prepare('SELECT id FROM enrollments LIMIT 1').get() as { id: number }).id;
    for (const t of ['writing_entries', 'speaking_attempts', 'dictation_entries', 'level_history']) {
      const orphans = (
        db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE enrollment_id IS NULL`).get() as { c: number }
      ).c;
      expect(orphans, t).toBe(0);
    }
    expect((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length).toBe(0);
    expect(enrollmentId).toBeGreaterThan(0);
    db.close();
  });

  it('creates the first account from AUTH_PASSWORD and leaves it alone after', () => {
    buildLegacyDb().close();
    const db = openDb(file, OPTS);
    const user = db.prepare('SELECT * FROM users').get() as Record<string, unknown>;
    expect(user.username).toBe('default');
    expect(user.display_name).toBe('Learner');
    expect(Number(user.is_bootstrap)).toBe(1);
    expect(verifyPassword('korean', user.password_hash as string)).toBe(true);
    expect((user.password_hash as string).startsWith('scrypt$')).toBe(true);

    // A second boot with a different AUTH_PASSWORD must not reset it: the env
    // var is read once, and quietly changing someone's password on redeploy
    // would be the worst possible time to discover it.
    const changed = { ...OPTS, bootstrapUser: { ...OPTS.bootstrapUser, password: 'something-else' } };
    const again = openDb(file, changed);
    const same = again.prepare('SELECT password_hash FROM users WHERE id=1').get() as { password_hash: string };
    expect(same.password_hash).toBe(user.password_hash);
    expect(verifyPassword('korean', same.password_hash)).toBe(true);
    expect(verifyPassword('something-else', same.password_hash)).toBe(false);
    again.close();
    db.close();
  });
});

describe('migrating twice', () => {
  it('is a no-op the second time', () => {
    buildLegacyDb().close();
    const first = openDb(file, OPTS);
    const snapshot = {
      users: (first.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c,
      enrollments: (first.prepare('SELECT COUNT(*) c FROM enrollments').get() as { c: number }).c,
      enrollment_passages: (first.prepare('SELECT COUNT(*) c FROM enrollment_passages').get() as { c: number }).c,
      words: (first.prepare('SELECT COUNT(*) c FROM words').get() as { c: number }).c,
      sessions: (first.prepare('SELECT COUNT(*) c FROM sessions').get() as { c: number }).c,
    };
    const settingsBefore = first.prepare('SELECT * FROM settings').get();
    first.close();

    const second = openDb(file, OPTS);
    for (const [table, count] of Object.entries(snapshot)) {
      expect((second.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c, table).toBe(count);
    }
    expect(second.prepare('SELECT * FROM settings').get()).toEqual(settingsBefore);
    second.close();
  });

  it('does not re-run the JSON rename on already-renamed payloads', () => {
    buildLegacyDb().close();
    const first = openDb(file, OPTS);
    const once = (first.prepare('SELECT payload_json FROM passages WHERE topic=?').get('family') as {
      payload_json: string;
    }).payload_json;
    first.close();
    const second = openDb(file, OPTS);
    const twice = (second.prepare('SELECT payload_json FROM passages WHERE topic=?').get('family') as {
      payload_json: string;
    }).payload_json;
    expect(twice).toBe(once);
    second.close();
  });
});

describe('a fresh database', () => {
  it('gets exactly one account, one enrollment and one settings row', () => {
    const fresh = path.join(dir, 'fresh.db');
    const db = openDb(fresh, OPTS);
    expect((db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM enrollments').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM settings').get() as { c: number }).c).toBe(1);
    const e = db.prepare('SELECT * FROM enrollments').get() as Record<string, unknown>;
    expect(e.target_lang).toBe('ko');
    expect(e.native_lang).toBe('en');
    expect(e.ui_lang).toBe('en');
    db.close();
  });

  it('keys settings by enrollment, not by a magic id', () => {
    const fresh = path.join(dir, 'fresh2.db');
    const db = openDb(fresh, OPTS);
    expect(columns(db, 'settings')).toContain('enrollment_id');
    expect(columns(db, 'settings')).not.toContain('id');
    db.close();
  });

  it('lets two accounts hold the same word and the same day', () => {
    // The uniqueness that stops two people sharing a database is the whole
    // reason `words` and `sessions` were rebuilt: `UNIQUE(lemma)` and
    // `UNIQUE(date)` are what made a second account impossible.
    const fresh = path.join(dir, 'two.db');
    const db = openDb(fresh, OPTS);
    db.prepare(
      'INSERT INTO users (username,password_hash,display_name,is_bootstrap,created_at) VALUES (?,?,?,0,?)',
    ).run('second', hashPassword('pw'), 'Second', new Date().toISOString());
    db.prepare('INSERT INTO enrollments (user_id,target_lang,native_lang,ui_lang,created_at) VALUES (2,?,?,?,?)').run(
      'fr',
      'en',
      'en',
      new Date().toISOString(),
    );
    const first = (db.prepare('SELECT id FROM enrollments WHERE user_id=1').get() as { id: number }).id;
    const second = (db.prepare('SELECT id FROM enrollments WHERE user_id=2').get() as { id: number }).id;

    const insertWord = db.prepare(
      "INSERT INTO words (enrollment_id,lemma,surface_example,meaning_native,pos,level,first_seen_at,source) VALUES (?,?,?,?,'noun',1,'2026-01-01','reading')",
    );
    insertWord.run(first, 'café', 'café', 'coffee');
    insertWord.run(second, 'café', 'café', 'coffee');
    expect((db.prepare('SELECT COUNT(*) c FROM words').get() as { c: number }).c).toBe(2);

    db.prepare('INSERT INTO sessions (enrollment_id,date,passage_id,status) VALUES (?,?,NULL,?)').run(
      first,
      '2026-01-01',
      'in_progress',
    );
    db.prepare('INSERT INTO sessions (enrollment_id,date,passage_id,status) VALUES (?,?,NULL,?)').run(
      second,
      '2026-01-01',
      'in_progress',
    );
    expect((db.prepare('SELECT COUNT(*) c FROM sessions').get() as { c: number }).c).toBe(2);
    db.close();
  });
});

describe('an interrupted migration', () => {
  it('is repaired rather than skipped', () => {
    // A build that died between creating `users` and creating `enrollments`
    // leaves a database that the old all-or-nothing step 1 could never finish.
    const half = new DatabaseSync(file);
    half.exec(`
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        is_bootstrap  INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL
      );
    `);
    half.close();

    const db = openDb(file, OPTS);
    for (const t of ['users', 'enrollments', 'enrollment_passages', 'llm_usage_by_user']) {
      expect(tablesOf(db).has(t), t).toBe(true);
    }
    expect((db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c).toBe(1);
    db.close();
  });
});

function tablesOf(db: DatabaseSync): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
  );
}
