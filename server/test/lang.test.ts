import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyKeys, languageProfileSchema, LanguageConfigError, loadCopy, loadLanguageProfile } from '../src/lang.js';
import { copyFor, langFor, loadConfig, REPO_ROOT } from '../src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = { NODE_ENV: 'test', SESSION_SECRET: 'test-secret-123' };

describe('language profiles', () => {
  const codes = ['ko', 'fr'];

  it('every profile loads and passes its own schema', () => {
    for (const code of codes) {
      const p = loadLanguageProfile(repoRoot, code);
      expect(languageProfileSchema.safeParse(p).success).toBe(true);
    }
  });

  it('a profile whose file name disagrees with its code is rejected', () => {
    expect(() => loadLanguageProfile(repoRoot, 'zz')).toThrow(LanguageConfigError);
  });

  it('defaultVoice is always in voices', () => {
    for (const code of codes) {
      const p = loadLanguageProfile(repoRoot, code);
      expect(p.voices).toContain(p.defaultVoice);
    }
  });

  it('every voice looks like a BCP-47 Edge neural voice for the locale', () => {
    for (const code of codes) {
      const p = loadLanguageProfile(repoRoot, code);
      for (const v of p.voices) {
        expect(v.startsWith(`${p.locale}-`)).toBe(true);
        expect(v.endsWith('Neural')).toBe(true);
      }
    }
  });

  it('scriptPattern compiles and matches the language, not the other one', () => {
    const ko = loadLanguageProfile(repoRoot, 'ko');
    const fr = loadLanguageProfile(repoRoot, 'fr');
    expect(new RegExp(ko.scriptPattern).test('안녕하세요')).toBe(true);
    expect(new RegExp(ko.scriptPattern).test('bonjour')).toBe(false);
    expect(new RegExp(fr.scriptPattern).test('bonjour à tous')).toBe(true);
    // accented Latin must count as French script
    expect(new RegExp(fr.scriptPattern).test('àéèêëîïôûùüÿçœ')).toBe(true);
    expect(new RegExp(fr.scriptPattern).test('안녕하세요')).toBe(false);
  });

  it('defines all six levels and a level guide for each', () => {
    for (const code of codes) {
      const p = loadLanguageProfile(repoRoot, code);
      for (const level of ['1', '2', '3', '4', '5', '6']) {
        expect(p.levels[level]?.name).toBeTruthy();
        expect(p.levelGuide[level]?.passage).toBeTruthy();
        expect(p.levelGuide[level]?.grammar).toBeTruthy();
      }
    }
  });

  it('two languages do not share a level scale name', () => {
    // Guards against copy-pasting a profile and forgetting to localise it.
    expect(loadLanguageProfile(repoRoot, 'ko').levelScaleName).not.toBe(
      loadLanguageProfile(repoRoot, 'fr').levelScaleName,
    );
  });

  it('seedFile points at a real path for languages that have content', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    for (const code of codes) {
      const p = loadLanguageProfile(repoRoot, code);
      // Only assert the path is well-formed; a language may be configured
      // before its seed content is written.
      expect(p.seedFile).toMatch(/^seed\/passages\.[a-z-]+\.json$/);
      if (fs.existsSync(path.join(repoRoot, p.seedFile))) {
        JSON.parse(fs.readFileSync(path.join(repoRoot, p.seedFile), 'utf8'));
      }
    }
  });
});

describe('UI copy', () => {
  const langs = ['en', 'ko'];

  it('every copy set loads', () => {
    for (const l of langs) expect(loadCopy(repoRoot, l).appName).toBeTruthy();
  });

  it('all copy sets have identical key sets, so no locale can drift', () => {
    const [ref, ...rest] = langs.map((l) => ({ l, keys: copyKeys(loadCopy(repoRoot, l)).sort() }));
    for (const other of rest) {
      const missing = ref.keys.filter((k) => !other.keys.includes(k));
      const extra = other.keys.filter((k) => !ref.keys.includes(k));
      expect({ l: other.l, missing, extra }).toEqual({ l: other.l, missing: [], extra: [] });
    }
  });

  it('no copy value is left as an empty string', () => {
    for (const l of langs) {
      const walk = (v: unknown, p: string): void => {
        if (v && typeof v === 'object') {
          for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
            walk(child, p ? `${p}.${k}` : k);
          }
        } else if (typeof v === 'string') {
          expect(v.trim(), `${l}:${p}`).not.toBe('');
        }
      };
      walk(loadCopy(repoRoot, l), '');
    }
  });
});

describe('loadConfig', () => {
  it('defaults to Korean only, with no env configuration', () => {
    const cfg = loadConfig(base);
    expect(cfg.supportedTargetLangs).toEqual(['ko']);
    expect([...cfg.langs.keys()]).toEqual(['ko']);
  });

  it('defaults to the copy sets that ship with the repo', () => {
    // Guards the deploy gate: an existing .env predates these variables, so the
    // app must still boot without them.
    const cfg = loadConfig(base);
    expect([...cfg.copies.keys()]).toEqual(['en', 'ko']);
    expect(cfg.defaultUiLang).toBe('en');
  });

  it('loads every requested language and copy set', () => {
    const cfg = loadConfig({
      ...base,
      SUPPORTED_TARGET_LANGS: 'ko,fr',
      SUPPORTED_UI_LANGS: 'en,ko',
      DEFAULT_UI_LANG: 'en',
    });
    expect([...cfg.langs.keys()]).toEqual(['ko', 'fr']);
    expect([...cfg.copies.keys()]).toEqual(['en', 'ko']);
  });

  it('rejects an unknown language code with a readable error', () => {
    expect(() => loadConfig({ ...base, SUPPORTED_TARGET_LANGS: 'de' })).toThrow(
      /languages\.de\.json/,
    );
  });

  it('rejects a DEFAULT_UI_LANG that is not offered', () => {
    expect(() =>
      loadConfig({ ...base, SUPPORTED_UI_LANGS: 'en,ko', DEFAULT_UI_LANG: 'fr' }),
    ).toThrow(/DEFAULT_UI_LANG/);
  });

  it('rejects an explicitly emptied SUPPORTED_UI_LANGS', () => {
    expect(() => loadConfig({ ...base, SUPPORTED_UI_LANGS: '  ' })).toThrow(/SUPPORTED_UI_LANGS/);
  });
});

describe('langFor / copyFor', () => {
  const cfg = loadConfig({ ...base, SUPPORTED_TARGET_LANGS: 'ko,fr', SUPPORTED_UI_LANGS: 'en,ko' });

  it('resolves a configured language', () => {
    expect(langFor(cfg, 'fr').code).toBe('fr');
    expect(copyFor(cfg, 'ko').appName).toBeTruthy();
  });

  it('names the missing config file for an unconfigured language', () => {
    expect(() => langFor(cfg, 'de')).toThrow(/languages\.de\.json/);
    expect(() => copyFor(cfg, 'de')).toThrow(/copy\/de\.json/);
  });
});
