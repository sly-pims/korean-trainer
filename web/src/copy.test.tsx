import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { interpolate, useCopy, SERVER_ERROR_KEYS } from './copy';
import type { CopyKey } from './copy';
import { ApiError } from './api';
import en from '../../config/copy/en.json';
import ko from '../../config/copy/ko.json';
import { ERROR_CODES as SERVER_ERROR_CODES } from '../../server/src/errors';

type Tree = { [k: string]: string | Tree };

function flat(value: Tree, prefix = ''): [string, string][] {
  return Object.entries(value).flatMap(([k, v]) =>
    v !== null && typeof v === 'object' ? flat(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v as string]],
  );
}

describe('interpolate', () => {
  it('substitutes named placeholders', () => {
    expect(interpolate('Level {level} · {count} questions', { level: 'TOPIK 3', count: 4 })).toBe(
      'Level TOPIK 3 · 4 questions',
    );
  });

  it('substitutes a placeholder more than once', () => {
    expect(interpolate('{word} and again {word}', { word: 'apple' })).toBe('apple and again apple');
  });

  it('leaves the template alone when given no vars', () => {
    expect(interpolate('Level {level}')).toBe('Level {level}');
  });

  it('leaves an unsupplied placeholder visible rather than blanking it', () => {
    // A missing var used to be able to render "Level ·" with the label
    // dangling, which reads as a broken string in any language.
    expect(interpolate('Level {level} · {count}', { count: 2 })).toBe('Level {level} · 2');
  });

  it('does not touch braces that are not placeholders', () => {
    expect(interpolate('use {a, b} and {x}', { x: '1' })).toBe('use {a, b} and 1');
  });

  it('renders numbers as given, not as a locale-grouped string', () => {
    // 1200 must not become "1,200" mid-sentence, because the surrounding
    // template is what the locale's own number formatting belongs to.
    expect(interpolate('{n} saved', { n: 1200 })).toBe('1200 saved');
  });
});

describe('locale files', () => {
  const enFlat = flat(en as Tree);
  const koFlat = flat(ko as Tree);

  it('have the same key set', () => {
    // The server has the same assertion; this one fails closer to the mistake.
    expect(koFlat.map(([k]) => k).sort()).toEqual(enFlat.map(([k]) => k).sort());
  });

  it('have no empty values', () => {
    for (const [key, value] of enFlat) expect(value.trim(), key).not.toBe('');
    for (const [key, value] of koFlat) expect(value.trim(), key).not.toBe('');
  });

  it('use the same placeholders in every locale', () => {
    // A key that interpolates in English but not in Korean silently drops the
    // value, e.g. "Write your own sentence in " with no language name.
    const placeholders = (s: string) =>
      [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
    for (const [key, enValue] of enFlat) {
      const koValue = koFlat.find(([k]) => k === key)?.[1];
      if (koValue === undefined) continue;
      expect(placeholders(koValue), key).toEqual(placeholders(enValue));
    }
  });

  it('keeps the Korean locale free of stray Latin words that should be Korean', () => {    // Latin is legitimate for product names, BCP-47 tags and numerals, so this
    // only flags a whole space-separated English word that has no business in a
    // Korean UI string. It is a review aid, not a proof of translation quality.
    const offenders: string[] = [];
    for (const [key, value] of koFlat) {
      for (const word of value.split(/\s+/)) {
        if (/^[A-Za-z]{4,}[.,!?)]?$/.test(word)) offenders.push(`${key}: ${word}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no key that nothing in the app references', () => {
    // Dead copy is not harmless: it is a translation nobody maintains and a
    // stale promise that the screen it was written for still exists. Two kinds
    // of reference count — a literal `t('...')` and a typed indirection, like the
    // skill labels in Progress that go through a CopyKey-typed array.
    const sources = [__dirname, path.join(__dirname, 'components'), path.join(__dirname, 'screens')]
      .flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []))
      .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
      .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'))
      .join('\n');

    const referenced = new Set<string>();
    // Both quote styles: a plain `t('x.y')` and a `label="speak.playPassage"`
    // copy-key prop.
    for (const m of sources.matchAll(/['"]([a-z][A-Za-z]*(?:\.[A-Za-z]+)*)['"]/g)) referenced.add(m[1]!);
    // `appName` and `appTagline` are the only keys with no section, and they are
    // read off the hook rather than through t().
    referenced.add('appName');
    referenced.add('appTagline');

    const orphans = enFlat.map(([k]) => k).filter((k) => !referenced.has(k));
    expect(orphans).toEqual([]);
  });
});

describe('CopyKey', () => {
  it('accepts a known key', () => {
    // A compile-time assertion: if CopyKey were not derived from en.json, or a
    // section were renamed, this stops compiling.
    const key: CopyKey = 'session.writeOwn';
    expect(key).toBe('session.writeOwn');
  });
});

describe('serverError', () => {
  // Exercised through the hook's default context, which is the bundled English
  // tree. That keeps `makeT`/`makeServerError` private and still covers the
  // fallback chain that decides what a learner actually reads.
  function englishServerError() {
    return renderHook(() => useCopy()).result.current.serverError;
  }

  it('translates a known code and keeps the server message out of the UI', () => {
    const err = new ApiError(400, 'voice ko-KR-SunHiNeural is not allowed for fr-FR', 'unknown_voice');
    const out = englishServerError()(err);
    expect(out).toBe((en as Tree as { error: Tree }).error.unknownVoice);
    // The specific-but-English server text must not be what the user reads.
    expect(out).not.toMatch(/not allowed/);
  });

  it('maps every server code to a copy key, in both locales, with no orphans', () => {
    // The exact invariant. Note the naming differs on purpose: server codes are
    // snake_case tokens, copy keys are camelCase, so this compares the *map*,
    // not the two name sets.
    const mapped = Object.values(SERVER_ERROR_KEYS).sort();
    // `flat` on the subtree yields bare leaf names, so re-attach the prefix the
    // map stores.
    const section = (tree: Tree, name: string): string[] =>
      flat(tree[name] as Tree)
        .map(([k]) => `${name}.${k}`)
        .sort();
    expect(section(en as Tree, 'error')).toEqual(mapped);
    expect(section(ko as Tree, 'error')).toEqual(mapped);
  });

  it('translates every code the server can emit', () => {
    for (const code of SERVER_ERROR_CODES) {
      const out = englishServerError()(new ApiError(400, 'raw server text', code));
      expect(out, code).toMatch(/\S/);
      expect(out, code).not.toBe('raw server text');
    }
  });

  it('falls back to the server message for a code this bundle does not know', () => {
    // A newer server can add a code before the client is rebuilt. Showing the
    // server's specific message beats showing a raw status line.
    const err = new ApiError(400, 'the moon is in the wrong phase', 'a_code_from_the_future');
    expect(englishServerError()(err)).toBe('the moon is in the wrong phase');
  });

  it('falls back to generic copy when there is no code and no useful message', () => {
    const generic = (en as unknown as { common: Record<string, string> }).common.error;
    expect(englishServerError()(new ApiError(502, 'HTTP 502'))).toBe(generic);
    expect(englishServerError()(new Error('boom'))).toBe(generic);
    expect(englishServerError()('not even an error')).toBe(generic);
  });
});
