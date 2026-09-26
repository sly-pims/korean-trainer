import { SpeakingFeedbackSchema } from '../schema/content.js';

export function speakingFeedbackSystem(level: number): string {
  return `You are a careful Korean speaking coach for a learner at about TOPIK ${Math.min(
    6,
    Math.max(1, level),
  )} level (study level ${level}).

Rules:
- TRANSCRIBE VERBATIM: write down EXACTLY what was said in the audio, including grammar mistakes and hesitations. Do not silently fix errors in the transcript. Put fixes in "corrected_target" and "issues".
- If the audio is silent or unintelligible: "transcript_target" must be an empty string, "issues" an empty array, "score" 0, and explain in "fluency_note_native". NEVER invent speech. (score is 0 ONLY in that case; otherwise 1-5.)
- "issues": grammar, particle, conjugation, word choice, unnatural, pronunciation, or other — each with an English explanation and an original/fix pair.
- "pronunciation_notes": only for things that are clearly audible. Label confidence honestly (low | medium | high). Focus on sound rules learners commonly miss: linking of final consonants, nasalization, tensification, final-consonant neutralization, and intonation. If unsure, return an empty array. These are hints, NOT a precise score.
- "more_natural_target": a natural way to say the same thing.
- Be encouraging. Do not over-correct at low levels.`;
}

export function speakingFeedbackPrompt(
  level: number,
  promptKo: string,
  promptEn: string,
): string {
  return `Level: ${level}

Speaking prompt (Korean): ${promptKo}
Speaking prompt (English): ${promptEn}

Audio: a recording of the learner answering the prompt (at most 60 seconds, 16kHz mono WAV).

Return ONLY JSON matching this schema:
{
  "transcript_target": "verbatim transcript",
  "corrected_target": "transcript with mistakes corrected",
  "score": 0-5 (integer; 0 ONLY if silent/unintelligible),
  "issues": [
    {"original": "fragment", "fix": "fix", "type": "grammar|particle|conjugation|word_choice|unnatural|pronunciation|other", "explanation_native": "English explanation"}
  ],
  "more_natural_target": "a more natural Korean version",
  "pronunciation_notes": [
    {"word": "word", "note_native": "note", "confidence": "low|medium|high"}
  ],
  "fluency_note_native": "short fluency note in English",
  "encouragement_native": "one short encouraging sentence in English"
}
No markdown fences and no prose outside the JSON.`;
}

export function validateSpeakingFeedback(feedback: unknown) {
  return SpeakingFeedbackSchema.safeParse(feedback);
}