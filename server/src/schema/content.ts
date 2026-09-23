import { z } from 'zod';

export const GlossaryEntrySchema = z.object({
  surface: z.string().min(1),
  lemma: z.string().min(1),
  pos: z.string().min(1),
  meaning_en: z.string().min(1),
});

export const QuestionSchema = z.object({
  q_ko: z.string().min(1),
  q_en: z.string().min(1),
  choices: z.array(z.string()).length(4),
  answer_index: z.number().int().min(0).max(3),
  explanation_en: z.string().min(1),
});

// §8.1 Daily content pack
export const ContentPackSchema = z.object({
  level: z.number().int().min(1).max(6),
  topic: z.string().min(1),
  title_ko: z.string().min(1),
  passage_ko: z.string().min(1),
  passage_en: z.string().min(1),
  sentences: z.array(z.object({ ko: z.string().min(1), en: z.string().min(1) })).min(1),
  glossary: z.array(GlossaryEntrySchema),
  questions: z.array(QuestionSchema).length(3),
  writing_prompt: z.object({
    ko: z.string().min(1),
    en: z.string().min(1),
    target_grammar: z.string(),
  }),
  speaking_prompt: z.object({ ko: z.string().min(1), en: z.string().min(1) }),
});

// §8.2 Writing grading
export const WritingFeedbackSchema = z.object({
  corrected_ko: z.string(),
  score: z.number().int().min(1).max(5),
  issues: z.array(
    z.object({
      original: z.string(),
      fix: z.string(),
      type: z.enum(['spelling', 'spacing', 'particle', 'conjugation', 'word_choice', 'unnatural', 'other']),
      explanation_en: z.string(),
    }),
  ),
  more_natural_ko: z.string(),
  encouragement_en: z.string(),
});

// §8.3 Speaking feedback (audio in)
export const SpeakingFeedbackSchema = z.object({
  transcript_ko: z.string(),
  corrected_ko: z.string(),
  score: z.number().int().min(0).max(5),
  issues: z.array(
    z.object({
      original: z.string(),
      fix: z.string(),
      type: z.enum(['grammar', 'particle', 'conjugation', 'word_choice', 'unnatural', 'pronunciation', 'other']),
      explanation_en: z.string(),
    }),
  ),
  more_natural_ko: z.string(),
  pronunciation_notes: z.array(
    z.object({
      word: z.string(),
      note_en: z.string(),
      confidence: z.enum(['low', 'medium', 'high']),
    }),
  ),
  fluency_note_en: z.string(),
  encouragement_en: z.string(),
});

export type ContentPack = z.infer<typeof ContentPackSchema>;
export type WritingFeedback = z.infer<typeof WritingFeedbackSchema>;
export type SpeakingFeedback = z.infer<typeof SpeakingFeedbackSchema>;

// §8.4 New word suggestions
export const WordSuggestionSchema = z.object({
  lemma: z.string().min(1),
  pos: z.enum(['noun', 'verb', 'adjective', 'adverb', 'particle', 'other']),
  meaning_en: z.string().min(1),
  example_ko: z.string().min(1),
  example_en: z.string().min(1),
});

export const WordSuggestionsSchema = z.object({
  words: z.array(WordSuggestionSchema).min(1).max(10),
});

export type WordSuggestion = z.infer<typeof WordSuggestionSchema>;