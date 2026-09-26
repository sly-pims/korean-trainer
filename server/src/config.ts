import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Copies, Langs, loadCopy, loadLanguageProfile } from './lang.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// server/src/config.ts or server/dist/config.js -> both exactly 2 levels under the repo root.
export const REPO_ROOT = path.resolve(here, '..', '..');

const toBool = (v: unknown) => v === '1' || v === 'true' || v === true || v === 'on';

const splitCsv = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const envSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(8787),
  TZ: z.string().default('Pacific/Auckland'),
  DATA_DIR: z.string().default('data'),
  DB_PATH: z.string().default('data/korean.db'),
  AUTH_PASSWORD: z.string().default('korean'),
  SESSION_SECRET: z.string().min(8).default('dev-secret-change-me'),
  COOKIE_SECURE: z.preprocess(toBool, z.boolean()).default(false),
  LLM_PROVIDER: z.string().default('gemini'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default(''),
  LLM_DAILY_CAP: z.coerce.number().int().default(100),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  WEB_DIST: z.string().default('web/dist'),
  NODE_ENV: z.string().default('development'),
  // Languages this deployment can teach. Comma-separated. Each code must have a
  // config/languages.<code>.json.
  SUPPORTED_TARGET_LANGS: z.string().default(''),
  // Interface languages. Comma-separated. Each must have config/copy/<code>.json.
  // Defaults to the copy sets that ship with the repo, so an existing
  // deployment boots with no .env change at all.
  SUPPORTED_UI_LANGS: z.string().default('en,ko'),
  // Interface language used before anyone has logged in, i.e. on the login page.
  DEFAULT_UI_LANG: z.string().default('en'),
});

export interface Config {
  host: string;
  port: number;
  tz: string;
  dataDir: string;
  dbPath: string;
  authPassword: string;
  sessionSecret: string;
  cookieSecure: boolean;
  llmProvider: string;
  geminiApiKey: string;
  geminiModel: string;
  llmDailyCap: number;
  ffmpegPath: string;
  webDist: string;
  nodeEnv: string;
  supportedTargetLangs: string[];
  supportedUiLangs: string[];
  defaultUiLang: string;
  /** Target-language profiles, keyed by code. */
  langs: Langs;
  /** UI copy sets, keyed by code. */
  copies: Copies;
}

const DEFAULT_TARGET_LANGS = ['ko'];

function requireNonEmpty(list: string[], envName: string): string[] {
  if (list.length === 0) {
    throw new Error(`${envName} is empty — this deployment has nothing to teach or display`);
  }
  return list;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.parse(env);

  const supportedTargetLangs = requireNonEmpty(
    splitCsv(parsed.SUPPORTED_TARGET_LANGS).length
      ? splitCsv(parsed.SUPPORTED_TARGET_LANGS)
      : DEFAULT_TARGET_LANGS,
    'SUPPORTED_TARGET_LANGS',
  );
  const supportedUiLangs = requireNonEmpty(splitCsv(parsed.SUPPORTED_UI_LANGS), 'SUPPORTED_UI_LANGS');
  if (!supportedUiLangs.includes(parsed.DEFAULT_UI_LANG)) {
    throw new Error(
      `DEFAULT_UI_LANG "${parsed.DEFAULT_UI_LANG}" is not in SUPPORTED_UI_LANGS (${supportedUiLangs.join(', ')})`,
    );
  }

  const langs: Langs = new Map();
  for (const code of supportedTargetLangs) {
    langs.set(code, loadLanguageProfile(REPO_ROOT, code));
  }
  const copies: Copies = new Map();
  for (const code of supportedUiLangs) {
    copies.set(code, loadCopy(REPO_ROOT, code));
  }

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    tz: parsed.TZ,
    dataDir: path.resolve(REPO_ROOT, parsed.DATA_DIR),
    dbPath: path.resolve(REPO_ROOT, parsed.DB_PATH),
    authPassword: parsed.AUTH_PASSWORD,
    sessionSecret: parsed.SESSION_SECRET,
    cookieSecure: parsed.COOKIE_SECURE,
    llmProvider: parsed.LLM_PROVIDER,
    geminiApiKey: parsed.GEMINI_API_KEY,
    geminiModel: parsed.GEMINI_MODEL,
    llmDailyCap: parsed.LLM_DAILY_CAP,
    ffmpegPath: parsed.FFMPEG_PATH,
    webDist: path.resolve(REPO_ROOT, parsed.WEB_DIST),
    nodeEnv: parsed.NODE_ENV,
    supportedTargetLangs,
    supportedUiLangs,
    defaultUiLang: parsed.DEFAULT_UI_LANG,
    langs,
    copies,
  };
}

/** The profile for a target language, or a clear error if it was never configured. */
export function langFor(cfg: Config, code: string) {
  const p = cfg.langs.get(code);
  if (!p) {
    throw new Error(
      `target language "${code}" has no config/languages.${code}.json (configured: ${[...cfg.langs.keys()].join(', ')})`,
    );
  }
  return p;
}

export function copyFor(cfg: Config, uiLang: string) {
  const c = cfg.copies.get(uiLang);
  if (!c) {
    throw new Error(
      `UI language "${uiLang}" has no config/copy/${uiLang}.json (configured: ${[...cfg.copies.keys()].join(', ')})`,
    );
  }
  return c;
}

export function warnAboutDefaults(cfg: Config): void {
  if (cfg.authPassword === 'korean' && cfg.nodeEnv !== 'test') {
    console.warn('[config] Using default AUTH_PASSWORD. Set a real one in .env before exposing the app.');
  }
  if (cfg.sessionSecret === 'dev-secret-change-me' && cfg.nodeEnv !== 'test') {
    console.warn('[config] Using default SESSION_SECRET. Set a random value in .env before exposing the app.');
  }
  if (!cfg.geminiApiKey && cfg.nodeEnv !== 'test') {
    console.warn('[config] No GEMINI_API_KEY set — LLM generation is disabled, seed content will be used.');
  }
}