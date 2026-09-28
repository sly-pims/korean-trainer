import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CallManager } from '../llm/callManager.js';
import { DailyCapReachedError } from '../llm/errors.js';
import type { LanguageProfile, Langs } from '../lang.js';
import type { PromptContext } from '../prompts/context.js';
import { writingGradePrompt, writingGradeSystem } from '../prompts/writingGrade.js';
import { speakingFeedbackPrompt, speakingFeedbackSystem } from '../prompts/speakingFeedback.js';
import { isUsableTranscript, transcribePrompt, transcribeSystem } from '../prompts/transcribe.js';
import { ContentPack, SpeakingFeedbackSchema, WritingFeedbackSchema } from '../schema/content.js';
import { convertToWav16k } from './audio.js';

export interface RetryResult {
  writing: { tried: number; graded: number; failed: number };
  speaking: { tried: number; graded: number; failed: number };
}

/**
 * Grades writing entries and free-speech recordings via the LLM, with the
 * "feedback ready later" fallback: on failure the row keeps feedback_json NULL
 * and retryQueued() picks it up on the next app open.
 */
interface WritingEntryRow {
  id: number;
  enrollment_id: number;
  session_id: number | null;
  prompt_json: string;
  user_text: string;
  feedback_json: string | null;
  score: number | null;
  created_at: string;
}

interface SpeakingAttemptRow {
  id: number;
  enrollment_id: number;
  session_id: number | null;
  mode: string;
  target: string | null;
  transcript: string | null;
  prompt_json: string | null;
  audio_path: string | null;
  feedback_json: string | null;
  score: number | null;
  created_at: string;
}

export class ReviewService {
  constructor(
    private db: DatabaseSync,
    private callManager: CallManager | null,
    private recordingsDir: string,
    private ffmpegPath: string,
    private langs: Langs,
  ) {}

  /**
   * The profile for a target language, or a hard failure.
   *
   * Falling back to some other language's profile here would put a French
   * learner's text in front of a Korean prompt, which is the exact leak this
   * whole phase exists to close. An unconfigured language must stop the request.
   *
   * There is deliberately no default: `defaultTargetLang` used to stand in
   * whenever a caller forgot to pass one, and with one database now serving
   * several languages, "forgot to pass one" silently means "graded in the
   * deployment's primary language".
   */
  private profileFor(targetLang: string): LanguageProfile {
    const profile = this.langs.get(targetLang);
    if (!profile) throw new Error(`no language profile configured for "${targetLang}"`);
    return profile;
  }

  /**
   * The language a stored row belongs to, read from the row's own enrollment.
   *
   * The retry queue has no request to inherit a language from — it runs at app
   * start, before anybody is logged in — so the language has to be a property of
   * the data. That is why every graded table carries `enrollment_id`.
   */
  private langForEnrollment(enrollmentId: number): string {
    const row = this.db.prepare('SELECT target_lang FROM enrollments WHERE id=?').get(enrollmentId) as
      | { target_lang: string }
      | undefined;
    if (!row) throw new Error(`no enrollment ${enrollmentId}`);
    return row.target_lang;
  }

  private promptCtx(targetLang: string): PromptContext {
    return { profile: this.profileFor(targetLang) };
  }

  // ---- Writing (§8.2) ----

  createWritingEntry(enrollmentId: number, sessionId: number, pack: ContentPack, userText: string): number {
    const res = this.db
      .prepare(
        'INSERT INTO writing_entries (enrollment_id, session_id, prompt_json, user_text, created_at) VALUES (?,?,?,?,?)',
      )
      .run(
        enrollmentId,
        sessionId,
        JSON.stringify({ ...pack.writing_prompt, level: pack.level }),
        userText,
        new Date().toISOString(),
      );
    return Number(res.lastInsertRowid);
  }

  /**
   * The entry, only if it belongs to this enrollment.
   *
   * Scoping the *read* is what makes the scoping elsewhere real: a grade request
   * that resolved a row by bare id would update another learner's feedback and
   * then report it back to the caller.
   */
  getWritingEntry(id: number, enrollmentId: number): WritingEntryRow | undefined {
    return this.db.prepare('SELECT * FROM writing_entries WHERE id=? AND enrollment_id=?').get(id, enrollmentId) as
      | WritingEntryRow
      | undefined;
  }

