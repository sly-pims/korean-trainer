import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './auth.js';

/**
 * The schema a *fresh* database gets.
 *
 * Every table that holds learning progress is keyed by `enrollment_id`, which
 * is one row of `enrollments` — one (person, target language) pair. That is the
 * whole point of this revision: a single database now serves several people
 * learning different languages, so a query with no `enrollment_id` in it is a
 * bug, not a simplification.
 *
 * Migrations run BEFORE this, so anything an older database is missing is added
 * by `migrate()` first. Every statement is `IF NOT EXISTS`, which means for a
 * fresh database this block is the only thing that creates anything.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  is_bootstrap  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_lang TEXT NOT NULL,
  native_lang TEXT NOT NULL,
  ui_lang     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, target_lang, native_lang)
);

CREATE TABLE IF NOT EXISTS settings (
  enrollment_id         INTEGER PRIMARY KEY REFERENCES enrollments(id) ON DELETE CASCADE,
  level                 INTEGER NOT NULL DEFAULT 1,
  tts_rate              REAL NOT NULL DEFAULT 1.0,
  tts_voice             TEXT,
  show_romanization     INTEGER NOT NULL DEFAULT 0,
  keep_recordings_days  INTEGER NOT NULL DEFAULT 14,
  streak                INTEGER NOT NULL DEFAULT 0,
  last_session_date     TEXT,
  timezone              TEXT,
  created_at            TEXT
);

CREATE TABLE IF NOT EXISTS passages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_lang   TEXT NOT NULL,
  level         INTEGER NOT NULL,
  topic         TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('llm','seed')),
  used          INTEGER NOT NULL DEFAULT 0,
  intended_date TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollment_passages (
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  passage_id    INTEGER NOT NULL REFERENCES passages(id)    ON DELETE CASCADE,
  intended_date TEXT,
  used_at       TEXT,
  PRIMARY KEY (enrollment_id, passage_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  passage_id   INTEGER,
  status       TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','done')),
  current_step TEXT NOT NULL DEFAULT 'warmup',
  read_score INTEGER, write_score INTEGER, listen_score INTEGER,
  speak_score INTEGER, vocab_score INTEGER, duration_s INTEGER,
  read_answers_json TEXT,
  UNIQUE (enrollment_id, date),
  FOREIGN KEY (passage_id) REFERENCES passages(id)
);

CREATE TABLE IF NOT EXISTS words (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id     INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  lemma             TEXT NOT NULL,
  surface_example   TEXT NOT NULL,
  meaning_native    TEXT NOT NULL,
  pos               TEXT NOT NULL,
  level             INTEGER NOT NULL,
  first_seen_at     TEXT NOT NULL,
  source_passage_id INTEGER,
  source            TEXT NOT NULL DEFAULT 'reading'
                      CHECK (source IN ('reading','manual','suggested')),
  example_target    TEXT,
  example_native    TEXT,
  UNIQUE (enrollment_id, lemma),
  FOREIGN KEY (source_passage_id) REFERENCES passages(id)
);

CREATE TABLE IF NOT EXISTS srs_cards (
  word_id INTEGER PRIMARY KEY,
  ease REAL NOT NULL DEFAULT 2.5,
  interval_days INTEGER NOT NULL DEFAULT 0,
  due_date TEXT NOT NULL,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (word_id) REFERENCES words(id)
);

CREATE TABLE IF NOT EXISTS writing_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  session_id   INTEGER,
  prompt_json  TEXT NOT NULL,
  user_text    TEXT NOT NULL,
  feedback_json TEXT,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS speaking_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  session_id   INTEGER,
  mode TEXT NOT NULL CHECK (mode IN ('read_aloud','free_speech')),
  prompt_json TEXT NOT NULL,
  audio_path TEXT,
  transcript TEXT,
  feedback_json TEXT,
  score INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS dictation_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  session_id   INTEGER,
  sentence_index INTEGER NOT NULL,
  target_text  TEXT NOT NULL,
  typed_text   TEXT NOT NULL,
  score        INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS llm_usage (
  date TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS llm_usage_by_user (
  date    TEXT    NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calls   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, user_id)
);

CREATE TABLE IF NOT EXISTS level_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  change_date  TEXT NOT NULL,
  from_level   INTEGER NOT NULL,
  to_level     INTEGER NOT NULL,
  reason       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_passages_lang ON passages(target_lang, source);
CREATE INDEX IF NOT EXISTS idx_enrollment_passages_avail
  ON enrollment_passages(enrollment_id, intended_date, used_at);
CREATE INDEX IF NOT EXISTS idx_words_enrollment_lemma ON words(enrollment_id, lemma);
CREATE INDEX IF NOT EXISTS idx_srs_due ON srs_cards(due_date);
CREATE INDEX IF NOT EXISTS idx_writing_feedback ON writing_entries(feedback_json);
CREATE INDEX IF NOT EXISTS idx_speaking_feedback ON speaking_attempts(feedback_json);
`;

/** The columns of a table, or [] when the table does not exist. */
function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function tablesOf(db: DatabaseSync): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (t) => t.name,
    ),
  );
}

