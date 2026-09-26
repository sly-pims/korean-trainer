import { describe, expect, it } from 'vitest';
import { filterGlossaryByPassage } from '../src/services/glossary.js';
import type { ContentPack } from '../src/schema/content.js';

const pack = {
  level: 1,
  topic: 'test',
  title_target: 't',
  passage_target: '저는 밥을 먹어요.',
  passage_native: 'e',
  sentences: [{ target: '저는 밥을 먹어요.', native: 'e' }],
  questions: [
    { q_target: 'q', q_native: 'q', choices: ['a', 'b', 'c', 'd'], answer_index: 0, explanation_native: 'x' },
    { q_target: 'q', q_native: 'q', choices: ['a', 'b', 'c', 'd'], answer_index: 0, explanation_native: 'x' },
    { q_target: 'q', q_native: 'q', choices: ['a', 'b', 'c', 'd'], answer_index: 0, explanation_native: 'x' },
  ],
  writing_prompt: { target: 'w', native: 'w', target_grammar: 'g' },
  speaking_prompt: { target: 's', native: 's' },
} as ContentPack;

describe('filterGlossaryByPassage (§8.1)', () => {
  it('keeps entries whose surface appears in the passage', () => {
    const pass = { ...pack, glossary: [{ surface: '밥', lemma: '밥', pos: 'noun', meaning_native: 'rice' }] };
    const out = filterGlossaryByPassage(pass);
    expect(out.glossary).toHaveLength(1);
  });

  it('drops entries whose surface is not in the passage', () => {
    const pass = {
      ...pack,
      glossary: [
        { surface: '밥', lemma: '밥', pos: 'noun', meaning_native: 'rice' },
        { surface: '없는표현', lemma: '없음', pos: 'noun', meaning_native: 'nope' },
      ],
    };
    const out = filterGlossaryByPassage(pass);
    expect(out.glossary).toHaveLength(1);
    expect(out.glossary[0].surface).toBe('밥');
  });

  it('does not fail when all entries are dropped', () => {
    const pass = { ...pack, glossary: [{ surface: 'zzz', lemma: 'zzz', pos: 'noun', meaning_native: 'x' }] };
    const out = filterGlossaryByPassage(pass);
    expect(out.glossary).toHaveLength(0);
  });
});