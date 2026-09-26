import type { LanguageProfile, NativeLang } from '../lang.js';
import { DEFAULT_NATIVE } from '../lang.js';

/**
 * Everything a prompt needs to know about which languages it is writing for.
 *
 * `profile` describes the language being learned. `native` describes the
 * language the learner's own-language text is written in — an enrollment
 * property, not a profile one, so it is passed separately and defaults to
 * English until accounts and enrollments exist.
 */
export interface PromptContext {
  profile: LanguageProfile;
  native?: NativeLang;
}

/** The native language, defaulted. */
export function nativeOf(ctx: PromptContext): NativeLang {
  return ctx.native ?? DEFAULT_NATIVE;
}

/** Level clamped to the 1-6 range every level scale uses. */
export function clampLevel(level: number): number {
  return Math.min(6, Math.max(1, Math.floor(level)));
}

/** The level's own name on this language's scale, e.g. "TOPIK 3" or "A2". */
export function levelName(ctx: PromptContext, level: number): string {
  const entry = ctx.profile.levels[String(clampLevel(level))];
  return entry?.name ?? `${ctx.profile.levelScaleName} ${clampLevel(level)}`;
}

/** The level's guide line for passage length and grammar, from the profile. */
export function levelGuide(
  ctx: PromptContext,
  level: number,
): { passage: string; grammar: string } {
  const guide = ctx.profile.levelGuide;
  return guide[String(clampLevel(level))] ?? guide['1'] ?? { passage: 'short', grammar: 'everyday' };
}

/**
 * A phrase naming a field's language, e.g. `in English` or `in Korean`.
 * Used only in instructions to the model — never in the data itself.
 */
export function inNative(ctx: PromptContext): string {
  return `in ${nativeOf(ctx).name}`;
}
