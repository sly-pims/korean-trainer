// Neural TTS via Edge (free, no API key). Streams MP3 from a short-lived
// WebSocket session. A fresh instance per request keeps it concurrency-safe.

import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { Readable } from 'node:stream';
import { resolveVoice } from '../lang.js';
import type { LanguageProfile } from '../lang.js';

const MAX_TEXT = 400;

export interface TtsParams {
  text: string;
  /** The language being spoken. Supplies the voice allowlist and the locale. */
  profile: LanguageProfile;
  /** A voice from `profile.voices`. Omit for the profile's default. */
  voice?: string | null;
  /** Signed offset from normal, e.g. -25 (slower) .. +50 (faster). */
  rate?: number;
}

export async function synthesize({
  text,
  profile,
  voice,
  rate = 0,
}: TtsParams): Promise<Readable> {
  if (!text.trim() || text.length > MAX_TEXT) throw new Error('bad tts text');
  // Throws UnknownVoiceError for a voice from another language; the route turns
  // that into a 400 rather than quietly speaking with the wrong voice.
  const voiceName = resolveVoice(profile, voice);
  const offset = Math.max(-50, Math.min(100, Math.round(rate)));
  const rateStr = offset === 0 ? '0%' : `${offset > 0 ? '+' : ''}${offset}%`;

  const attempt = async (): Promise<Readable> => {
    const tts = new MsEdgeTTS();
    // The locale comes from the profile. It used to be sliced off the front of
    // the voice name, which happens to work only because Edge names every voice
    // `<locale>-<Name>Neural` — a convention of that list, not a guarantee, and
    // one the profile is already authoritative about.
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3, {
      voiceLocale: profile.locale,
    });
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