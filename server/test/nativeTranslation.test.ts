import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CallManager } from '../src/llm/callManager.js';
import { REPO_ROOT } from '../src/config.js';
import { ContentService } from '../src/services/content.js';
import { FakeProvider } from './helpers/fakeProvider.js';
import { cleanupTempArtifacts, makeTestApp, type TestApp } from './fixtures.js';

let app: TestApp;

beforeEach(async () => {
  app = await makeTestApp({ targetLangs: 'ko,fr,en', uiLangs: 'en,ko,fr' });
});

afterEach(() => cleanupTempArtifacts());

describe('native-language lesson explanations', () => {
  it('translates seed explanations for the learner and caches them without changing target text', async () => {
    const passage = app.db
      .prepare("SELECT id, payload_json FROM passages WHERE target_lang='en' ORDER BY id LIMIT 1")
      .get() as { id: number; payload_json: string };
    const original = JSON.parse(passage.payload_json) as import('../src/schema/content.js').ContentPack;
    const provider = new FakeProvider();
    provider.data = {
      passage_native: 'Traduction du passage',
      sentences: original.sentences.map(() => ({ native: 'Phrase traduite' })),
      glossary: original.glossary.map(() => ({ meaning_native: 'Définition traduite' })),
      questions: original.questions.map(() => ({
        q_native: 'Question traduite ?',
        explanation_native: 'Explication traduite.',
      })),
      writing_prompt: { native: 'Consigne traduite.', target_grammar: 'Grammaire traduite' },
      speaking_prompt: { native: 'Question orale traduite ?' },
    };
    const manager = new CallManager(provider, app.db, 20, () => 'Pacific/Auckland');
    const content = new ContentService(app.db, () => 'Pacific/Auckland', manager, app.cfg.langs, REPO_ROOT);

    const frenchPack = await content.nativePack(passage.id, 'fr', original);
    expect(frenchPack.passage_target).toBe(original.passage_target);
    expect(frenchPack.questions[0]?.q_target).toBe(original.questions[0]?.q_target);
    expect(frenchPack.passage_native).toBe('Traduction du passage');
    expect(frenchPack.glossary[0]?.meaning_native).toBe('Définition traduite');
    expect(frenchPack.questions[0]?.explanation_native).toBe('Explication traduite.');

    const cached = await content.nativePack(passage.id, 'fr', original);
    expect(cached.passage_native).toBe('Traduction du passage');
    expect(provider.calls).toBe(1);
  });
});
