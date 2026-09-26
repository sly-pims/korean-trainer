import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { ContentPackSchema } from '../src/schema/content.js';

// The field rename is not only a column rename: passages, prompts and feedback
// are stored as JSON text with the field names inside them. These tests build a
// database in the pre-rename shape and assert the migration brings both the
// columns and the stored payloads across, and that doing it again changes
// nothing.

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-migration-'));
  file = path.join(dir, 'legacy.db');
});

afterEach(() => {
  // A failed assertion can leave a database handle open, and Windows will not
  // delete the directory underneath it. Cleanup must never mask the real error.
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* leave the temp directory to the OS */
  }
});

/** A passage pack in the old language-coded shape. */
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
      choices: ['네 명', '두 명', '다섯 명', '세 명'],
      answer_index: 0,
      explanation_en: 'The passage says four.',
    },
    { q_ko: '둘째 질문?', q_en: 'Second?', choices: ['a', 'b', 'c', 'd'], answer_index: 1, explanation_en: 'x' },
    { q_ko: '셋째 질문?', q_en: 'Third?', choices: ['a', 'b', 'c', 'd'], answer_index: 2, explanation_en: 'y' },
  ],
  writing_prompt: { ko: '가족을 소개하세요.', en: 'Introduce your family.', target_grammar: '이에요' },
  speaking_prompt: { ko: '가족은 몇 명이에요?', en: 'How many people are in your family?' },
};

/** The pre-rename tables, only as much as the migration needs to recognise. */
function buildLegacyDb(): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE passages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level INTEGER NOT NULL,
      topic TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      intended_date TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lemma TEXT NOT NULL UNIQUE,
      surface_example TEXT NOT NULL,
      meaning_en TEXT NOT NULL,
      pos TEXT NOT NULL,
      level INTEGER NOT NULL,
      first_seen_at TEXT NOT NULL,
      source_passage_id INTEGER,
      source TEXT NOT NULL DEFAULT 'reading',
      example_ko TEXT,
      example_en TEXT
    );
    CREATE TABLE dictation_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      sentence_index INTEGER NOT NULL,
      target_ko TEXT NOT NULL,
      typed_text TEXT NOT NULL,
      score REAL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE writing_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      prompt_json TEXT NOT NULL,
      user_text TEXT NOT NULL,
      feedback_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE speaking_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      prompt_json TEXT NOT NULL,
      audio_path TEXT,
      transcript TEXT,
      feedback_json TEXT,
      score REAL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO passages (level,topic,payload_json,source,created_at) VALUES (?,?,?,?,?)').run(
    1,
    'family',
    JSON.stringify(LEGACY_PACK),
    'seed',
    '2026-01-01',
  );
  db.prepare(
    'INSERT INTO words (lemma,surface_example,meaning_en,pos,level,first_seen_at,example_ko,example_en) VALUES (?,?,?,?,?,?,?,?)',
  ).run('가족', '가족', 'family', 'noun', 1, '2026-01-01', '가족이 있어요.', 'I have a family.');
  db.prepare(
    'INSERT INTO dictation_entries (session_id,sentence_index,target_ko,typed_text,score,created_at) VALUES (?,?,?,?,?,?)',
  ).run(1, 0, '가족이 네 명이에요.', '가족이 네 명이에요.', 100, '2026-01-01');
  db.prepare('INSERT INTO writing_entries (session_id,prompt_json,user_text,feedback_json,created_at) VALUES (?,?,?,?,?)').run(
    1,
    JSON.stringify({ ko: '가족을 소개하세요.', en: 'Introduce your family.', level: 1 }),
    '저는 가족을 소개합니다.',
    JSON.stringify({
      corrected_ko: '저는 가족을 소개합니다',
      score: 4,
      issues: [{ original: '합니다', fix: '합니다', type: 'other', explanation_en: 'fine' }],
      more_natural_ko: '저는 가족을 소개할게요',
      encouragement_en: 'Good work.',
    }),
    '2026-01-01',
  );
  db.prepare('INSERT INTO speaking_attempts (session_id,prompt_json,audio_path,transcript,feedback_json,score,created_at) VALUES (?,?,?,?,?,?,?)').run(
    1,
    JSON.stringify({ ko: '가족은 몇 명이에요?', en: 'How many people are in your family?', level: 1 }),
    '/tmp/a.webm',
    '가족은 네 명이에요',
    JSON.stringify({
      transcript_ko: '가족은 네 명이에요',
      corrected_ko: '가족은 네 명이에요',
      score: 4,
      issues: [],
      more_natural_ko: '저희 가족은 네 명이에요',
      pronunciation_notes: [{ word: '가족', note_en: 'ga-chok', confidence: 'high' }],
      fluency_note_en: 'Spoke steadily.',
      encouragement_en: 'Nicely done.',
    }),
    4,
    '2026-01-01',
  );
  db.close();
}

const columnNames = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

const readJson = (db: DatabaseSync, sql: string): Record<string, unknown> =>
  JSON.parse((db.prepare(sql).get() as { body: string }).body) as Record<string, unknown>;

