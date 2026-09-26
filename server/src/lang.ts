// Language profiles and UI copy, loaded from config/ at boot.
//
// One deployment serves every language listed in SUPPORTED_TARGET_LANGS. A
// target-language profile (config/languages.<code>.json) carries everything
// that differs per language being *learned*: locale, voices, seed file, level
// naming, prompt style, topics, script. A copy set (config/copy/<ui>.json)
// carries everything that differs per language the *interface* is shown in.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const levelSchema = z.object({
  name: z.string().min(1),
  note: z.string(),
});

const levelGuideSchema = z.object({
  passage: z.string().min(1),
  grammar: z.string().min(1),
});

export const languageProfileSchema = z
  .object({
    code: z.string().min(2).max(5),
    name: z.string().min(1),
    endonym: z.string().min(1),
    /** BCP-47 tag used for speech recognition and TTS. */
    locale: z.string().min(2),
    htmlLang: z.string().min(2),
    defaultVoice: z.string().min(1),
    voices: z.array(z.string().min(1)).min(1),
    /** Seed bank for this language, relative to the repo root. */
    seedFile: z.string().min(1),
    /** Name of the level scale, e.g. TOPIK or CEFR. */
    levelScaleName: z.string().min(1),
    levels: z.record(levelSchema),
    levelGuide: z.record(levelGuideSchema),
    /** Described into the generation prompt verbatim. */
    learnerProfile: z.string().min(1),
    styleGuidance: z.string().min(1),
    /**
     * Sound rules a learner of this language commonly misses, described into the
     * speaking-feedback prompt. Must not name another language's phonology.
     */
    pronunciationGuidance: z.string().min(1),
    /** How long a generated example sentence should be, in this language's terms. */
    exampleGuidance: z.string().min(1),
    topics: z.array(z.string().min(1)).min(1),
    /** Used when the database holds no passage for this language yet. */
    fallbacks: z.object({
      speakingPrompt: z.object({ target: z.string().min(1), native: z.string().min(1) }),
    }),
    /** Regex source used to detect that a transcript is in the target script. */
    scriptPattern: z.string().min(1),
    /** Literal replies that mean "no speech was heard". */
    silenceMarkers: z.array(z.string().min(1)).min(1),
  })
  .superRefine((v, ctx) => {
    if (!v.voices.includes(v.defaultVoice)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultVoice'],
        message: `defaultVoice "${v.defaultVoice}" is not in voices`,
      });
    }
    for (const level of ['1', '2', '3', '4', '5', '6']) {
      if (!v.levels[level]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['levels'],
          message: `missing level ${level}`,
        });
      }
      if (!v.levelGuide[level]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['levelGuide'],
          message: `missing levelGuide ${level}`,
        });
      }
    }
  });

export type LanguageProfile = z.infer<typeof languageProfileSchema>;

export const copySchema = z.object({
  appName: z.string().min(1),
  appTagline: z.string(),
  login: z.object({
    title: z.string().min(1),
    tagline: z.string(),
    username: z.string().min(1),
    password: z.string().min(1),
    submit: z.string().min(1),
    error: z.string().min(1),
  }),
  nav: z.object({
    home: z.string().min(1),
    practice: z.string().min(1),
    words: z.string().min(1),
    progress: z.string().min(1),
    history: z.string().min(1),
    settings: z.string().min(1),
  }),
  common: z.object({
    loading: z.string().min(1),
    save: z.string().min(1),
    saved: z.string().min(1),
    cancel: z.string().min(1),
    close: z.string().min(1),
    retry: z.string().min(1),
    back: z.string().min(1),
    next: z.string().min(1),
    done: z.string().min(1),
    none: z.string().min(1),
    error: z.string().min(1),
  }),
});

export type Copy = z.infer<typeof copySchema>;

export class LanguageConfigError extends Error {}

function readJson(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new LanguageConfigError(`cannot read language config: ${file}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new LanguageConfigError(
      `invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function loadLanguageProfile(repoRoot: string, code: string): LanguageProfile {
  const file = path.join(repoRoot, 'config', `languages.${code}.json`);
  const parsed = languageProfileSchema.safeParse(readJson(file));
  if (!parsed.success) {
    throw new LanguageConfigError(
      `invalid config/languages.${code}.json:\n${formatIssues(parsed.error)}`,
    );
  }
  if (parsed.data.code !== code) {
    throw new LanguageConfigError(
      `config/languages.${code}.json declares code "${parsed.data.code}"`,
    );
  }
  return parsed.data;
}

export function loadCopy(repoRoot: string, uiLang: string): Copy {
  const file = path.join(repoRoot, 'config', 'copy', `${uiLang}.json`);
  const parsed = copySchema.safeParse(readJson(file));
  if (!parsed.success) {
    throw new LanguageConfigError(
      `invalid config/copy/${uiLang}.json:\n${formatIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

function formatIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

/** Flatten a copy set to dotted keys, so sets can be compared for parity. */
export function copyKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    copyKeys(v, prefix ? `${prefix}.${k}` : k),
  );
}

export type Langs = Map<string, LanguageProfile>;
export type Copies = Map<string, Copy>;

// ---------------------------------------------------------------------------
// The native side of the pair
// ---------------------------------------------------------------------------

/**
 * The language the learner's own-language text is written in.
 *
 * A `*_target` field is the language being learned, which the language profile
 * describes. A `*_native` field is the learner's own language, which belongs to
 * their *enrollment*, not to the profile — one Korean profile is used by
 * learners whose native language is English, Japanese or anything else. Prompt
 * builders therefore need both, and take the native side as this pair.
 */
export interface NativeLang {
  /** BCP-47-ish code, matching a `config/copy/<code>.json` set. */
  code: string;
  /** English name, used when telling the model which language to answer in. */
  name: string;
}

/** Until enrollments exist, every learner is assumed to read English. */
export const DEFAULT_NATIVE: NativeLang = { code: 'en', name: 'English' };

// ---------------------------------------------------------------------------
// Script detection
// ---------------------------------------------------------------------------

const scriptCache = new Map<string, RegExp>();

function scriptRegExp(pattern: string): RegExp {
  let re = scriptCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern, 'u');
    scriptCache.set(pattern, re);
  }
  return re;
}

/**
 * Whether `text` contains at least one character from the target language's
 * script.
 *
 * Used to tell "the model returned a transcript" from "the model returned prose
 * about the audio". For a non-Latin target this is decisive. For a Latin-script
 * target the pattern is necessarily permissive — French and English share an
 * alphabet — so this only rules out text in a *different* script, not text in
 * the wrong Latin-based language. `isSilenceReply` is the other half of the
 * guard.
 */
export function hasTargetScript(text: string, profile: LanguageProfile): boolean {
  return scriptRegExp(profile.scriptPattern).test(text);
}

/**
 * Whether a plain-text model reply means "no speech was heard" rather than a
 * transcript. Markers are matched case-insensitively, ignoring surrounding
 * punctuation and whitespace.
 */
export function isSilenceReply(text: string, profile: LanguageProfile): boolean {
  const trimmed = text.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').trim();
  if (!trimmed) return true;
  const upper = trimmed.toUpperCase();
  return profile.silenceMarkers.some((marker) => marker.toUpperCase() === upper);
}
