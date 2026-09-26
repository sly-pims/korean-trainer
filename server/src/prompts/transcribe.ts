import type { LanguageProfile } from '../lang.js';
import { hasTargetScript, isSilenceReply } from '../lang.js';

// Server-side transcription for the read-aloud drills, so the phone does not
// depend on the flaky Android Web Speech API.
//
// Extracted from review.ts so the prompt is a profile-templated prompt like
// every other one, rather than a string literal buried in a service.

/**
 * The target sentence is deliberately NOT included in the prompt: the model
 * anchors to it and echoes it back for silent audio, faking a 100% match.
 */
export function transcribeSystem(profile: LanguageProfile): string {
  return `You are a meticulous ${profile.name} speech transcriber. Transcribe exactly what is spoken, verbatim, including errors and hesitations. The audio will be in ${profile.name}; the transcription must be in ${profile.name}. If there is no human speech in the audio, reply with the single word ${profile.silenceMarkers[0]}.`;
}

export function transcribePrompt(profile: LanguageProfile): string {
  return `Transcribe the spoken ${profile.name} audio verbatim.`;
}

/**
 * Whether a plain-text model reply is a usable transcript.
 *
 * Plain-text mode can return prose about the audio ("The audio is silent.")
 * instead of a transcript. Three things mean "no speech": nothing, an explicit
 * silence marker, or text written in a script the target language does not use.
 */
export function isUsableTranscript(text: string, profile: LanguageProfile): boolean {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return false;
  if (isSilenceReply(trimmed, profile)) return false;
  return hasTargetScript(trimmed, profile);
}
