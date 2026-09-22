import { DatabaseSync } from 'node:sqlite';
import { todayString } from '../dates.js';
import {
  DailyCapReachedError,
  InvalidJSONError,
  isRetryable,
} from './errors.js';
import { GenerateAudioOptions, GenerateOptions, LLMProvider } from './provider.js';

const JSON_REMINDER =
  '\n\n(Previous attempt had invalid JSON. Return valid JSON only, no markdown, no prose outside the JSON.)';

const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Exponential backoff with jitter (ms). */
function backoff(attempt: number): number {
  const base = 1000 * 2 ** attempt;
  return Math.round(base + Math.random() * base);
}

export interface CallStats {
  callsToday: number;
  cap: number;
  lastError: string | null;
}

export interface CallManagerOptions {
  backoff?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wraps an LLM provider with the §4.2 budget/retry rules:
 * daily cap tracked in `llm_usage`, exponential backoff on 429/5xx,
 * one retry with a JSON reminder on invalid JSON.
 */
export class CallManager {
  lastError: string | null = null;

  private backoff: (attempt: number) => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(
    private provider: LLMProvider,
    private db: DatabaseSync,
    private cap: number,
    private getTz: () => string,
    opts: CallManagerOptions = {},
  ) {
    this.backoff = opts.backoff ?? backoff;
    this.sleep = opts.sleep ?? sleep;
  }

  get providerName(): string {
    return this.provider.name;
  }
  get providerModel(): string {
    return this.provider.model;
  }

  stats(): CallStats {
    const today = todayString(this.getTz());
    const row = this.db
      .prepare('SELECT calls FROM llm_usage WHERE date = ?')
      .get(today) as { calls: number } | undefined;
    return { callsToday: row?.calls ?? 0, cap: this.cap, lastError: this.lastError };
  }

  generateJSON<T>(opts: GenerateOptions<T>): Promise<T> {
    return this.run((reminder) =>
      this.provider.generateJSON({
        system: opts.system,
        prompt: opts.prompt + (reminder ?? ''),
        schema: opts.schema,
      }),
    );
  }

  generateJSONFromAudio<T>(opts: GenerateAudioOptions<T>): Promise<T> {
    return this.run((reminder) =>
      this.provider.generateJSONFromAudio({
        system: opts.system,
        prompt: opts.prompt + (reminder ?? ''),
        schema: opts.schema,
        audio: opts.audio,
        mimeType: opts.mimeType,
      }),
    );
  }

  callsToday(): number {
    return this.stats().callsToday;
  }

  private consumeBudget(): void {
    const today = todayString(this.getTz());
    const row = this.db.prepare('SELECT calls FROM llm_usage WHERE date = ?').get(today) as
      | { calls: number }
      | undefined;
    const calls = row?.calls ?? 0;
    if (calls >= this.cap) throw new DailyCapReachedError(this.cap);
    this.db
      .prepare(
        `INSERT INTO llm_usage (date, calls) VALUES (?, 1)
         ON CONFLICT(date) DO UPDATE SET calls = calls + 1`,
      )
      .run(today);
  }

  private logError(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    if (!(err instanceof DailyCapReachedError)) {
      console.warn(`[llm] call failed: ${this.lastError}`);
    }
  }

  private async run<T>(call: (reminder: string | null) => Promise<T>): Promise<T> {
    this.consumeBudget();
    let reminder: string | null = null;
    let jsonRetried = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await call(reminder);
      } catch (err) {
        if (err instanceof InvalidJSONError && !jsonRetried) {
          // Retry once with a "valid JSON only" reminder appended to the prompt.
          jsonRetried = true;
          reminder = JSON_REMINDER;
          this.lastError = err.message;
          continue;
        }
        this.logError(err);
        if (isRetryable(err) && attempt < MAX_RETRIES) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw err;
      }
    }
    throw new Error('unreachable');
  }
}