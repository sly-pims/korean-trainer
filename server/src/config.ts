import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
// server/src/config.ts or server/dist/config.js -> both exactly 2 levels under the repo root.
export const REPO_ROOT = path.resolve(here, '..', '..');

const toBool = (v: unknown) => v === '1' || v === 'true' || v === true || v === 'on';

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
  SEED_PATH: z.string().default('seed/passages.json'),
  WEB_DIST: z.string().default('web/dist'),
  NODE_ENV: z.string().default('development'),
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
  seedPath: string;
  webDist: string;
  nodeEnv: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.parse(env);
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
    seedPath: path.resolve(REPO_ROOT, parsed.SEED_PATH),
    webDist: path.resolve(REPO_ROOT, parsed.WEB_DIST),
    nodeEnv: parsed.NODE_ENV,
  };
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