  /** Returns true if the entry is now graded. */
  async gradeWritingEntry(id: number, enrollmentId: number): Promise<boolean> {
    const entry = this.getWritingEntry(id, enrollmentId);
    if (!entry) return false;
    if (entry.feedback_json) return true;
    const prompt = JSON.parse(entry.prompt_json) as {
      target: string;
      native: string;
      level: number;
    };
    const text = entry.user_text;
    if (!this.callManager) return false;
    const ctx = this.promptCtx(this.langForEnrollment(entry.enrollment_id));
    const feedback = await this.callManager.generateJSON({
      system: writingGradeSystem(ctx, prompt.level ?? 1),
      prompt: writingGradePrompt(ctx, prompt.level ?? 1, prompt.target, prompt.native, text),
      schema: WritingFeedbackSchema,
    });
    this.db
      .prepare('UPDATE writing_entries SET feedback_json=? WHERE id=?')
      .run(JSON.stringify(feedback), id);
    const score = Math.round((feedback.score / 5) * 100);
    if (entry.session_id !== null) {
      this.db.prepare('UPDATE sessions SET write_score=? WHERE id=?').run(score, entry.session_id);
    }
    return true;
  }

  // ---- Speaking (§8.3) ----

  createFreeSpeechAttempt(
    enrollmentId: number,
    sessionId: number | null,
    pack: Pick<ContentPack, 'speaking_prompt' | 'level'>,
  ): number {
    const res = this.db
      .prepare(
        'INSERT INTO speaking_attempts (enrollment_id, session_id, mode, prompt_json, audio_path, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        enrollmentId,
        sessionId,
        'free_speech',
        JSON.stringify({ ...pack.speaking_prompt, level: pack.level }),
        null,
        new Date().toISOString(),
      );
    return Number(res.lastInsertRowid);
  }

  createReadAloudAttempt(
    enrollmentId: number,
    sessionId: number | null,
    target: string,
    transcript: string,
    score: number,
  ): number {
    const res = this.db
      .prepare(
        'INSERT INTO speaking_attempts (enrollment_id, session_id, mode, prompt_json, transcript, feedback_json, score, created_at) VALUES (?,?,?,?,?,NULL,?,?)',
      )
      .run(
        enrollmentId,
        sessionId,
        'read_aloud',
        JSON.stringify({ target }),
        transcript,
        score,
        new Date().toISOString(),
      );
    return Number(res.lastInsertRowid);
  }

  getSpeakingAttempt(id: number, enrollmentId: number): SpeakingAttemptRow | undefined {
    return this.db.prepare('SELECT * FROM speaking_attempts WHERE id=? AND enrollment_id=?').get(id, enrollmentId) as
      | SpeakingAttemptRow
      | undefined;
  }

  setAttemptAudioPath(id: number, enrollmentId: number, audioPath: string): void {
    this.db
      .prepare('UPDATE speaking_attempts SET audio_path=? WHERE id=? AND enrollment_id=?')
      .run(audioPath, id, enrollmentId);
  }

  /** Returns true if the attempt now has feedback. */
  async gradeSpeakingAttempt(id: number, enrollmentId: number): Promise<boolean> {
    const attempt = this.getSpeakingAttempt(id, enrollmentId);
    if (!attempt || attempt.mode !== 'free_speech') return false;
    if (attempt.feedback_json) return true;
    const audioPath = attempt.audio_path;
    if (!audioPath || !fs.existsSync(audioPath)) {
      // Nothing to grade against yet; stay queued.
      return false;
    }
    const prompt = JSON.parse(attempt.prompt_json ?? '{}') as {
      target: string;
      native: string;
      level: number;
    };
    const ext = path.extname(audioPath).slice(1) || 'webm';
    const wav = await convertToWav16k(fs.readFileSync(audioPath), ext, this.ffmpegPath);
    if (!this.callManager) return false;
    const ctx = this.promptCtx(this.langForEnrollment(attempt.enrollment_id));
    const feedback = await this.callManager.generateJSONFromAudio({
      system: speakingFeedbackSystem(ctx, prompt.level ?? 1),
      prompt: speakingFeedbackPrompt(ctx, prompt.level ?? 1, prompt.target, prompt.native),
      schema: SpeakingFeedbackSchema,
      audio: wav,
      mimeType: 'audio/wav',
    });
    this.db
      .prepare('UPDATE speaking_attempts SET transcript=?, feedback_json=?, score=? WHERE id=?')
      .run(feedback.transcript_target, JSON.stringify(feedback), feedback.score, id);
    const score = Math.round((feedback.score / 5) * 100);
    if (attempt.session_id !== null) {
      this.db.prepare('UPDATE sessions SET speak_score=? WHERE id=?').run(score, attempt.session_id);
    }
    return true;
  }