function countOf(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

export interface BootstrapUser {
  username: string;
  password: string;
  displayName: string;
}

export interface BootstrapEnrollment {
  targetLang: string;
  nativeLang: string;
  uiLang: string;
}

export interface OpenDbOptions {
  /**
   * The target language's default TTS voice. Required rather than defaulted: a
   * default here would be a hardcoded voice in a module that has no way to know
   * the language, which is how a French deployment ends up speaking Korean.
   */
  defaultVoice: string;
  bootstrapUser: BootstrapUser;
  bootstrapEnrollment: BootstrapEnrollment;
}

/**
 * The field names are stored *inside* the JSON blobs too — a saved passage or a
 * saved prompt carries `passage_ko`, `meaning_en`, `{ko,en}` sentence pairs and
 * so on. Renaming the columns alone would leave every already-generated row
 * unreadable, so the payloads are rewritten in the same migration.
 */
const JSON_KEY_RENAMES: Record<string, string> = {
  title_ko: 'title_target',
  passage_ko: 'passage_target',
  passage_en: 'passage_native',
  q_ko: 'q_target',
  q_en: 'q_native',
  explanation_en: 'explanation_native',
  meaning_en: 'meaning_native',
  example_ko: 'example_target',
  example_en: 'example_native',
  corrected_ko: 'corrected_target',
  more_natural_ko: 'more_natural_target',
  transcript_ko: 'transcript_target',
  note_en: 'note_native',
  encouragement_en: 'encouragement_native',
  fluency_note_en: 'fluency_note_native',
};

/**
 * Rewrites one parsed JSON value. Bare `ko`/`en` keys are only renamed when the
 * same object carries both, which is the shape of a target/native pair; that
 * keeps unrelated data that happens to use those letters safe.
 */
function renameJsonKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(renameJsonKeys);
  if (node === null || typeof node !== 'object') return node;

  const src = node as Record<string, unknown>;
  const isPair = 'ko' in src && 'en' in src;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    const next = isPair && key === 'ko' ? 'target' : isPair && key === 'en' ? 'native' : (JSON_KEY_RENAMES[key] ?? key);
    out[next] = renameJsonKeys(value);
  }
  return out;
}

/**
 * Step 12: rewrite every stored payload that still uses the old field names.
 *
 * `read_aloud` attempts are skipped on purpose. Their prompt is already the
 * language-neutral `{ target }`, so there is nothing to rename, and excluding
 * them means a future field called `ko` inside a read-aloud payload can never be
 * mangled by this pass.
 */
