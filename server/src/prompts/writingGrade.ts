import { WritingFeedbackSchema } from '../schema/content.js';

export function writingGradeSystem(level: number): string {
  return `You are a kind, specific Korean writing tutor for a learner at about TOPIK ${Math.min(
    6,
    Math.max(1, level),
  )} level (the learner's configured study level is ${level}).

Rules:
- Be encouraging and specific. Explain issues in English.
- Correct particles, spelling, spacing, conjugation, word choice and naturalness, but DO NOT over-correct at a low level: leave minor, acceptable alternatives alone.
- If the text is already good, return an empty "issues" array and a high score.
- "more_natural_ko": a slightly more natural way to say the same thing (Korean).
- Focus feedback on issues the learner can fix at their current level.`;
}

export function writingGradePrompt(level: number, promptKo: string, promptEn: string, userText: string): string {
  return `Level: ${level}

Writing prompt (Korean): ${promptKo}
Writing prompt (English): ${promptEn}

The learner's text:
"""${userText}"""

Return ONLY JSON matching this schema:
{
  "corrected_ko": "corrected Korean text",
  "score": 1-5 (integer),
  "issues": [
    {"original": "problematic fragment", "fix": "suggested fix", "type": "spelling|spacing|particle|conjugation|word_choice|unnatural|other", "explanation_en": "English explanation"}
  ],
  "more_natural_ko": "a more natural Korean version",
  "encouragement_en": "one short encouraging sentence in English"
}
If there are no issues, "issues" is an empty array and score is 4 or 5.
No markdown fences and no prose outside the JSON.`;
}

export function validateWritingFeedback(feedback: unknown) {
  return WritingFeedbackSchema.safeParse(feedback);
}