  /**
   * Transcribe a recording server-side (used by the read-aloud drills so the
   * phone doesn't depend on the flaky Android Web Speech API).
   * Returns the verbatim transcription ('' if no speech was heard).
   */
  async transcribeAudio(audio: Buffer, ext: string, targetLang: string): Promise<string> {
    if (!this.callManager) throw new Error('LLM is not configured, cannot transcribe audio.');
    const profile = this.profileFor(targetLang);
    const wav = await convertToWav16k(audio, ext, this.ffmpegPath);
    const raw = await this.callManager.generateTextFromAudio({
      system: transcribeSystem(profile),
      prompt: transcribePrompt(profile),
      audio: wav,
      mimeType: 'audio/wav',
    });
    const t = raw.replace(/\s+/g, ' ').trim();
    return isUsableTranscript(t, profile) ? t : '';
  }

  // ---- Retry queue (§4.2 #5, #6) ----

  /**
   * Delete a reset enrollment's recordings from disk, and count them.
   *
   * The rows are deleted by the caller; the files are not, because a file
   * outside the database is not removed by a DELETE. The path is re-checked
   * against `recordingsDir` before unlinking: the value comes from a column
   * rather than from a request, but `path.resolve` + a prefix test means a
   * corrupt or hostile row can never make this walk out of the recordings
   * directory and unlink something else.
   */
  cleanupRecordings(enrollmentId: number): { rows: number; files: number } {
    const rows = this.db
      .prepare('SELECT id, audio_path FROM speaking_attempts WHERE enrollment_id=? AND audio_path IS NOT NULL')
      .all(enrollmentId) as Array<{ id: number; audio_path: string }>;
    const root = path.resolve(this.recordingsDir);
    let files = 0;
    for (const r of rows) {
      const full = path.resolve(r.audio_path);
      if (full !== root && !full.startsWith(root + path.sep)) continue;
      try {
        fs.unlinkSync(full);
        files++;
      } catch {
        // Already gone, or in use: the row is being deleted either way.
      }
    }
    return { rows: rows.length, files };
  }

  /**
   * Grade everything still queued, across all accounts.
   *
   * Deployment-wide on purpose: the queue is a property of the instance's LLM
   * budget, not of a session, and it runs at boot before anybody is logged in.
   * Each row is graded in *its own* enrollment's language, resolved from
   * `enrollment_id` — a global default would quietly grade every French learner's
   * backlog against Korean prompts.
   */
  async retryQueued(): Promise<RetryResult> {
    const result: RetryResult = { writing: { tried: 0, graded: 0, failed: 0 }, speaking: { tried: 0, graded: 0, failed: 0 } };
    const writing = this.db
      .prepare('SELECT id, enrollment_id FROM writing_entries WHERE feedback_json IS NULL ORDER BY created_at')
      .all() as Array<{ id: number; enrollment_id: number }>;
    for (const { id, enrollment_id } of writing) {
      result.writing.tried++;
      try {
        if (await this.gradeWritingEntry(id, enrollment_id)) result.writing.graded++;
        else break; // cap reached / permanent failure
      } catch (err) {
        if (err instanceof DailyCapReachedError) break;
        result.writing.failed++;
      }
    }
    const speaking = this.db
      .prepare(
        "SELECT id, enrollment_id FROM speaking_attempts WHERE mode='free_speech' AND feedback_json IS NULL AND audio_path IS NOT NULL ORDER BY created_at",
      )
      .all() as Array<{ id: number; enrollment_id: number }>;
    for (const { id, enrollment_id } of speaking) {
      result.speaking.tried++;
      try {
        if (await this.gradeSpeakingAttempt(id, enrollment_id)) result.speaking.graded++;
        else break;
      } catch (err) {
        if (err instanceof DailyCapReachedError) break;
        result.speaking.failed++;
      }
    }
    return result;
  }
}