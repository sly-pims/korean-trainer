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
  FOREIGN KEY (passage_id) REFERENCES passages(id)
);

CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lemma TEXT NOT NULL UNIQUE,
  surface_example TEXT NOT NULL,
  meaning_en TEXT NOT NULL,
  pos TEXT NOT NULL,
  level INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  source_passage_id INTEGER,
  source TEXT NOT NULL DEFAULT 'reading' CHECK (source IN ('reading','manual','suggested')),
  example_ko TEXT,
  example_en TEXT,
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
CREATE INDEX IF NOT EXISTS idx_srs_due ON srs_cards(due_date);
CREATE INDEX IF NOT EXISTS idx_words_lemma ON words(lemma);
CREATE INDEX IF NOT EXISTS idx_writing_feedback ON writing_entries(feedback_json);
CREATE INDEX IF NOT EXISTS idx_speaking_feedback ON speaking_attempts(feedback_json);
`;

export function openDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA_SQL);
  const wordsCols = db.prepare('PRAGMA table_info(words)').all() as { name: string }[];
  const hasWordCol = (name: string) => wordsCols.some((c) => c.name === name);
  if (!hasWordCol('source')) db.exec("ALTER TABLE words ADD COLUMN source TEXT NOT NULL DEFAULT 'reading'");
  if (!hasWordCol('example_ko')) db.exec('ALTER TABLE words ADD COLUMN example_ko TEXT');
  if (!hasWordCol('example_en')) db.exec('ALTER TABLE words ADD COLUMN example_en TEXT');
  db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();
  db.prepare(
    "UPDATE settings SET tts_voice=COALESCE(NULLIF(tts_voice,''), 'ko-KR-SunHiNeural'), tts_rate=COALESCE(NULLIF(tts_rate,0), 1), keep_recordings_days=COALESCE(NULLIF(keep_recordings_days,0), 14), level=COALESCE(NULLIF(level,0), 1) WHERE id=1",
  ).run();
  return db;
}

export function asInt(v: number | bigint | undefined): number {
  return Number(v ?? 0);
}