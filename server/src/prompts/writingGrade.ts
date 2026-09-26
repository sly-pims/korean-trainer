import { WritingFeedbackSchema } from '../schema/content.js';
import type { PromptContext } from './context.js';
import { levelName, nativeOf } from './context.js';

// §8.2 Writing grading.

export function writingGradeSystem(ctx: PromptContext, level: number): string {
  const native = nativeOf(ctx);
  return `You are a kind, specific ${ctx.profile.name} writing tutor for a learner at about ${levelName(ctx, level)} (their configured study level is ${level}).

The learner is studying ${ctx.profile.name}. Corrected and suggested text must be in ${ctx.profile.name}; every explanation and every encouragement must be in ${native.name}.

Rules:
- Be encouraging and specific. Explain issues ${native.name}.
- Correct spelling, spacing, particles, conjugation, word choice and naturalness, but DO NOT over-correct at a low level: leave minor, acceptable alternatives alone.
- The prompt text is a MODEL sentence showing the target grammar. The learner must write their OWN sentence about their own life (family, hobbies, plans, etc.) and is not expected to copy the model. Reward personal, correct use of the target pattern — never penalize the learner for writing something different from the model.
- If the text is already good, return an empty "issues" array and a high score.
- "more_natural_target": a slightly more natural way to say the same thing, in ${ctx.profile.name}.
- "issues[].explanation_native" and "encouragement_native": in ${native.name}.
- Focus feedback on issues the learner can fix at their current level.`;
}

export function writingGradePrompt(
  ctx: PromptContext,
  level: number,
  promptTarget: string,
  promptNative: string,
  userText: string,
): string {
  const native = nativeOf(ctx);
  return `Level: ${level} (${levelName(ctx, level)})

Writing prompt (${ctx.profile.name}): ${promptTarget}
Writing prompt (${native.name}): ${promptNative}

The learner's text:
"""${userText}"""

Return ONLY JSON matching this schema:
{
  "corrected_target": "corrected ${ctx.profile.name} text",
  "score": 1-5 (integer),
  "issues": [
    {"original": "problematic fragment", "fix": "suggested fix", "type": "spelling|spacing|particle|conjugation|word_choice|unnatural|other", "explanation_native": "explanation in ${native.name}"}
  ],
  "more_natural_target": "a more natural ${ctx.profile.name} version",
  "encouragement_native": "one short encouraging sentence in ${native.name}"
}
If there are no issues, "issues" is an empty array and score is 4 or 5.
No markdown fences and no prose outside the JSON.`;
}

export function validateWritingFeedback(feedback: unknown) {
  return WritingFeedbackSchema.safeParse(feedback);
}
