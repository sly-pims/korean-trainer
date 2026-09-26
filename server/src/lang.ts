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
    topics: z.array(z.string().min(1)).min(1),
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
