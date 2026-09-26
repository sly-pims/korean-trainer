import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  level INTEGER NOT NULL DEFAULT 1,
  tts_rate REAL NOT NULL DEFAULT 1.0,
  tts_voice TEXT,
  show_romanization INTEGER NOT NULL DEFAULT 0,
  keep_recordings_days INTEGER NOT NULL DEFAULT 14,
  streak INTEGER NOT NULL DEFAULT 0,
  last_session_date TEXT,
  timezone TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS passages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_lang TEXT NOT NULL,
  level INTEGER NOT NULL,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('llm','seed')),
  used INTEGER NOT NULL DEFAULT 0,
  intended_date TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  passage_id INTEGER,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','done')),
  current_step TEXT NOT NULL DEFAULT 'warmup',
  read_score INTEGER,
  write_score INTEGER,
  listen_score INTEGER,
  speak_score INTEGER,
  vocab_score INTEGER,
  duration_s INTEGER,
  read_answers_json TEXT,
  FOREIGN KEY (passage_id) REFERENCES passages(id)
);

CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lemma TEXT NOT NULL UNIQUE,
  surface_example TEXT NOT NULL,
  meaning_native TEXT NOT NULL,
  pos TEXT NOT NULL,
  level INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  source_passage_id INTEGER,
  source TEXT NOT NULL DEFAULT 'reading' CHECK (source IN ('reading','manual','suggested')),
  example_target TEXT,
  example_native TEXT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  prompt_json TEXT NOT NULL,
  user_text TEXT NOT NULL,
  feedback_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS speaking_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  sentence_index INTEGER NOT NULL,
  target_text TEXT NOT NULL,
  typed_text TEXT NOT NULL,
  score INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS llm_usage (
  date TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS level_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_date TEXT NOT NULL,
  from_level INTEGER NOT NULL,
  to_level INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_passages_source_used ON passages(source, used);
CREATE INDEX IF NOT EXISTS idx_passages_intended_date ON passages(intended_date, used);
CREATE INDEX IF NOT EXISTS idx_passages_lang ON passages(target_lang, source);
CREATE INDEX IF NOT EXISTS idx_srs_due ON srs_cards(due_date);
CREATE INDEX IF NOT EXISTS idx_words_lemma ON words(lemma);
CREATE INDEX IF NOT EXISTS idx_writing_feedback ON writing_entries(feedback_json);
CREATE INDEX IF NOT EXISTS idx_speaking_feedback ON speaking_attempts(feedback_json);
`;

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

/** Rewrites every stored payload that still uses the old field names. */
function migrateJsonPayloads(db: DatabaseSync, tables: Set<string>): void {
  const targets: [string, string][] = [
    ['passages', 'payload_json'],
    ['writing_entries', 'prompt_json'],
    ['writing_entries', 'feedback_json'],
    ['speaking_attempts', 'prompt_json'],
    ['speaking_attempts', 'feedback_json'],
  ];
  for (const [table, column] of targets) {
    if (!tables.has(table)) continue;
    if (!(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)) {
      continue;
    }
    const rows = db
      .prepare(`SELECT id, ${column} AS body FROM ${table} WHERE ${column} IS NOT NULL`)
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
 * Column-level migrations for databases created by an older build.
 *
 * Runs BEFORE SCHEMA_SQL: SCHEMA_SQL creates indexes, and an index over a
 * column that only this migration adds would throw on a pre-existing table.
 * Every step is self-detecting and guarded on the table existing, so a fresh
 * database (where SCHEMA_SQL does the creating) is a no-op.
 */
function migrate(db: DatabaseSync, defaultVoice: string): void {
  const columns = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map((c) => c.name);

  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (t) => t.name,
    ),
  );

  // One database now holds every supported language's passages. Rows written
  // before that change were all Korean.
  if (tables.has('passages')) {
    if (!columns('passages').includes('target_lang')) {
      db.exec('ALTER TABLE passages ADD COLUMN target_lang TEXT');
      db.exec("UPDATE passages SET target_lang='ko' WHERE target_lang IS NULL");
    }
  }

  if (tables.has('words')) {
    const cols = columns('words');
    if (!cols.includes('source')) db.exec("ALTER TABLE words ADD COLUMN source TEXT NOT NULL DEFAULT 'reading'");
    // These arrived when the fields were renamed to say which side of the
    // target/native pair they hold. RENAME COLUMN is a metadata-only change in
    // SQLite and rewrites index references itself.
    for (const [from, to] of [
      ['example_ko', 'example_target'],
      ['example_en', 'example_native'],
      ['meaning_en', 'meaning_native'],
    ] as const) {
      if (cols.includes(from) && !cols.includes(to)) {
        db.exec(`ALTER TABLE words RENAME COLUMN ${from} TO ${to}`);
      }
    }
  }

  if (tables.has('dictation_entries')) {
    const cols = columns('dictation_entries');
    // 'target_text' rather than 'target_target': the column already held the
    // text the learner is being asked to reproduce.
    if (cols.includes('target_ko') && !cols.includes('target_text')) {
      db.exec('ALTER TABLE dictation_entries RENAME COLUMN target_ko TO target_text');
    }
  }

  if (tables.has('sessions') && !columns('sessions').includes('read_answers_json')) {
    db.exec('ALTER TABLE sessions ADD COLUMN read_answers_json TEXT');
  }

  // Must follow the column renames: the payloads reference the same fields.
  migrateJsonPayloads(db, tables);

  // settings still carries the single-row CHECK(id=1) shape at this phase; only
  // the hardcoded voice literal is replaced by the configured default.
  if (tables.has('settings')) {
    db.prepare(
      `UPDATE settings SET
         tts_voice=COALESCE(NULLIF(tts_voice,''), ?),
         tts_rate=COALESCE(NULLIF(tts_rate,0), 1),
         keep_recordings_days=COALESCE(NULLIF(keep_recordings_days,0), 14),
         level=COALESCE(NULLIF(level,0), 1)
       WHERE id=1`,
    ).run(defaultVoice);
  }
}

/**
 * @param defaultVoice The active target language's default TTS voice, from its
 *   `config/languages.<code>.json`. Required rather than defaulted: a default
 *   here would be a hardcoded voice in a module that has no way to know the
 *   language, which is how a French deployment ends up speaking Korean.
 */
export function openDb(dbPath: string, defaultVoice: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db, defaultVoice);
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();
  db.prepare(
    `UPDATE settings SET
       tts_voice=COALESCE(NULLIF(tts_voice,''), ?),
       tts_rate=COALESCE(NULLIF(tts_rate,0), 1),
       keep_recordings_days=COALESCE(NULLIF(keep_recordings_days,0), 14),
       level=COALESCE(NULLIF(level,0), 1)
     WHERE id=1`,
  ).run(defaultVoice);
  return db;
}

export function asInt(v: number | bigint | undefined): number {
  return Number(v ?? 0);
}