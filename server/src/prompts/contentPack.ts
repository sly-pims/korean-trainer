import { ContentPackSchema } from '../schema/content.js';

export interface LevelsGuide {
  [level: number]: { passage: string; grammar: string };
}

// §6.2 level guide, used inside the generation prompt.
export const LEVEL_GUIDE: LevelsGuide = {
  1: { passage: '3-5 short sentences', grammar: 'Present tense, basic particles, everyday nouns/verbs' },
  2: { passage: '5-7 sentences', grammar: 'Past tense, -고, -아/어서, common connectors' },
  3: { passage: '7-10 sentences', grammar: '-(으)ㄴ/는 modifiers, -(으)면, -지만, daily-life topics' },
  4: { passage: '10-14 sentences', grammar: 'Reported speech, -는데, passive/causative basics' },
  5: { passage: '14-20 sentences', grammar: 'Abstract topics, news-style register' },
  6: { passage: '20+ sentences', grammar: 'Idioms, formal writing, opinion pieces' },
};

export const TOPIC_LIST = [
  'family',
  'food',
  'travel',
  'work',
  'weather',
  'hobbies',
  'health',
  'shopping',
  'news',
];

const SCHEMA_DESCRIPTION = `{
  "level": <number 1-6>,
  "topic": "string",
  "title_ko": "string",
  "passage_ko": "string",
  "passage_en": "string",
  "sentences": [{"ko": "string", "en": "string"}],
  "glossary": [{"surface": "string", "lemma": "string", "pos": "verb|noun|adjective|adverb|particle|expression|conjunction|determiner|numeral|counter", "meaning_en": "string"}],
  "questions": [{"q_ko": "string", "q_en": "string", "choices": ["4 strings"], "answer_index": 0, "explanation_en": "string"}],
  "writing_prompt": {"ko": "string", "en": "string", "target_grammar": "string"},
  "speaking_prompt": {"ko": "string", "en": "string"}
}`;

export function contentPackSystem(level: number): string {
  const guide = LEVEL_GUIDE[level] ?? LEVEL_GUIDE[1];
  return `You are a Korean-language tutor creating one daily practice pack for a learner.

Learner profile: speaks, writes and reads Korean at about TOPIK 1-2; reads at roughly a young child's level. NOT an absolute beginner. Content must be worth their time and build reading confidence.

Difficulty level for this pack: ${level} of 6.
- Passage length: ${guide.passage}
- Grammar and vocabulary: ${guide.grammar}

Rules:
- Natural, everyday Korean. Default to polite 해요체 (해요 ending). Only use other registers at levels 5-6.
- The passage must be interesting, concrete and natural — everyday life topics adapted to the target level.
- EVERY word in the passage that could be unfamiliar at this level must appear in "glossary". The "surface" must match the text exactly (same spelling) so tap-to-translate works.
- Exactly 3 questions, each with exactly 4 choices and exactly one correct answer. Questions check real understanding of the passage.
- "sentences": 3-5 short sentences FROM the passage, each under about 20 syllables, suitable for dictation and reading aloud. Their "ko" must appear verbatim inside "passage_ko".
- "speaking_prompt": a simple open question or scenario related to the passage that a learner can answer in 20-40 seconds (e.g. "What did you do last weekend?").
- "writing_prompt.target_grammar": name the grammar point to practice (e.g. "past tense -았/었어요").
- Value accuracy: correct Korean, correct particles, natural word order. If unsure, choose simpler phrasing.`;
}

export function contentPackPrompt(level: number): string {
  return `
Return ONLY a JSON object matching this schema:
${SCHEMA_DESCRIPTION}

Output must be the JSON object and nothing else (no markdown fences, no comments).`;
}

export function contentPackWithTopicPrompt(level: number, topic: string, recentTopics: string[]): string {
  const topicBlock = topic && topic !== 'any'
    ? `\nTopic for this pack: ${topic}`
    : '';
  const avoid = recentTopics.length
    ? `\nAvoid repeating these recently-used topics: ${recentTopics.join(', ')}`
    : '';
  return `
Difficulty: level ${level} of 6.${topicBlock}${avoid}

Return ONLY a JSON object matching this schema:
${SCHEMA_DESCRIPTION}

Output must be the JSON object and nothing else (no markdown fences, no comments).`;
}

export function validateContentPack(pack: unknown) {
  return ContentPackSchema.safeParse(pack);
}