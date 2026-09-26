import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CallManager } from '../llm/callManager.js';
import { DailyCapReachedError } from '../llm/errors.js';
import { writingGradePrompt, writingGradeSystem } from '../prompts/writingGrade.js';
import { speakingFeedbackPrompt, speakingFeedbackSystem } from '../prompts/speakingFeedback.js';
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
  session_id: number | null;
  prompt_json: string;
  user_text: string;
  feedback_json: string | null;
  score: number | null;
  created_at: string;
}

interface SpeakingAttemptRow {
  id: number;
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
  ) {}

  // ---- Writing (§8.2) ----

  createWritingEntry(sessionId: number, pack: ContentPack, userText: string): number {
    const res = this.db
      .prepare(
        'INSERT INTO writing_entries (session_id, prompt_json, user_text, created_at) VALUES (?,?,?,?)',
      )
      .run(
        sessionId,
        JSON.stringify({ ...pack.writing_prompt, level: pack.level }),
        userText,
        new Date().toISOString(),
      );
    return Number(res.lastInsertRowid);
  }

  getWritingEntry(id: number): WritingEntryRow | undefined {
    return this.db.prepare('SELECT * FROM writing_entries WHERE id=?').get(id) as unknown as
      | WritingEntryRow
      | undefined;
  }

  /** Returns true if the entry is now graded. */
  async gradeWritingEntry(id: number): Promise<boolean> {
    const entry = this.getWritingEntry(id);
    if (!entry) return false;
    if (entry.feedback_json) return true;
    const prompt = JSON.parse(entry.prompt_json) as {
      target: string;
      native: string;
      level: number;
    };
    const text = entry.user_text;
    if (!this.callManager) return false;
    const feedback = await this.callManager.generateJSON({
      system: writingGradeSystem(prompt.level ?? 1),
      prompt: writingGradePrompt(prompt.level ?? 1, prompt.target, prompt.native, text),
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
    sessionId: number | null,
    pack: Pick<ContentPack, 'speaking_prompt' | 'level'>,
  ): number {
    const res = this.db
      .prepare(
        'INSERT INTO speaking_attempts (session_id, mode, prompt_json, audio_path, created_at) VALUES (?,?,?,?,?)',
      )
      .run(
        sessionId,
        'free_speech',
        JSON.stringify({ ...pack.speaking_prompt, level: pack.level }),
        null,
        new Date().toISOString(),
      );
    return Number(res.lastInsertRowid);
  }

  createReadAloudAttempt(
    sessionId: number | null,
    target: string,
    transcript: string,
    score: number,
  ): number {
    const res = this.db
      .prepare(
        'INSERT INTO speaking_attempts (session_id, mode, prompt_json, transcript, feedback_json, score, created_at) VALUES (?,?,?,?,NULL,?,?)',
      )
      .run(sessionId, 'read_aloud', JSON.stringify({ target }), transcript, score, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  getSpeakingAttempt(id: number): SpeakingAttemptRow | undefined {
    return this.db.prepare('SELECT * FROM speaking_attempts WHERE id=?').get(id) as unknown as
      | SpeakingAttemptRow
      | undefined;
  }

  setAttemptAudioPath(id: number, audioPath: string): void {
    this.db.prepare('UPDATE speaking_attempts SET audio_path=? WHERE id=?').run(audioPath, id);
  }

  /** Returns true if the attempt now has feedback. */
  async gradeSpeakingAttempt(id: number): Promise<boolean> {
    const attempt = this.getSpeakingAttempt(id);
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
    const feedback = await this.callManager.generateJSONFromAudio({
      system: speakingFeedbackSystem(prompt.level ?? 1),
      prompt: speakingFeedbackPrompt(prompt.level ?? 1, prompt.target, prompt.native),
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
   * Returns the verbatim Korean transcription ('' if no speech was heard).
   * The target sentence is deliberately NOT included in the prompt: Gemini
   * anchors to it and echoes it back for silent audio, faking a 100% match.
   */
  async transcribeAudio(audio: Buffer, ext: string): Promise<string> {
    if (!this.callManager) throw new Error('LLM is not configured, cannot transcribe audio.');
    const wav = await convertToWav16k(audio, ext, this.ffmpegPath);
    const raw = await this.callManager.generateTextFromAudio({
      system:
        'You are a meticulous Korean speech transcriber. Transcribe exactly what is spoken, verbatim, including errors and hesitations. If there is no human speech in the audio, reply with the single word EMPTY.',
      prompt: 'Transcribe the spoken Korean audio verbatim.',
      audio: wav,
      mimeType: 'audio/wav',
    });
    const t = raw.replace(/\s+/g, ' ').trim();
    // Plain-text mode can return prose like "The audio is silent." — without
    // any Hangul there is no transcription to grade.
    if (!t || /^EMPTY$/i.test(t) || !/[\uac00-\ud7af]/.test(t)) return '';
    return t;
  }

  // ---- Retry queue (§4.2 #5, #6) ----

  async retryQueued(): Promise<RetryResult> {
    const result: RetryResult = { writing: { tried: 0, graded: 0, failed: 0 }, speaking: { tried: 0, graded: 0, failed: 0 } };
    const writing = this.db
      .prepare('SELECT id FROM writing_entries WHERE feedback_json IS NULL ORDER BY created_at')
      .all() as Array<{ id: number }>;
    for (const { id } of writing) {
      result.writing.tried++;
      try {
        if (await this.gradeWritingEntry(id)) result.writing.graded++;
        else break; // cap reached / permanent failure
      } catch (err) {
        if (err instanceof DailyCapReachedError) break;
        result.writing.failed++;
      }
    }
    const speaking = this.db
      .prepare(
        "SELECT id FROM speaking_attempts WHERE mode='free_speech' AND feedback_json IS NULL AND audio_path IS NOT NULL ORDER BY created_at",
      )
      .all() as Array<{ id: number }>;
    for (const { id } of speaking) {
      result.speaking.tried++;
      try {
        if (await this.gradeSpeakingAttempt(id)) result.speaking.graded++;
        else break;
      } catch (err) {
        if (err instanceof DailyCapReachedError) break;
        result.speaking.failed++;
      }
    }
    return result;
  }
}