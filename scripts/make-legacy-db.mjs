/**
 * Builds a pre-multi-account database for `rehearse-migration.mjs`.
 *
 * The schema is lifted verbatim out of the last committed `server/src/db.ts`,
 * so the fixture is the shape a real deployment actually has on disk rather
 * than a hand-written guess that can drift from it. Only the rows are
 * invented — a few months of ordinary single-account use.
 *
 *   node scripts/make-legacy-db.mjs <out.sqlite>
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/make-legacy-db.mjs <out.sqlite>');
  process.exit(1);
}

// The last commit predates the multi-account work, so its db.ts *is* the
// single-user schema this migration has to cope with.
const legacySource = execFileSync('git', ['show', 'HEAD:server/src/db.ts'], { encoding: 'utf8' });
const start = legacySource.indexOf('const SCHEMA_SQL = `');
if (start === -1) throw new Error('could not find SCHEMA_SQL in the previous commit');
const open = legacySource.indexOf('`', start);
const close = legacySource.indexOf('`;', open);
if (open === -1 || close === -1) throw new Error('could not delimit SCHEMA_SQL');
const SCHEMA_SQL = legacySource.slice(open + 1, close);

fs.rmSync(out, { force: true });
const db = new DatabaseSync(out);
db.exec(SCHEMA_SQL);

// The old `openDb` seeded this row on every boot.
db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();
db.prepare(
  `UPDATE settings SET
     level=4, tts_rate=0.95, tts_voice='ko-KR-SunHiNeural', show_romanization=1,
     keep_recordings_days=30, streak=17, last_session_date='2026-09-27', timezone='Asia/Seoul'
   WHERE id=1`,
).run();

/**
 * The pack shape the *live* database actually stores.
 *
 * These key names are the pre-Phase-3 ones — `title_ko`, `{ko, en}` sentence
 * pairs, `meaning_en` — because the live snapshot predates that rename. Writing
 * new-style names here would produce a database that does not exist and would
 * quietly skip the JSON rewrite the migration has to perform. Verified against
 * `backups/pre-migration/korean-20260926T092134Z.db`; keep the two in step.
 */
const pack = {
  level: 2,
  topic: 'family',
  title_ko: '가족',
  passage_ko: '가족이 네 명이에요.',
  passage_en: 'My family has four people.',
  sentences: [
    { ko: '가족이 네 명이에요.', en: 'My family has four people.' },
    { ko: '동생이 한국어를 배워요.', en: 'My little brother studies Korean.' },
  ],
  glossary: [
    { surface: '가족', lemma: '가족', pos: 'noun', meaning_en: 'family' },
    { surface: '동생', lemma: '동생', pos: 'noun', meaning_en: 'younger sibling' },
  ],
  questions: [
    {
      q_ko: '가족이 몇 명이에요?',
      q_en: 'How many people are in the family?',
      choices: ['세 명', '네 명', '다섯 명', '여섯 명'],
      answer_index: 1,
      explanation_en: 'The passage says 네 명, four people.',
    },
    {
      q_ko: '누가 한국어를 배워요?',
      q_en: 'Who studies Korean?',
      choices: ['동생', '가족', '어머니', '아버지'],
      answer_index: 0,
      explanation_en: '동생이, the younger sibling.',
    },
    {
      q_ko: '이 사람은 누구를 소개해요?',
      q_en: 'Who is this person introducing?',
      choices: ['학교를', '가족을', '친구를', '회사를'],
      answer_index: 1,
      explanation_en: '가족을, the family.',
    },
  ],
  writing_prompt: {
    ko: '가족을 소개하세요.',
    en: 'Introduce your family.',
    target_grammar: '이에요/예요, 있어요',
    level: 1,
  },
  speaking_prompt: { ko: '가족은 몇 명이에요?', en: 'How many people are in your family?' },
};

const passageId = Number(
  db
    .prepare(
      `INSERT INTO passages (target_lang, level, topic, payload_json, source, used, created_at)
       VALUES ('ko',2,'family',?, 'seed',0,'2026-09-01')`,
    )
    .run(JSON.stringify(pack)).lastInsertRowid,
);

for (const date of ['2026-09-25', '2026-09-26', '2026-09-27']) {
  db.prepare(
    `INSERT INTO sessions
       (date, passage_id, status, current_step, read_score, write_score, listen_score,
        speak_score, vocab_score, duration_s, read_answers_json)
     VALUES (?,?,'done','complete',80,75,90,85,70,420,?)`,
  ).run(date, passageId, JSON.stringify([1, 0, 1]));
}

for (const [lemma, meaning] of [
  ['가족', 'family'],
  ['학교', 'school'],
  ['친구', 'friend'],
]) {
  const wordId = Number(
    db
      .prepare(
        `INSERT INTO words
           (lemma, surface_example, meaning_native, pos, level, first_seen_at, source)
         VALUES (?,?,?,'noun',3,'2026-09-25','reading')`,
      )
      .run(lemma, lemma, meaning).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO srs_cards (word_id, ease, interval_days, due_date, reps, lapses)
     VALUES (?,2.6,5,'2026-10-01',4,1)`,
  ).run(wordId);
}

db.prepare(
  `INSERT INTO writing_entries (session_id, prompt_json, user_text, created_at)
   VALUES (1,?, '제 가족은 네 명이에요.', '2026-09-25')`,
).run(JSON.stringify(pack.writing_prompt));
db.prepare(
  `INSERT INTO speaking_attempts
     (session_id, mode, prompt_json, audio_path, transcript, score, created_at)
   VALUES (1,'read_aloud',?, '/data/recordings/freespeech_1.webm', '가족은 네 명이에요', 4, '2026-09-25')`,
).run(JSON.stringify({ ko: pack.speaking_prompt.ko, en: pack.speaking_prompt.en }));
db.prepare(
  `INSERT INTO dictation_entries (session_id, sentence_index, target_text, typed_text, score, created_at)
   VALUES (1,0, '가족이 네 명이에요.', '가족이 네 명이에요', 95, '2026-09-25')`,
).run();
db.prepare(
  `INSERT INTO level_history (change_date, from_level, to_level, reason)
   VALUES ('2026-09-20',2,3,'strong reading and writing')`,
).run();
db.prepare("INSERT INTO llm_usage (date, calls) VALUES ('2026-09-27', 12)").run();

const counts = Object.fromEntries(
  ['passages', 'sessions', 'words', 'srs_cards', 'writing_entries', 'speaking_attempts', 'dictation_entries', 'level_history'].map(
    (t) => [t, db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c],
  ),
);
db.close();
console.log(`legacy (single-user) database written to ${out}`);
console.log(`  ${JSON.stringify(counts)}`);
