import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../fixtures.js';

/**
 * A deployment with two real accounts, each with one session, one writing entry,
 * one speaking attempt and one word.
 *
 * Built through the database rather than through the API on purpose: the routes
 * under test are the ones that should *not* be reachable by id, so the fixture
 * cannot be assembled by calling them.
 */
export interface AuthzFixture extends TestApp {
  myCookie: string;
  otherCookie: string;
  mySessionId: number;
  otherSessionId: number;
  myWordId: number;
  otherWordId: number;
  myWritingId: number;
  otherWritingId: number;
  mySpeakingId: number;
  otherSpeakingId: number;
  recordingsDir: string;
  myRecording: string;
  otherRecording: string;
}

export async function authzSignedInFixture(): Promise<AuthzFixture> {
  const app = await makeTestApp({ targetLangs: 'ko,fr' });
  const { db } = app;

  // `asUser` creates the account if it is not there yet, so the fixture does not
  // have to know how accounts come into being.
  const otherCookie = await app.asUser('sibling');
  const other = db.prepare('SELECT id FROM users WHERE username=?').get('sibling') as { id: number };
  const otherEnrollment = (
    db.prepare('SELECT id FROM enrollments WHERE user_id=? ORDER BY id LIMIT 1').get(other.id) as { id: number }
  ).id;
  db.prepare('UPDATE settings SET timezone=? WHERE enrollment_id=?').run('Europe/Paris', otherEnrollment);

  const now = new Date().toISOString();
  // A different local day per account, so "today" cannot quietly match for both
  // and let a session from one account satisfy the other's daily session.
  const dateFor = (enrollmentId: number) => (enrollmentId === app.enrollmentId ? '2026-03-01' : '2026-03-02');

  // Two passages to hand out, so neither account is looking at a shared row.
  const pack = {
    level: 1,
    topic: 'family',
    title_target: '가족',
    passage_target: '가족이 네 명이에요.',
    passage_native: 'My family has four people.',
    sentences: [
      { target: '가족이 네 명이에요.', native: 'My family has four people.' },
      { target: '저는 학생이에요.', native: 'I am a student.' },
    ],
    glossary: [{ surface: '가족', lemma: '가족', pos: 'noun', meaning_native: 'family' }],
    questions: [
      { q_target: '가족이 몇 명이에요?', q_native: 'How many people?', choices: ['네 명', '두 명'], answer_index: 0, explanation_native: 'four' },
      { q_target: '저는?', q_native: 'I am?', choices: ['학생', '선생'], answer_index: 0, explanation_native: 'student' },
      { q_target: 'x', q_native: 'y', choices: ['a', 'b'], answer_index: 1, explanation_native: 'z' },
    ],
    writing_prompt: { target: '가족을 소개하세요.', native: 'Introduce your family.' },
    speaking_prompt: { target: '가족은 몇 명이에요?', native: 'How many people are in your family?' },
  };
  const passageId = (
    db
      .prepare('INSERT INTO passages (target_lang,level,topic,payload_json,source,used,created_at) VALUES (?,1,?,?,?,0,?)')
      .run('ko', 'family', JSON.stringify(pack), 'seed', now).lastInsertRowid
  ) as number;

  const addSession = (enrollmentId: number, lemma: string, meaning: string) => {
    // Completed, not in progress: `/api/sessions` only lists finished days, so
    // an in-progress fixture row would make the history list look empty and the
    // per-account comparison in the list tests would pass for the wrong reason.
    db.prepare(
      "INSERT INTO sessions (enrollment_id,date,passage_id,status,current_step,read_score,duration_s) VALUES (?,?,?, 'done','complete',80,300)",
    ).run(enrollmentId, dateFor(enrollmentId), passageId);
    const sessionId = Number(
      (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
    );
    const wordId = Number(
      db
        .prepare(
          "INSERT INTO words (enrollment_id,lemma,surface_example,meaning_native,pos,level,first_seen_at,source) VALUES (?,?,?,?,'noun',1,?,'reading')",
        )
        .run(enrollmentId, lemma, lemma, meaning, dateFor(enrollmentId)).lastInsertRowid,
    );
    db.prepare('INSERT INTO srs_cards (word_id,ease,interval_days,due_date,reps,lapses) VALUES (?,2.5,0,?,0,0)').run(
      wordId,
      '2020-01-01',
    );
    const writingId = Number(
      db
        .prepare('INSERT INTO writing_entries (enrollment_id,session_id,prompt_json,user_text,created_at) VALUES (?,?,?,?,?)')
        .run(
          enrollmentId,
          sessionId,
          JSON.stringify({ target: '가족을 소개하세요.', native: 'Introduce your family.', level: 1 }),
          'mine',
          now,
        ).lastInsertRowid,
    );
    const speakingId = Number(
      db
        .prepare(
          "INSERT INTO speaking_attempts (enrollment_id,session_id,mode,prompt_json,audio_path,transcript,created_at) VALUES (?,?,'free_speech',?,NULL,?,?)",
        )
        .run(
          enrollmentId,
          sessionId,
          JSON.stringify({ target: '가족은 몇 명이에요.', native: 'How many?', level: 1 }),
          'transcript',
          now,
        ).lastInsertRowid,
    );
    return { sessionId, wordId, writingId, speakingId };
  };

  const mine = addSession(app.enrollmentId, 'mine', 'my meaning');
  const theirs = addSession(otherEnrollment, 'theirs', 'their meaning');

  // A real file per account, so the recording sweep has something to delete and
  // something it must not delete.
  const recordingsDir = path.join(app.cfg.dataDir, 'recordings');
  fs.mkdirSync(recordingsDir, { recursive: true });
  const myRecording = path.join(recordingsDir, `freespeech_e${app.enrollmentId}_1_${mine.speakingId}.webm`);
  const otherRecording = path.join(recordingsDir, `freespeech_e${otherEnrollment}_1_${theirs.speakingId}.webm`);
  fs.writeFileSync(myRecording, 'mine');
  fs.writeFileSync(otherRecording, 'theirs');
  db.prepare('UPDATE speaking_attempts SET audio_path=? WHERE id=?').run(myRecording, mine.speakingId);
  db.prepare('UPDATE speaking_attempts SET audio_path=? WHERE id=?').run(otherRecording, theirs.speakingId);

  return {
    ...app,
    myCookie: await app.login('default', 'korean'),
    otherCookie,
    mySessionId: mine.sessionId,
    otherSessionId: theirs.sessionId,
    myWordId: mine.wordId,
    otherWordId: theirs.wordId,
    myWritingId: mine.writingId,
    otherWritingId: theirs.writingId,
    mySpeakingId: mine.speakingId,
    otherSpeakingId: theirs.speakingId,
    recordingsDir,
    myRecording,
    otherRecording,
  };
}
