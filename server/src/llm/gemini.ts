import { ZodType } from 'zod';
import {
  InvalidJSONError,
  ProviderError,
  QuotaError,
  RateLimitError,
  ServerError,
} from './errors.js';
import { GenerateAudioOptions, GenerateOptions, GenerateTextAudioOptions, LLMProvider } from './provider.js';

// Model names and free quotas change; keep the default in env-config and
// prefer a Flash-Lite class model (most generous free daily allowance).
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

function pickJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const block = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (block) return block[1];
  // Search for the largest balanced {..} region as a last resort.
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === '{') depth++;
      else if (trimmed[i] === '}') {
        depth--;
        if (depth === 0) return trimmed.slice(start, i + 1);
      }
    }
  }
  return text;
}

/**
 * Gemini REST provider with JSON output mode (§4.1). Audio is sent as
 * inline_data base64; the same generateContent endpoint accepts it.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly model: string;

  constructor(
    private apiKey: string,
    model?: string,
    private baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
  ) {
    this.model = model && model.trim() ? model.trim() : DEFAULT_GEMINI_MODEL;
  }

  generateJSON<T>(opts: GenerateOptions<T>): Promise<T> {
    return this.call(opts.system, opts.prompt, opts.schema, undefined);
  }

  generateJSONFromAudio<T>(opts: GenerateAudioOptions<T>): Promise<T> {
    return this.call(opts.system, opts.prompt, opts.schema, {
      buffer: opts.audio,
      mimeType: opts.mimeType,
    });
  }

  generateTextFromAudio(opts: GenerateTextAudioOptions): Promise<string> {
    if (!this.apiKey) {
      throw new QuotaError('No Gemini API key configured');
    }
    const parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> = [
      { text: opts.prompt },
      {
        inline_data: { mime_type: opts.mimeType, data: opts.audio.toString('base64') },
      },
    ];
    const body = {
      system_instruction: { parts: [{ text: opts.system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.1 },
    };
    return this.postAndReadText(this.buildUrl(), body);
  }

  private buildUrl(): string {
    return `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
  }

  private async postAndReadText(url: string, body: Record<string, unknown>): Promise<string> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) throw new RateLimitError(`Gemini 429 (quota/rate limit)`);
    if (res.status === 401 || res.status === 403) {
      throw new QuotaError(`Gemini ${res.status}: API key rejected`);
    }
    if (res.status >= 500) throw new ServerError(`Gemini ${res.status} server error`);
    if (!res.ok) throw new ProviderError(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
  }

  private async call<T>(
    system: string,
    prompt: string,
    schema: ZodType<T>,
    audio?: { buffer: Buffer; mimeType: string },
  ): Promise<T> {
    if (!this.apiKey) {
      throw new QuotaError('No Gemini API key configured');
    }

    const parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> = [
      { text: prompt },
    ];
    if (audio) {
      parts.push({
        inline_data: { mime_type: audio.mimeType, data: audio.buffer.toString('base64') },
      });
    }

    const body = {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.7,
      },
    };

    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 429) throw new RateLimitError(`Gemini 429 (quota/rate limit)`);
    if (res.status === 401 || res.status === 403) {
      throw new QuotaError(`Gemini ${res.status}: API key rejected`);
    }
    if (res.status >= 500) throw new ServerError(`Gemini ${res.status} server error`);
    if (!res.ok) throw new ProviderError(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    if (!text) throw new InvalidJSONError('Gemini returned an empty response');

    let parsed: unknown;
    try {
      parsed = JSON.parse(pickJson(text));
    } catch {
      throw new InvalidJSONError('Gemini returned unparseable JSON');
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new InvalidJSONError(`Gemini JSON failed schema validation: ${result.error.message}`);
    }
    return result.data;
  }
}