describe('field rename migration', () => {
  it('renames the columns that held language-coded names', () => {
    buildLegacyDb();
    const db = openDb(file);

    const words = columnNames(db, 'words');
    expect(words).toContain('meaning_native');
    expect(words).toContain('example_target');
    expect(words).toContain('example_native');
    expect(words).not.toContain('meaning_en');
    expect(words).not.toContain('example_ko');
    expect(words).not.toContain('example_en');

    const dictation = columnNames(db, 'dictation_entries');
    expect(dictation).toContain('target_text');
    expect(dictation).not.toContain('target_ko');

    db.close();
  });

  it('keeps the data in the renamed columns', () => {
    buildLegacyDb();
    const db = openDb(file);

    const word = db.prepare('SELECT lemma, meaning_native, example_target, example_native FROM words').get() as Record<
      string,
      string
    >;
    expect(word).toEqual({
      lemma: '가족',
      meaning_native: 'family',
      example_target: '가족이 있어요.',
      example_native: 'I have a family.',
    });

    const dictation = db.prepare('SELECT target_text FROM dictation_entries').get() as { target_text: string };
    expect(dictation.target_text).toBe('가족이 네 명이에요.');

    db.close();
  });

  it('rewrites the field names stored inside the passage payload', () => {
    buildLegacyDb();
    const db = openDb(file);
    const pack = readJson(db, 'SELECT payload_json AS body FROM passages');

    expect(pack).toMatchObject({
      title_target: '가족',
      passage_target: '가족이 네 명이에요.',
      passage_native: 'My family has four people.',
      writing_prompt: { target: '가족을 소개하세요.', native: 'Introduce your family.', target_grammar: '이에요' },
      speaking_prompt: { target: '가족은 몇 명이에요?', native: 'How many people are in your family?' },
    });
    expect(pack.sentences).toEqual([
      { target: '가족이 네 명이에요.', native: 'My family has four people.' },
    ]);
    expect(pack.glossary).toEqual([
      { surface: '가족', lemma: '가족', pos: 'noun', meaning_native: 'family' },
    ]);
    expect(pack.questions).toEqual([
      {
        q_target: '가족이 몇 명이에요?',
        q_native: 'How many people?',
        choices: ['네 명', '두 명', '다섯 명', '세 명'],
        answer_index: 0,
        explanation_native: 'The passage says four.',
      },
      { q_target: '둘째 질문?', q_native: 'Second?', choices: ['a', 'b', 'c', 'd'], answer_index: 1, explanation_native: 'x' },
      { q_target: '셋째 질문?', q_native: 'Third?', choices: ['a', 'b', 'c', 'd'], answer_index: 2, explanation_native: 'y' },
    ]);

    db.close();
  });

  it('produces a payload the current schema accepts', () => {
    buildLegacyDb();
    const db = openDb(file);
    const pack = readJson(db, 'SELECT payload_json AS body FROM passages');
    db.close();

    // The real guarantee that the rewrite is right: the old pack is now
    // indistinguishable from a freshly seeded one.
    expect(ContentPackSchema.safeParse(pack).success).toBe(true);
  });

  it('rewrites prompt and feedback payloads', () => {
    buildLegacyDb();
    const db = openDb(file);

    expect(readJson(db, 'SELECT prompt_json AS body FROM writing_entries')).toEqual({
      target: '가족을 소개하세요.',
      native: 'Introduce your family.',
      level: 1,
    });
    expect(readJson(db, 'SELECT feedback_json AS body FROM writing_entries')).toEqual({
      corrected_target: '저는 가족을 소개합니다',
      score: 4,
      issues: [{ original: '합니다', fix: '합니다', type: 'other', explanation_native: 'fine' }],
      more_natural_target: '저는 가족을 소개할게요',
      encouragement_native: 'Good work.',
    });
    expect(readJson(db, 'SELECT prompt_json AS body FROM speaking_attempts')).toEqual({
      target: '가족은 몇 명이에요?',
      native: 'How many people are in your family?',
      level: 1,
    });

    const speaking = readJson(db, 'SELECT feedback_json AS body FROM speaking_attempts');
    expect(speaking).toMatchObject({
      transcript_target: '가족은 네 명이에요',
      corrected_target: '가족은 네 명이에요',
      more_natural_target: '저희 가족은 네 명이에요',
      fluency_note_native: 'Spoke steadily.',
      encouragement_native: 'Nicely done.',
    });
    expect(speaking.pronunciation_notes).toEqual([
      { word: '가족', note_native: 'ga-chok', confidence: 'high' },
    ]);

    db.close();
  });

  it('changes nothing on a second run', () => {
    buildLegacyDb();
    const first = openDb(file);
    const afterFirst = {
      pack: (first.prepare('SELECT payload_json AS body FROM passages').get() as { body: string }).body,
      rows: {
        passages: first.prepare('SELECT COUNT(*) c FROM passages').get(),
        words: first.prepare('SELECT COUNT(*) c FROM words').get(),
        writing: first.prepare('SELECT COUNT(*) c FROM writing_entries').get(),
        speaking: first.prepare('SELECT COUNT(*) c FROM speaking_attempts').get(),
      },
    };
    first.close();

    const second = openDb(file);
    expect((second.prepare('SELECT payload_json AS body FROM passages').get() as { body: string }).body).toBe(
      afterFirst.pack,
    );
    expect({
      passages: second.prepare('SELECT COUNT(*) c FROM passages').get(),
      words: second.prepare('SELECT COUNT(*) c FROM words').get(),
      writing: second.prepare('SELECT COUNT(*) c FROM writing_entries').get(),
      speaking: second.prepare('SELECT COUNT(*) c FROM speaking_attempts').get(),
    }).toEqual(afterFirst.rows);
    expect(second.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    second.close();
  });

  it('leaves JSON it cannot parse alone', () => {
    buildLegacyDb();
    const raw = new DatabaseSync(file);
    raw.prepare('UPDATE writing_entries SET prompt_json=?').run('{not json');
    raw.close();

    const db = openDb(file);
    expect((db.prepare('SELECT prompt_json AS body FROM writing_entries').get() as { body: string }).body).toBe(
      '{not json',
    );
    db.close();
  });
});