function migrateJsonPayloads(db: DatabaseSync, tables: Set<string>): void {
  const targets: { table: string; column: string; where?: string; whereColumn?: string }[] = [
    { table: 'passages', column: 'payload_json' },
    { table: 'writing_entries', column: 'prompt_json' },
    { table: 'writing_entries', column: 'feedback_json' },
    { table: 'speaking_attempts', column: 'prompt_json', where: "mode <> 'read_aloud'", whereColumn: 'mode' },
    { table: 'speaking_attempts', column: 'feedback_json', where: "mode <> 'read_aloud'", whereColumn: 'mode' },
  ];
  for (const { table, column, where, whereColumn } of targets) {
    if (!tables.has(table)) continue;
    const cols = columnsOf(db, table);
    if (!cols.includes(column)) continue;
    // A `where` clause is only applied when the column it names is there. The
    // legacy fixture predates `mode`, and a predicate on a missing column is a
    // hard error that would abort the whole migration — including for the tables
    // that needed no rewriting at all.
    const filter = where && whereColumn && cols.includes(whereColumn) ? where : '';
    const rows = db
      .prepare(
        `SELECT id, ${column} AS body FROM ${table} WHERE ${column} IS NOT NULL${filter ? ` AND ${filter}` : ''}`,
      )
      .all() as { id: number; body: string }[];
    const update = db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`);
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.body);
      } catch {
        continue; // Not our JSON; leave it exactly as it is.
      }
      const next = JSON.stringify(renameJsonKeys(parsed));
      if (next !== row.body) update.run(next, row.id);
    }
  }
}

/**
 * SQLite's documented table-rebuild procedure: foreign keys off, one
 * transaction, copy, drop, rename, foreign keys back, then prove it worked.
 *
 * Used for the three tables whose *key* changed rather than gaining a column,
 * because `ALTER TABLE` cannot change a primary key, a uniqueness constraint,
 * or a `CHECK`.
 */
function rebuildTable(db: DatabaseSync, table: string, createSql: string, copySql: string): void {
  const tmp = `${table}_rebuild`;
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec('BEGIN;');
    db.exec(`DROP TABLE IF EXISTS ${tmp};`);
    db.exec(createSql.replace(/\bIF NOT EXISTS\b\s+/g, ''));
    db.exec(copySql);
    db.exec(`DROP TABLE ${table};`);
    db.exec(`ALTER TABLE ${tmp} RENAME TO ${table};`);
    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      /* the transaction was never opened */
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
  const broken = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
  if (broken.length) {
    throw new Error(
      `migration left ${broken.length} dangling reference(s) after rebuilding ${table}: ${JSON.stringify(broken.slice(0, 3))}`,
    );
  }
}

/**
 * Steps 1-14: bring a database created by any earlier build up to the current
 * schema.
 *
 * Runs BEFORE `SCHEMA_SQL`: `SCHEMA_SQL` creates indexes, and an index over a
 * column only this function adds would throw against a pre-existing table.
 *
 * Every step is self-detecting, so this is a no-op on a fresh database (where
 * `SCHEMA_SQL` does all the creating) and a no-op on a database that has already
 * been migrated. That is what makes `openDb` safe to call on every boot.
 */
function migrate(db: DatabaseSync, opts: OpenDbOptions): number {
  const { defaultVoice, bootstrapUser, bootstrapEnrollment } = opts;

  const tables = tablesOf(db);
  const cols = (t: string) => columnsOf(db, t);

  // ---- Step 1: the account tables, if an older build never created them ----
  // Each table is created independently rather than all-or-nothing, so a build
  // interrupted halfway through this step is repaired instead of skipped: the
  // old `if (!tables.has('users')) ... else ...` shape left a database with
  // `users` but no `enrollments` permanently unfixable, because every later boot
  // took the else branch.
  for (const sql of ACCOUNT_TABLES) {
    if (tablesOf(db).has(tableNameOf(sql))) continue;
    db.exec(sql);
  }

  // ---- Step 2: the first account, from AUTH_PASSWORD (D15) ----
  // Skipped when any user exists, which is what makes AUTH_PASSWORD inert from
  // the second boot onward.
  let userId: number;
  const existingUser = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as
    | { id: number }
    | undefined;
  if (existingUser) {
    userId = existingUser.id;
  } else {
    const res = db
      .prepare(
        'INSERT INTO users (username, password_hash, display_name, is_bootstrap, created_at) VALUES (?,?,?,1,?)',
      )
      .run(
        bootstrapUser.username,
        hashPassword(bootstrapUser.password),
        bootstrapUser.displayName,
        new Date().toISOString(),
      );
    userId = Number(res.lastInsertRowid);
  }

  // ---- Step 3: that account's first enrollment ----
  let enrollmentId: number;
  const existingEnrollment = db
    .prepare('SELECT id FROM enrollments WHERE user_id=? ORDER BY id LIMIT 1')
    .get(userId) as { id: number } | undefined;
  if (existingEnrollment) {
    enrollmentId = existingEnrollment.id;
  } else {
    const res = db
      .prepare(
        'INSERT INTO enrollments (user_id, target_lang, native_lang, ui_lang, created_at) VALUES (?,?,?,?,?)',
      )
      .run(
        userId,
        bootstrapEnrollment.targetLang,
        bootstrapEnrollment.nativeLang,
        bootstrapEnrollment.uiLang,
        new Date().toISOString(),
      );
    enrollmentId = Number(res.lastInsertRowid);
  }

  // ---- Column-level renames that older builds are still carrying ----
  if (tables.has('words')) {
    const w = cols('words');
    if (!w.includes('source')) db.exec("ALTER TABLE words ADD COLUMN source TEXT NOT NULL DEFAULT 'reading'");
    for (const [from, to] of [
      ['example_ko', 'example_target'],
      ['example_en', 'example_native'],
      ['meaning_en', 'meaning_native'],
    ] as const) {
      if (w.includes(from) && !w.includes(to)) db.exec(`ALTER TABLE words RENAME COLUMN ${from} TO ${to}`);
    }
  }
  if (tables.has('dictation_entries')) {
    const d = cols('dictation_entries');
    // 'target_text' rather than 'target_target': the column already held the
    // text the learner is being asked to reproduce.
    if (d.includes('target_ko') && !d.includes('target_text')) {
      db.exec('ALTER TABLE dictation_entries RENAME COLUMN target_ko TO target_text');
    }
  }
  if (tables.has('sessions') && !cols('sessions').includes('read_answers_json')) {
    db.exec('ALTER TABLE sessions ADD COLUMN read_answers_json TEXT');
  }
  // One database holds every supported language's passages; rows written before
  // that change were all Korean.
  if (tables.has('passages') && !cols('passages').includes('target_lang')) {
    db.exec('ALTER TABLE passages ADD COLUMN target_lang TEXT');
    db.exec("UPDATE passages SET target_lang='ko' WHERE target_lang IS NULL");
  }

  // ---- Step 4: settings, re-keyed from `id = 1` to the enrollment ----
  // `CHECK (id = 1)` and a `PRIMARY KEY` cannot be altered, hence the rebuild.
  if (tables.has('settings') && cols('settings').includes('id') && !cols('settings').includes('enrollment_id')) {
    rebuildTable(
      db,
      'settings',
      `CREATE TABLE settings_rebuild (
         enrollment_id         INTEGER PRIMARY KEY REFERENCES enrollments(id) ON DELETE CASCADE,
         level                 INTEGER NOT NULL DEFAULT 1,
         tts_rate              REAL NOT NULL DEFAULT 1.0,
         tts_voice             TEXT,
         show_romanization     INTEGER NOT NULL DEFAULT 0,
         keep_recordings_days  INTEGER NOT NULL DEFAULT 14,
         streak                INTEGER NOT NULL DEFAULT 0,
         last_session_date     TEXT,
         timezone              TEXT,
         created_at            TEXT
       )`,
      `INSERT INTO settings_rebuild
         (enrollment_id, level, tts_rate, tts_voice, show_romanization, keep_recordings_days,
          streak, last_session_date, timezone, created_at)
       SELECT ${enrollmentId}, level, tts_rate, tts_voice, show_romanization, keep_recordings_days,
              streak, last_session_date, timezone, created_at
       FROM settings WHERE id=1`,
    );
  }

  // ---- Step 5: sessions, one row per (enrollment, day) ----
  // Was `UNIQUE(date)`, which is why two people cannot share a database yet.
  if (tables.has('sessions') && !cols('sessions').includes('enrollment_id')) {
    rebuildTable(
      db,
      'sessions',
      `CREATE TABLE sessions_rebuild (
         id           INTEGER PRIMARY KEY AUTOINCREMENT,
         enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
         date         TEXT NOT NULL,
         passage_id   INTEGER,
         status       TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','done')),
         current_step TEXT NOT NULL DEFAULT 'warmup',
         read_score INTEGER, write_score INTEGER, listen_score INTEGER,
         speak_score INTEGER, vocab_score INTEGER, duration_s INTEGER,
         read_answers_json TEXT,
         UNIQUE (enrollment_id, date),
         FOREIGN KEY (passage_id) REFERENCES passages(id)
       )`,
      `INSERT INTO sessions_rebuild
         (id, enrollment_id, date, passage_id, status, current_step, read_score, write_score,
          listen_score, speak_score, vocab_score, duration_s, read_answers_json)
       SELECT id, ${enrollmentId}, date, passage_id, status, current_step, read_score, write_score,
              listen_score, speak_score, vocab_score, duration_s, read_answers_json
       FROM sessions`,
    );
  }

  // ---- Step 6: words, unique per enrollment rather than globally ----
  // `UNIQUE(lemma)` is what makes two people collide on the same word and
  // silently share one SRS card between them.
  if (tables.has('words') && !cols('words').includes('enrollment_id')) {
    rebuildTable(
      db,
      'words',
      `CREATE TABLE words_rebuild (
         id                INTEGER PRIMARY KEY AUTOINCREMENT,
         enrollment_id     INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
         lemma             TEXT NOT NULL,
         surface_example   TEXT NOT NULL,
         meaning_native    TEXT NOT NULL,
         pos               TEXT NOT NULL,
         level             INTEGER NOT NULL,
         first_seen_at     TEXT NOT NULL,
         source_passage_id INTEGER,
         source            TEXT NOT NULL DEFAULT 'reading'
                             CHECK (source IN ('reading','manual','suggested')),
         example_target    TEXT,
         example_native    TEXT,
         UNIQUE (enrollment_id, lemma),
         FOREIGN KEY (source_passage_id) REFERENCES passages(id)
       )`,
      `INSERT INTO words_rebuild
         (id, enrollment_id, lemma, surface_example, meaning_native, pos, level, first_seen_at,
          source_passage_id, source, example_target, example_native)
       SELECT id, ${enrollmentId}, lemma, surface_example, meaning_native, pos, level, first_seen_at,
              source_passage_id, source, example_target, example_native
       FROM words`,
    );
  }

  // ---- Step 7: dictation_entries gains the column; the rename happened above ----
  // ---- Step 8: the other three child tables ----
  for (const t of ['writing_entries', 'speaking_attempts', 'dictation_entries', 'level_history']) {
    if (tables.has(t) && !cols(t).includes('enrollment_id')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN enrollment_id INTEGER REFERENCES enrollments(id) ON DELETE CASCADE`);
    }
  }

  // ---- Step 10: every row belongs to the bootstrap enrollment ----
  for (const t of ['settings', 'sessions', 'words', 'writing_entries', 'speaking_attempts', 'dictation_entries', 'level_history']) {
    if (tables.has(t) && cols(t).includes('enrollment_id')) {
      db.prepare(`UPDATE ${t} SET enrollment_id=? WHERE enrollment_id IS NULL`).run(enrollmentId);
    }
  }

  // ---- Step 11: translate the old global `used` flag into per-enrollment rows ----
  // The point of this step is that the existing account's experience is
  // identical after the migration: the same passage is already consumed, the
  // same pack is already waiting for tomorrow, the same seed bank is still
  // available.
  if (tables.has('passages')) {
    const hasRows = countOf(db, 'SELECT COUNT(*) AS c FROM enrollment_passages WHERE enrollment_id=?', enrollmentId);
    if (hasRows === 0) {
      db.prepare(
        `INSERT OR IGNORE INTO enrollment_passages (enrollment_id, passage_id, intended_date, used_at)
         SELECT ?, id,
                CASE WHEN used = 0 THEN intended_date ELSE NULL END,
                CASE WHEN used = 1 THEN ? ELSE NULL END
         FROM passages`,
      ).run(enrollmentId, new Date().toISOString());
    }
  }

  // ---- Step 12: the field names inside the stored JSON ----
  // Must follow the column renames: the payloads reference the same fields.
  migrateJsonPayloads(db, tables);

  // ---- Step 13: indexes that describe the new shape ----
  // The global ones are actively misleading now, so they go rather than linger.
  // Each statement is guarded on its table existing: this runs before
  // `SCHEMA_SQL`, so on a *fresh* database there is nothing to index yet and
  // `CREATE INDEX` would fail outright. `SCHEMA_SQL` creates them a moment later.
  for (const name of ['idx_words_lemma', 'idx_passages_source_used', 'idx_passages_intended_date']) {
    if (indexExists(db, name)) db.exec(`DROP INDEX IF EXISTS ${name}`);
  }
  for (const [table, sql] of [
    ['passages', 'CREATE INDEX IF NOT EXISTS idx_passages_lang ON passages(target_lang, source)'],
    [
      'enrollment_passages',
      'CREATE INDEX IF NOT EXISTS idx_enrollment_passages_avail ON enrollment_passages(enrollment_id, intended_date, used_at)',
    ],
    ['words', 'CREATE INDEX IF NOT EXISTS idx_words_enrollment_lemma ON words(enrollment_id, lemma)'],
  ] as const) {
    if (tablesOf(db).has(table)) db.exec(sql);
  }

  // ---- Step 14: prove the migration did what it claimed ----
  // A silent partial migration is the failure mode that costs the most here:
  // the app boots, looks healthy, and has quietly lost somebody's history.
  const violations: string[] = [];
  for (const t of ['settings', 'sessions', 'words', 'writing_entries', 'speaking_attempts', 'dictation_entries', 'level_history']) {
    if (!tablesOf(db).has(t) || !columnsOf(db, t).includes('enrollment_id')) continue;
    const orphans = countOf(db, `SELECT COUNT(*) AS c FROM ${t} WHERE enrollment_id IS NULL`);
    if (orphans) violations.push(`${t}: ${orphans} row(s) with no enrollment`);
  }
  const dangling = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
  if (dangling.length) violations.push(`${dangling.length} dangling foreign key(s)`);
  if (violations.length) {
    throw new Error(`migration incomplete:\n  - ${violations.join('\n  - ')}`);
  }

  // The one row an older build promised the user: a settings row with a usable
  // voice and a sane level. Repaired rather than trusted, because a database
  // written by an older build may hold a hardcoded voice from another language.
  // Skipped on a fresh database, where `settings` does not exist until
  // `SCHEMA_SQL` runs and the row is created with its defaults.
  if (tablesOf(db).has('settings')) {
    db.prepare(
      `UPDATE settings SET
         tts_voice=COALESCE(NULLIF(tts_voice,''), ?),
         tts_rate=COALESCE(NULLIF(tts_rate,0), 1),
         keep_recordings_days=COALESCE(NULLIF(keep_recordings_days,0), 14),
         level=COALESCE(NULLIF(level,0), 1)
       WHERE enrollment_id=?`,
    ).run(defaultVoice, enrollmentId);
  }

  return enrollmentId;
}

