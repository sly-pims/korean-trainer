import { describe, expect, it } from 'vitest';
import { WordSuggestionsSchema } from '../src/schema/content.js';

describe('§8.4 word suggestions schema', () => {
  it('accepts a well-formed suggestion set', () => {
    const valid = {
      words: [
        {
          lemma: '주말',
          pos: 'noun',
          meaning_en: 'weekend',
          example_ko: '주말에 친구를 만났어요.',
          example_en: 'I met a friend on the weekend.',
        },
      ],
    };
    const parsed = WordSuggestionsSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('caps the count but passes up to 10', () => {
    const words = Array.from({ length: 10 }, (_, i) => ({
      lemma: `단어${i}`,
      pos: 'noun',
      meaning_en: `word ${i}`,
      example_ko: `예문${i}`,
      example_en: `example ${i}`,
    }));
    expect(WordSuggestionsSchema.safeParse({ words }).success).toBe(true);
    const tooMany = WordSuggestionsSchema.safeParse({ words: [...words, words[0]] });
    expect(tooMany.success).toBe(false);
  });

  it('enforces the pos enum', () => {
    const bad = {
      words: [
        {
          lemma: '숫자',
          pos: 'nonexistent',
          meaning_en: 'number',
          example_ko: '숫자',
          example_en: 'number',
        },
      ],
    };
    expect(WordSuggestionsSchema.safeParse(bad).success).toBe(false);
  });
});