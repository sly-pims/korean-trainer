// Neural Korean TTS via Edge (free, no API key). Streams MP3 from a short-lived
// WebSocket session. A fresh instance per request keeps it concurrency-safe.

import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { Readable } from 'node:stream';

export const DEFAULT_VOICE = 'ko-KR-SunHiNeural';
const MAX_TEXT = 400;

// Only these are passed to Edge; anything else falls back to the default.
const KNOWN_VOICES = new Set([
  'ko-KR-SunHiNeural',
  'ko-KR-InJoonNeural',
  'ko-KR-HyunsuNeural',
  'ko-KR-JiMinNeural',
  'ko-KR-SeoHyeonNeural',
  'ko-KR-YuJinNeural',
]);

export interface TtsParams {
  text: string;
  voice?: string;
  /** Signed offset from normal, e.g. -25 (slower) .. +50 (faster). */
  rate?: number;
}

export function validVoice(voice: string | undefined): boolean {
  return KNOWN_VOICES.has(voice ?? '');
}

export async function synthesize({ text, voice = DEFAULT_VOICE, rate = 0 }: TtsParams): Promise<Readable> {
  if (!text.trim() || text.length > MAX_TEXT) throw new Error('bad tts text');
  const voiceName = validVoice(voice) ? (voice as string) : DEFAULT_VOICE;
  const locale = voiceName.slice(0, 5);
  const offset = Math.max(-50, Math.min(100, Math.round(rate)));
  const rateStr = offset === 0 ? '0%' : `${offset > 0 ? '+' : ''}${offset}%`;

  const attempt = async (): Promise<Readable> => {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3, { voiceLocale: locale });
    const { audioStream } = tts.toStream(text, { rate: rateStr });
    audioStream.once('error', () => tts.close());
    return audioStream;
  };

  // The Edge service is unofficial; retry once before surfacing an error.
  try {
    return await attempt();
  } catch (first) {
    try {
      return await attempt();
    } catch {
      throw first;
    }
  }
}