import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLanguageProfile, type LanguageProfile } from '../src/lang.js';
import { contentPackPrompt, contentPackSystem, contentPackWithTopicPrompt } from '../src/prompts/contentPack.js';
import { writingGradePrompt, writingGradeSystem } from '../src/prompts/writingGrade.js';
import { speakingFeedbackPrompt, speakingFeedbackSystem } from '../src/prompts/speakingFeedback.js';
import { wordSuggestPrompt, wordSuggestSystem } from '../src/prompts/wordSuggest.js';
import { isUsableTranscript, transcribePrompt, transcribeSystem } from '../src/prompts/transcribe.js';
import type { PromptContext } from '../src/prompts/context.js';

// One deployment prompts in several languages. The failure this file exists to
// catch is a prompt that mentions the wrong language: a French learner graded
// with a prompt that says TOPIK and 해요체, or a Korean learner told that
// French liaison is what they are getting wrong. Both directions are asserted.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const ko = loadLanguageProfile(repoRoot, 'ko');
const fr = loadLanguageProfile(repoRoot, 'fr');
const profiles: Record<string, LanguageProfile> = { ko, fr };

/** Everything a single language's prompts can say, for one target language. */
function allPrompts(ctx: PromptContext): Record<string, string> {
  return {
    contentPackSystem: contentPackSystem(ctx, 2),
    contentPackPrompt: contentPackPrompt(ctx, 2),
    contentPackWithTopicPrompt: contentPackWithTopicPrompt(ctx, 2, 'food', ['family', 'work']),
    writingGradeSystem: writingGradeSystem(ctx, 2),
    writingGradePrompt: writingGradePrompt(ctx, 2, 'prompt target text', 'prompt native text', 'learner text'),
    speakingFeedbackSystem: speakingFeedbackSystem(ctx, 2),
    speakingFeedbackPrompt: speakingFeedbackPrompt(ctx, 2, 'prompt target text', 'prompt native text'),
    wordSuggestSystem: wordSuggestSystem(ctx, 2),
    wordSuggestPrompt: wordSuggestPrompt(ctx, 5, 'food', ['existing']),
    transcribeSystem: transcribeSystem(ctx.profile),
    transcribePrompt: transcribePrompt(ctx.profile),
  };
}

/**
 * Markers that would betray a prompt built for the wrong language. Split by
 * direction: things only a Korean prompt may say, and things only a French one
 * may. Case-insensitive, and the Korean entries include romanised and Hangul
 * forms because a leak can arrive in any of them.
 *
 * These are deliberately *language-exclusive* terms. Generic English phonology
 * words are not usable as leak detectors: Korean final-consonant linking really
 * is called liaison, and French really does have silent final consonants, so
 * both languages legitimately use that vocabulary in English. Only terms that
 * name one language's identity or one language's distinctive sound rules can
 * prove a prompt came from the wrong profile.
 */
const KOREAN_ONLY = ['Korean', 'TOPIK', 'Hangul', '해요', 'tensification', 'romanisation'];
const FRENCH_ONLY = ['French', 'Français', 'CEFR', 'nasal vowels', 'vous', 'tutoiement'];

/** Language-independent scaffolding that must never appear in any prompt. */
const STALE = [
  'passage_ko',
  'passage_en',
  'title_ko',
  'meaning_en',
  'q_ko',
  'q_en',
  'explanation_en',
  'corrected_ko',
  'more_natural_ko',
  'transcript_ko',
  'note_en',
  'example_ko',
  'example_en',
];

