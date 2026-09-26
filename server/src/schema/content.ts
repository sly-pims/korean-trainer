import { z } from 'zod';

// Content pack and feedback shapes.
//
// Field names say *which side of the pair* they hold rather than which language:
// `_target` is the language being learned, `_native` is the learner's own
// language. Which codes those map to is per-enrollment, not per-build.

export const GlossaryEntrySchema = z.object({
  surface: z.string().min(1),
  lemma: z.string().min(1),
  pos: z.string().min(1),
  meaning_native: z.string().min(1),
});

export const QuestionSchema = z.object({
  q_target: z.string().min(1),
  q_native: z.string().min(1),
  choices: z.array(z.string()).length(4),
  answer_index: z.number().int().min(0).max(3),
  explanation_native: z.string().min(1),
});

// §8.1 Daily content pack
export const ContentPackSchema = z.object({
  level: z.number().int().min(1).max(6),
  topic: z.string().min(1),
  title_target: z.string().min(1),
  passage_target: z.string().min(1),
  passage_native: z.string().min(1),
  sentences: z.array(z.object({ target: z.string().min(1), native: z.string().min(1) })).min(1),
  glossary: z.array(GlossaryEntrySchema),
  questions: z.array(QuestionSchema).length(3),
  writing_prompt: z.object({
    target: z.string().min(1),
    native: z.string().min(1),
    target_grammar: z.string(),
  }),
  speaking_prompt: z.object({ target: z.string().min(1), native: z.string().min(1) }),
});

// §8.2 Writing grading
export const WritingFeedbackSchema = z.object({
  corrected_target: z.string(),
  score: z.number().int().min(1).max(5),
  issues: z.array(
    z.object({
      original: z.string(),
      fix: z.string(),
      type: z.enum(['spelling', 'spacing', 'particle', 'conjugation', 'word_choice', 'unnatural', 'other']),
      explanation_native: z.string(),
    }),
  ),
  more_natural_target: z.string(),
  encouragement_native: z.string(),
});

// §8.3 Speaking feedback (audio in)
export const SpeakingFeedbackSchema = z.object({
  transcript_target: z.string(),
  corrected_target: z.string(),
  score: z.number().int().min(0).max(5),
  issues: z.array(
    z.object({
      original: z.string(),
      fix: z.string(),
      type: z.enum(['grammar', 'particle', 'conjugation', 'word_choice', 'unnatural', 'pronunciation', 'other']),
      explanation_native: z.string(),
    }),
  ),
  more_natural_target: z.string(),
  pronunciation_notes: z.array(
    z.object({
      word: z.string(),
      note_native: z.string(),
      confidence: z.enum(['low', 'medium', 'high']),
    }),
  ),
  fluency_note_native: z.string(),
  encouragement_native: z.string(),
});

export type ContentPack = z.infer<typeof ContentPackSchema>;
export type WritingFeedback = z.infer<typeof WritingFeedbackSchema>;
export type SpeakingFeedback = z.infer<typeof SpeakingFeedbackSchema>;

// §8.4 New word suggestions
export const WordSuggestionSchema = z.object({
  lemma: z.string().min(1),
  pos: z.enum(['noun', 'verb', 'adjective', 'adverb', 'particle', 'other']),
  meaning_native: z.string().min(1),
  example_target: z.string().min(1),
  example_native: z.string().min(1),
});

export const WordSuggestionsSchema = z.object({
  words: z.array(WordSuggestionSchema).min(1).max(10),
});

export type WordSuggestion = z.infer<typeof WordSuggestionSchema>;
