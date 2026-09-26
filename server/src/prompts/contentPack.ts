import { ContentPackSchema } from '../schema/content.js';
import type { PromptContext } from './context.js';
import { inNative, levelGuide, levelName, nativeOf } from './context.js';

// §8.1 Daily content pack.

/**
 * The JSON shape handed to the model.
 *
 * The nested pair keys are `target`/`native` because the model cannot know which
 * codes they are: the same template has to produce a Korean pack with an English
 * gloss and a French pack with a Korean one.
 */
const SCHEMA_DESCRIPTION = `{
  "level": <number 1-6>,
  "topic": "string",
  "title_target": "string",
  "passage_target": "string",
  "passage_native": "string",
  "sentences": [{"target": "string", "native": "string"}],
  "glossary": [{"surface": "string", "lemma": "string", "pos": "verb|noun|adjective|adverb|particle|expression|conjunction|determiner|numeral|counter", "meaning_native": "string"}],
  "questions": [{"q_target": "string", "q_native": "string", "choices": ["4 strings"], "answer_index": 0, "explanation_native": "string"}],
  "writing_prompt": {"target": "string", "native": "string", "target_grammar": "string"},
  "speaking_prompt": {"target": "string", "native": "string"}
}`;

/** The target language, by its own name, for use inside an instruction. */
function target(ctx: PromptContext): string {
  return ctx.profile.name;
}

export function contentPackSystem(ctx: PromptContext, level: number): string {
  const guide = levelGuide(ctx, level);
  const native = nativeOf(ctx);
  const topicList = ctx.profile.topics.join(', ');
  return `You are a ${target(ctx)}-language tutor creating one daily practice pack for a learner.

The learner is studying ${target(ctx)}. Write every "_target" field in ${target(ctx)}, and every "_native" field in ${native.name}.

Learner profile: ${ctx.profile.learnerProfile}

Difficulty level for this pack: ${levelName(ctx, level)} (level ${level} of 6).
- Passage length: ${guide.passage}
- Grammar and vocabulary: ${guide.grammar}

Rules:
- ${ctx.profile.styleGuidance}
- The passage must be interesting, concrete and natural — everyday life topics adapted to the target level. Draw the topic from: ${topicList}.
- EVERY word in the passage that could be unfamiliar at this level must appear in "glossary". The "surface" must match the text exactly (same spelling and spacing) so tap-to-translate works.
- Exactly 3 questions, each with exactly 4 choices and exactly one correct answer. Questions check real understanding of the passage.
- "sentences": 3-5 short sentences FROM the passage, each short enough to dictate and read aloud, in the order they appear. Every "sentences[].target" must appear verbatim inside "passage_target".
- "speaking_prompt": a simple open question or scenario related to the passage that a learner can answer in 20-40 seconds.
- "writing_prompt.target_grammar": name the grammar point to practise, in ${native.name}.
- Every "_native" value must be in ${native.name} — never in ${target(ctx)}, and never in any other language.
- Value accuracy: correct ${target(ctx)}, correct particles and agreement, natural word order. If unsure, choose simpler phrasing.`;
}

export function contentPackPrompt(ctx: PromptContext, level: number): string {
  return `
Return ONLY a JSON object matching this schema:
${SCHEMA_DESCRIPTION}

Every "_target" value must be in ${target(ctx)}. Every "_native" value must be in ${nativeOf(ctx).name}.

Output must be the JSON object and nothing else (no markdown fences, no comments).`;
}

export function contentPackWithTopicPrompt(
  ctx: PromptContext,
  level: number,
  topic: string,
  recentTopics: string[],
): string {
  const topicBlock =
    topic && topic !== 'any' ? `\nTopic for this pack: ${topic}` : `\nTopic for this pack: any of ${ctx.profile.topics.join(', ')}`;
  const avoid = recentTopics.length
    ? `\nAvoid repeating these recently-used topics: ${recentTopics.join(', ')}`
    : '';
  return `
Difficulty: ${levelName(ctx, level)} (level ${level} of 6).${topicBlock}${avoid}

Return ONLY a JSON object matching this schema:
${SCHEMA_DESCRIPTION}

Every "_target" value must be in ${target(ctx)}. Every "_native" value must be in ${nativeOf(ctx).name}.

Output must be the JSON object and nothing else (no markdown fences, no comments).`;
}

export function validateContentPack(pack: unknown) {
  return ContentPackSchema.safeParse(pack);
}

/** Re-exported so callers that only need the shared phrasing can reach it. */
export { inNative };
