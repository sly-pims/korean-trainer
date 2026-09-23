import { ZodType } from 'zod';

export interface GenerateOptions<T> {
  system: string;
  prompt: string;
  schema: ZodType<T>;
}

export interface GenerateAudioOptions<T> extends GenerateOptions<T> {
  audio: Buffer;
  mimeType: string;
}

export interface GenerateTextAudioOptions {
  system: string;
  prompt: string;
  audio: Buffer;
  mimeType: string;
}

/**
 * Provider abstraction (§4.1). Adding another provider (OpenRouter, Groq,
 * local Ollama…) means adding one file that implements this interface and
 * wiring it up in a small factory.
 */
export interface LLMProvider {
  generateJSON<T>(opts: GenerateOptions<T>): Promise<T>;
  generateJSONFromAudio<T>(opts: GenerateAudioOptions<T>): Promise<T>;
  /** Plain (non-JSON) transcription/free-text from audio. */
  generateTextFromAudio(opts: GenerateTextAudioOptions): Promise<string>;
  readonly name: string;
  readonly model: string;
}