/**
 * The account tables, created one at a time by `migrate()` before `SCHEMA_SQL`
 * runs. `enrollment_passages` may reference `passages` before that table exists:
 * SQLite resolves foreign keys at write time, not at `CREATE TABLE` time, and
 * `SCHEMA_SQL` creates `passages` immediately afterwards.
 */
const ACCOUNT_TABLES: string[] = [
  `CREATE TABLE users (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     username      TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     display_name  TEXT NOT NULL,
     is_bootstrap  INTEGER NOT NULL DEFAULT 0,
     created_at    TEXT NOT NULL
   )`,
  `CREATE TABLE enrollments (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     target_lang TEXT NOT NULL,
     native_lang TEXT NOT NULL,
     ui_lang     TEXT NOT NULL,
     created_at  TEXT NOT NULL,
     UNIQUE (user_id, target_lang, native_lang)
   )`,
  `CREATE TABLE enrollment_passages (
     enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
     passage_id    INTEGER NOT NULL REFERENCES passages(id)    ON DELETE CASCADE,
     intended_date TEXT,
     used_at       TEXT,
     PRIMARY KEY (enrollment_id, passage_id)
   )`,
  `CREATE TABLE llm_usage_by_user (
     date    TEXT    NOT NULL,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     calls   INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (date, user_id)
   )`,
];

/** The table name a `CREATE TABLE <name>` statement creates. */
function tableNameOf(createSql: string): string {
  const m = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(createSql);
  if (!m) throw new Error(`cannot read a table name out of: ${createSql.slice(0, 60)}`);
  return m[1]!;
}

/**
 * Whether an index exists.
 *
 * Needed because `DROP INDEX IF EXISTS <name>` still fails when the index's
 * *table* is missing: `IF EXISTS` covers the index, not the table it hangs off.
 */
function indexExists(db: DatabaseSync, name: string): boolean {
  return !!db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name=?")
    .get(name);
}

export function openDb(dbPath: string, opts: OpenDbOptions): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  const enrollmentId = migrate(db, opts);
  db.exec(SCHEMA_SQL);
  // Fresh database: the settings row the rebuild above would have copied does
  // not exist yet. Migrated database: this is a no-op.
  db.prepare('INSERT OR IGNORE INTO settings (enrollment_id) VALUES (?)').run(enrollmentId);
  return db;
}

export function asInt(v: number | bigint | undefined): number {
  return Number(v ?? 0);
}
