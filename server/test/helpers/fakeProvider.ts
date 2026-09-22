import { ZodType } from 'zod';
import type { LLMProvider } from '../../src/llm/provider.js';
import {
  InvalidJSONError,
  ProviderError,
  RateLimitError,
  ServerError,
} from '../../src/llm/errors.js';

export type FakeMode = 'ok' | 'rate-limit' | 'server-error' | 'bad-json-then-ok' | 'auth-error' | 'always-bad';

/** A fake provider that mimics Gemini's JSON behavior for unit tests. */
export class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  readonly model = 'fake-model';
  mode: FakeMode = 'ok';
  data: unknown = {};
  calls = 0;
  /** When set (>0), the next N responses throw (rate-limit/server-error) before succeeding. */
  failuresRemaining = 0;

  async generateJSON<T>(opts: { system: string; prompt: string; schema: ZodType<T> }): Promise<T> {
    return this.respond<T>(opts.schema);
  }

  async generateJSONFromAudio<T>(opts: {
    system: string;
    prompt: string;
    schema: ZodType<T>;
    audio: Buffer;
    mimeType: string;
  }): Promise<T> {
    return this.respond<T>(opts.schema);
  }

  private async respond<T>(schema: ZodType<T>): Promise<T> {
    this.calls++;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      const err = this.mode === 'server-error' ? new ServerError() : new RateLimitError();
      if (this.failuresRemaining === 0) this.mode = 'ok';
      throw err;
    }
    switch (this.mode) {
      case 'rate-limit':
        throw new RateLimitError();
      case 'server-error':
        throw new ServerError();
      case 'auth-error':
        throw new ProviderError('401 auth');
      case 'bad-json-then-ok':
        if (this.calls === 1) throw new InvalidJSONError();
        return schema.parse(this.data);
      case 'always-bad':
        throw new InvalidJSONError();
      default:
        return schema.parse(this.data);
    }
  }
}