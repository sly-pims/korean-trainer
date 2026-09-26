import { SpeakingFeedbackSchema } from '../schema/content.js';
import type { PromptContext } from './context.js';
import { levelName, nativeOf } from './context.js';

// §8.3 Speaking feedback (audio in).

export function speakingFeedbackSystem(ctx: PromptContext, level: number): string {
  const native = nativeOf(ctx);
  return `You are a careful ${ctx.profile.name} speaking coach for a learner at about ${levelName(ctx, level)} (study level ${level}).

The learner is speaking ${ctx.profile.name}. Transcriptions and corrections must be in ${ctx.profile.name}; every note, explanation and encouragement must be in ${native.name}.

Rules:
- TRANSCRIBE VERBATIM: write down EXACTLY what was said in the audio, including mistakes and hesitations. Do not silently fix errors in the transcript. Put fixes in "corrected_target" and "issues".
- If the audio is silent or unintelligible: "transcript_target" must be an empty string, "issues" an empty array, "score" 0, and explain in "fluency_note_native". NEVER invent speech. (score is 0 ONLY in that case; otherwise 1-5.)
- "issues": grammar, particle, conjugation, word choice, unnatural, pronunciation, or other — each with an ${native.name} explanation and an original/fix pair.
- "pronunciation_notes": only for things that are clearly audible. Label confidence honestly (low | medium | high). Focus on: ${ctx.profile.pronunciationGuidance} If unsure, return an empty array. These are hints, NOT a precise score.
- "more_natural_target": a natural way to say the same thing, in ${ctx.profile.name}.
- Every "_native" value must be in ${native.name} — never in ${ctx.profile.name}, and never in any other language.
- Be encouraging. Do not over-correct at low levels.`;
}

export function speakingFeedbackPrompt(
  ctx: PromptContext,
  level: number,
  promptTarget: string,
  promptNative: string,
): string {
  const native = nativeOf(ctx);
  return `Level: ${level} (${levelName(ctx, level)})

Speaking prompt (${ctx.profile.name}): ${promptTarget}
Speaking prompt (${native.name}): ${promptNative}

Audio: a recording of the learner answering the prompt (at most 60 seconds, 16kHz mono WAV).

Return ONLY JSON matching this schema:
{
  "transcript_target": "verbatim ${ctx.profile.name} transcript",
  "corrected_target": "transcript with mistakes corrected, in ${ctx.profile.name}",
  "score": 0-5 (integer; 0 ONLY if silent/unintelligible),
  "issues": [
    {"original": "fragment", "fix": "fix", "type": "grammar|particle|conjugation|word_choice|unnatural|pronunciation|other", "explanation_native": "explanation in ${native.name}"}
  ],
  "more_natural_target": "a more natural ${ctx.profile.name} version",
  "pronunciation_notes": [
    {"word": "word", "note_native": "note in ${native.name}", "confidence": "low|medium|high"}
  ],
  "fluency_note_native": "short fluency note in ${native.name}",
  "encouragement_native": "one short encouraging sentence in ${native.name}"
}
No markdown fences and no prose outside the JSON.`;
}

export function validateSpeakingFeedback(feedback: unknown) {
  return SpeakingFeedbackSchema.safeParse(feedback);
}