describe('prompt language isolation', () => {
  describe('the language profiles do not describe each other', () => {
    // Checked on the config itself, so a wrong profile cannot be laundered by
    // prompt assembly.
    it('the Korean profile names no French', () => {
      const text = [ko.learnerProfile, ko.styleGuidance, ko.pronunciationGuidance, ko.exampleGuidance].join(' ');
      for (const marker of FRENCH_ONLY) {
        expect(text.toLowerCase()).not.toContain(marker.toLowerCase());
      }
    });

    it('the French profile names no Korean', () => {
      const text = [fr.learnerProfile, fr.styleGuidance, fr.pronunciationGuidance, fr.exampleGuidance].join(' ');
      for (const marker of KOREAN_ONLY) {
        expect(text.toLowerCase()).not.toContain(marker.toLowerCase());
      }
    });

    it('each profile describes its own language', () => {
      expect(ko.pronunciationGuidance).toMatch(/korean/i);
      expect(fr.pronunciationGuidance).toMatch(/french/i);
      expect(ko.styleGuidance).toMatch(/korean/i);
      expect(fr.styleGuidance).toMatch(/french/i);
    });
  });

  describe('a Korean target never mentions French', () => {
    const prompts = allPrompts({ profile: ko });

    for (const [name, text] of Object.entries(prompts)) {
      for (const marker of FRENCH_ONLY) {
        it(`${name} is free of "${marker}"`, () => {
          expect(text.toLowerCase()).not.toContain(marker.toLowerCase());
        });
      }
    }
  });

  describe('a French target never mentions Korean', () => {
    const prompts = allPrompts({ profile: fr });

    for (const [name, text] of Object.entries(prompts)) {
      for (const marker of KOREAN_ONLY) {
        it(`${name} is free of "${marker}"`, () => {
          expect(text.toLowerCase()).not.toContain(marker.toLowerCase());
        });
      }
    }
  });

  describe('every prompt names the language it is for', () => {
    for (const code of Object.keys(profiles)) {
      const profile = profiles[code];
      const prompts = allPrompts({ profile });
      for (const [name, text] of Object.entries(prompts)) {
        it(`${code}/${name} says "${profile.name}"`, () => {
          expect(text).toContain(profile.name);
        });
      }
    }
  });

  describe('no prompt uses a stale field name', () => {
    for (const code of Object.keys(profiles)) {
      const prompts = allPrompts({ profile: profiles[code] });
      for (const [name, text] of Object.entries(prompts)) {
        for (const marker of STALE) {
          it(`${code}/${name} is free of "${marker}"`, () => {
            expect(text).not.toContain(marker);
          });
        }
      }
    }
  });

  describe('the JSON shape handed to the model is language-neutral', () => {    it('asks for target/native, never for a language code', () => {
      for (const code of Object.keys(profiles)) {
        const text = contentPackPrompt({ profile: profiles[code] }, 2);
        expect(text).toContain('"sentences": [{"target": "string", "native": "string"}]');
        expect(text).toContain('"writing_prompt": {"target": "string", "native": "string"');
        expect(text).toContain('"speaking_prompt": {"target": "string", "native": "string"}');
        // The old template told the model to emit ko/en pairs, which the zod
        // schema then rejected.
        expect(text).not.toContain('"ko"');
        expect(text).not.toContain('"en"');
      }
    });
  });

  describe('each target names itself and its own level scale', () => {
    it('Korean prompts say Korean and TOPIK', () => {
      const text = contentPackSystem({ profile: ko }, 2);
      expect(text).toContain('Korean');
      expect(text).toContain('TOPIK 2');
    });

    it('French prompts say French and CEFR', () => {
      const text = contentPackSystem({ profile: fr }, 2);
      expect(text).toContain('French');
      expect(text).toContain('CEFR A2');
    });

    it('every level name comes from the profile, at every level', () => {
      for (const code of Object.keys(profiles)) {
        const profile = profiles[code];
        for (let level = 1; level <= 6; level++) {
          const text = contentPackSystem({ profile }, level);
          expect(text).toContain(profile.levels[String(level)].name);
        }
      }
    });
  });

  describe('the native side is the enrollment language, not the target', () => {
    it('defaults to English, so a Korean prompt asks for English glosses', () => {
      const text = contentPackSystem({ profile: ko }, 1);
      expect(text).toContain('every "_native" field in English');
    });

    it('follows an explicit native language', () => {
      const text = contentPackSystem({ profile: fr, native: { code: 'ko', name: 'Korean' } }, 1);
      expect(text).toContain('every "_native" field in Korean');
      // The target is still French; only the gloss language changed.
      expect(text).toContain('Write every "_target" field in French');
    });

    it('a Korean target with a French native language is still a Korean prompt', () => {
      const text = contentPackSystem({ profile: ko, native: { code: 'fr', name: 'French' } }, 1);
      expect(text).toContain('Write every "_target" field in Korean');
      expect(text).toContain('every "_native" field in French');
      // The French here is the learner's own language, which is legitimate.
      expect(text).toContain('TOPIK 1');
    });

    it('grades a French passage with the native language the learner reads', () => {
      const text = writingGradePrompt(
        { profile: fr, native: { code: 'ko', name: 'Korean' } },
        2,
        'Bonjour',
        '안녕하세요',
        '안녕히 가세요',
      );
      expect(text).toContain('Writing prompt (French): Bonjour');
      expect(text).toContain('Writing prompt (Korean): 안녕하세요');
      expect(text).toContain('explanation in Korean');
    });
  });

  describe('phonology guidance comes from the profile', () => {
    it('a Korean speaking prompt gets Korean sound rules', () => {
      const text = speakingFeedbackSystem({ profile: ko }, 2);
      expect(text).toContain(ko.pronunciationGuidance);
      expect(text).toContain('tensification');
    });

    it('a French speaking prompt gets French sound rules', () => {
      const text = speakingFeedbackSystem({ profile: fr }, 2);
      expect(text).toContain(fr.pronunciationGuidance);
      expect(text).toContain('nasal vowels');
    });
  });

  describe('example length is measured in the target language', () => {
    it('a Korean vocabulary prompt counts syllables', () => {
      expect(wordSuggestSystem({ profile: ko }, 2)).toContain(ko.exampleGuidance);
    });

    it('a French vocabulary prompt counts words', () => {
      const text = wordSuggestSystem({ profile: fr }, 2);
      expect(text).toContain(fr.exampleGuidance);
      // "syllables" is a Korean-specific unit here and would mislead a French
      // generator.
      expect(text).not.toContain('syllable');
    });
  });

  describe('topics come from the profile', () => {
    it('each prompt lists its own language topics', () => {
      expect(contentPackSystem({ profile: ko }, 1)).toContain(ko.topics.join(', '));
      expect(contentPackSystem({ profile: fr }, 1)).toContain(fr.topics.join(', '));
    });
  });

  describe('transcription silence detection follows the profile', () => {
    it('rejects an empty or whitespace reply for any language', () => {
      for (const code of Object.keys(profiles)) {
        expect(isUsableTranscript('', profiles[code])).toBe(false);
        expect(isUsableTranscript('   \n ', profiles[code])).toBe(false);
      }
    });

    it('rejects the profile silence marker, in any case or with punctuation', () => {
      for (const code of Object.keys(profiles)) {
        const p = profiles[code];
        for (const reply of ['EMPTY', 'empty', ' Empty ', 'EMPTY.']) {
          expect(isUsableTranscript(reply, p)).toBe(false);
        }
      }
    });

    it('keeps a real transcript', () => {
      expect(isUsableTranscript('저는 밥을 먹어요', ko)).toBe(true);
      expect(isUsableTranscript("J'ai mangé", fr)).toBe(true);
    });

    it('rejects text in a script the target language does not use', () => {
      // A Korean transcript for a French learner is prose about the audio, or a
      // transcript in the wrong language; either way it is not gradeable here.
      expect(isUsableTranscript('저는 밥을 먹어요', fr)).toBe(false);
    });

    it('names the silence marker the profile asks for', () => {
      expect(transcribeSystem(ko)).toContain(`single word ${ko.silenceMarkers[0]}`);
      expect(transcribeSystem(fr)).toContain(`single word ${fr.silenceMarkers[0]}`);
    });
  });
});
