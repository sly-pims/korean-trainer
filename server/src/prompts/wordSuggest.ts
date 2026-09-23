import { LEVEL_GUIDE } from './contentPack.js';
import { WordSuggestionsSchema } from '../schema/content.js';

// §8.4 new word suggestions (user-initiated, counts against the daily LLM cap)

export function wordSuggestSystem(level: number): string {
  const guide = LEVEL_GUIDE[level] ?? LEVEL_GUIDE[1];
  return `You are a Korean vocabulary tutor choosing new words for a learner at level ${level} of 6.

Learner profile: speaks, writes and reads Korean at about TOPIK 1-2; not an absolute beginner.
Vocabulary and grammar for this level: ${guide.grammar}

Rules:
- Default to polite 해요체; only use other registers at levels 5-6.
- Prefer high-frequency, useful everyday vocabulary the learner will actually meet.
- Each suggestion has a dictionary-form lemma, its word class, a one-line English meaning, and one short, natural example sentence in Korean with an English gloss.
- Keep examples short (under ~15 syllables) and at or slightly above the learner's level.
- If a topic is given, bias word choice toward it but do not force awkward fits.
- Value naturalness and correctness. If unsure, choose simpler, more common words.`;
}

export function wordSuggestPrompt(topic: string | null, count: number, knownLemmas: string[]): string {
  const topicBlock = topic ? `\nTopic preference: ${topic}` : '';
  const knownBlock = knownLemmas.length
    ? `\nAlready known lemmas (DO NOT repeat any of these): ${knownLemmas.join(', ')}`
    : '';
  return `
Suggest ${count} new Korean words appropriate to the learner's level.
${topicBlock}${knownBlock}

Return ONLY a JSON object matching this schema:
{
  "words": [
    {"lemma": "string", "pos": "noun | verb | adjective | adverb | particle | other", "meaning_en": "string", "example_ko": "string", "example_en": "string"}
  ]
}

Output must be the JSON object and nothing else (no markdown fences, no comments).`;
}

export function validateWordSuggestions(pack: unknown) {
  return WordSuggestionsSchema.safeParse(pack);
}