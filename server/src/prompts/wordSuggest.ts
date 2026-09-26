import { WordSuggestionsSchema } from '../schema/content.js';
import type { PromptContext } from './context.js';
import { levelGuide, levelName, nativeOf } from './context.js';

// §8.4 New word suggestions (user-initiated, counts against the daily LLM cap).

export function wordSuggestSystem(ctx: PromptContext, level: number): string {
  const native = nativeOf(ctx);
  const guide = levelGuide(ctx, level);
  return `You are a ${ctx.profile.name} vocabulary tutor choosing new words for a learner at ${levelName(ctx, level)} (level ${level} of 6).

Learner profile: ${ctx.profile.learnerProfile}
Vocabulary and grammar for this level: ${guide.grammar}

Rules:
- ${ctx.profile.styleGuidance}
- Every "lemma" and "example_target" must be in ${ctx.profile.name}. Every "meaning_native" and "example_native" must be in ${native.name}.
- Prefer high-frequency, useful everyday vocabulary the learner will actually meet.
- Each suggestion has a dictionary-form lemma, its word class, a one-line ${native.name} meaning, and one short, natural example sentence in ${ctx.profile.name} with an ${native.name} gloss.
- ${ctx.profile.exampleGuidance}
- Each example sentence must use only the suggested word plus simple, common vocabulary the learner already knows — no rare words, and no typos, spacing mistakes or garbled text.
- If a topic is given, bias word choice toward it but do not force awkward fits. Available topics: ${ctx.profile.topics.join(', ')}.
- Value naturalness and correctness. If unsure, choose simpler, more common words.`;
}

export function wordSuggestPrompt(
  ctx: PromptContext,
  count: number,
  topic: string | null,
  knownLemmas: string[],
): string {
  const topicBlock = topic ? `\nTopic preference: ${topic}` : '';
  const knownBlock = knownLemmas.length
    ? `\nAlready known lemmas (DO NOT repeat any of these): ${knownLemmas.join(', ')}`
    : '';
  return `
Suggest ${count} new ${ctx.profile.name} words appropriate to the learner's level.
${topicBlock}${knownBlock}

Return ONLY a JSON object matching this schema:
{
  "words": [
    {"lemma": "string in ${ctx.profile.name}", "pos": "noun | verb | adjective | adverb | particle | other", "meaning_native": "string in ${nativeOf(ctx).name}", "example_target": "string in ${ctx.profile.name}", "example_native": "string in ${nativeOf(ctx).name}"}
  ]
}

Output must be the JSON object and nothing else (no markdown fences, no comments).`;
}

export function validateWordSuggestions(pack: unknown) {
  return WordSuggestionsSchema.safeParse(pack);
}
