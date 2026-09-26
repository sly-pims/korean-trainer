import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  LanguageProfile,
  loadLanguageProfile,
  resolveVoice,
  UnknownVoiceError,
} from '../src/lang.js';
import { REPO_ROOT } from '../src/config.js';

// TTS is only ever used on target-language text, so the voice and the text must
// be the same language. The bug this file exists to prevent: /api/tts held a
// hardcoded allowlist of six Korean voices and silently substituted the Korean
// default for anything else, so a French learner asking for a French voice got
// Korean audio and a 200 with no indication anything was wrong. The allowlist
// now comes from the language profile, and a foreign voice is a 400.

const ko = loadLanguageProfile(REPO_ROOT, 'ko');
const fr = loadLanguageProfile(REPO_ROOT, 'fr');
const profiles = { ko, fr };

describe('resolveVoice', () => {
  it('accepts every voice in the language, including the default', () => {
    for (const p of Object.values(profiles)) {
      for (const voice of p.voices) {
        expect(resolveVoice(p, voice)).toBe(voice);
      }
    }
  });

  it('falls back to that language default when no voice is asked for', () => {
    for (const p of Object.values(profiles)) {
      expect(resolveVoice(p)).toBe(p.defaultVoice);
      expect(resolveVoice(p, '')).toBe(p.defaultVoice);
      expect(resolveVoice(p, '   ')).toBe(p.defaultVoice);
      expect(resolveVoice(p, null)).toBe(p.defaultVoice);
    }
  });

  it('rejects the other language, both directions', () => {
    for (const voice of fr.voices) {
      expect(() => resolveVoice(ko, voice)).toThrow(UnknownVoiceError);
    }
    for (const voice of ko.voices) {
      expect(() => resolveVoice(fr, voice)).toThrow(UnknownVoiceError);
    }
  });

  it('rejects a voice that exists in no profile at all', () => {
    for (const p of Object.values(profiles)) {
      expect(() => resolveVoice(p, 'xx-YY-NobodyNeural')).toThrow(UnknownVoiceError);
    }
  });

  it('does not match a voice by prefix, by case, or by a truncated name', () => {
    // Near-misses a substring, startsWith or case-insensitive check would wave
    // through. Edge voice names are case-sensitive, so folding case is a bug.
    const korean = ko.voices[0];
    for (const near of [`${korean}x`, korean.toLowerCase(), korean.slice(0, -1), `${korean}Neural`]) {
      expect(() => resolveVoice(ko, near), near).toThrow(UnknownVoiceError);
    }
  });

  it('trims surrounding whitespace off an otherwise valid voice', () => {
    expect(resolveVoice(ko, `  ${ko.voices[0]}\n`)).toBe(ko.voices[0]);
  });

  it('names the language and lists the alternatives, so the error is actionable', () => {
    let err: unknown;
    try {
      resolveVoice(fr, ko.voices[0]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnknownVoiceError);
    const message = (err as Error).message;
    expect(message).toContain(ko.voices[0]);
    expect(message).toContain('French');
    for (const voice of fr.voices) expect(message).toContain(voice);
  });
});

describe('voice allowlists in the profiles', () => {
  it('no two languages share a voice', () => {
    for (const a of Object.values(profiles)) {
      for (const b of Object.values(profiles)) {
        if (a.code === b.code) continue;
        for (const voice of a.voices) expect(b.voices).not.toContain(voice);
      }
    }
  });

  it('every voice belongs to its own language, not merely to a shared one', () => {
    // A French profile listing ko-KR voices is a config bug the allowlist would
    // happily honour, so the locale prefix has to match too.
    for (const p of Object.values(profiles)) {
      for (const voice of p.voices) expect(voice.startsWith(`${p.locale}-`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Route level
//
// A unit test of resolveVoice only proves the helper works. The regression was
// at the boundary — a route that ignored the helper's result — so these drive
// the real app. Only rejection paths are exercised: a valid voice would open a
// real WebSocket to Edge, which a unit test must never do.
// ---------------------------------------------------------------------------

const handles: Array<{ close: () => void }> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) {
    try {
      await h.close();
    } catch {
      /* ignore */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function signedInApp(primaryFirst: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-route-'));
  dirs.push(dir);
  const cfg = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-secret-123',
    SUPPORTED_TARGET_LANGS: primaryFirst === 'fr' ? 'fr,ko' : 'ko,fr',
    SUPPORTED_UI_LANGS: 'en',
    DEFAULT_UI_LANG: 'en',
    DATA_DIR: path.join(dir, 'data'),
    DB_PATH: path.join(dir, 'data', 'test.db'),
  });
  const { app, ctx } = await buildApp({ config: cfg });
  handles.push(app);

  // app.inject() does not keep a cookie jar between calls, so the session cookie
  // is captured once and replayed. Without this every request below 401s and the
  // tests would pass for the wrong reason.
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'korean' } });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  expect(cookie).not.toBe('');

  return {
    app,
    db: ctx.db,
    get: (url: string) => app.inject({ method: 'GET', url, headers: { cookie } }),
    put: (url: string, payload: unknown) =>
      app.inject({ method: 'PUT', url, payload, headers: { cookie } }),
  };
}

const ttsUrl = (text: string, voice: string) =>
  `/api/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}`;

describe('GET /api/tts', () => {
  it('a French deployment rejects a Korean voice with a 400, not a silent substitution', async () => {
    const { get } = await signedInApp('fr');
    for (const voice of ko.voices) {
      const res = await get(ttsUrl('Bonjour tout le monde', voice));
      expect(res.statusCode, `${voice} should be refused`).toBe(400);
      expect(res.json()).toHaveProperty('error');
      // The message must not be a 502: nothing was attempted, so this is the
      // caller's mistake rather than an outage.
      expect(res.json().error).not.toBe('TTS unavailable');
    }
  });

  it('a Korean deployment rejects a French voice with a 400', async () => {
    const { get } = await signedInApp('ko');
    for (const voice of fr.voices) {
      const res = await get(ttsUrl('안녕하세요', voice));
      expect(res.statusCode, `${voice} should be refused`).toBe(400);
      expect(res.json().error).not.toBe('TTS unavailable');
    }
  });

  it('still validates the text before it looks at the voice', async () => {
    const { get } = await signedInApp('ko');
    expect((await get(`/api/tts?text=&voice=${ko.voices[0]}`)).statusCode).toBe(400);
    expect((await get(`/api/tts?text=${'가'.repeat(401)}&voice=${ko.voices[0]}`)).statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const { app } = await signedInApp('ko');
    // No cookie: the guard runs before the voice is ever considered.
    const res = await app.inject({ method: 'GET', url: ttsUrl('안녕하세요', ko.voices[0]) });
    expect(res.statusCode).toBe(401);
  });
});

describe('PUT /api/settings', () => {
  it('refuses to store a voice from another language', async () => {
    const { get, put } = await signedInApp('fr');
    for (const voice of ko.voices) {
      const res = await put('/api/settings', { tts_voice: voice });
      expect(res.statusCode, `${voice} should be refused`).toBe(400);
      // And it must not have been written: /api/tts would refuse it later.
      expect((await get('/api/settings')).json().tts_voice).toBe(fr.defaultVoice);
    }
  });

  it('accepts a voice of the active language', async () => {
    const { put } = await signedInApp('fr');
    const res = await put('/api/settings', { tts_voice: fr.voices[1] });
    expect(res.statusCode).toBe(200);
    expect(res.json().tts_voice).toBe(fr.voices[1]);
  });
});

describe('GET /api/settings', () => {
  it('defaults to the active language default voice, not a hardcoded one', async () => {
    const french = await signedInApp('fr');
    expect((await french.get('/api/settings')).json().tts_voice).toBe(fr.defaultVoice);
    const korean = await signedInApp('ko');
    expect((await korean.get('/api/settings')).json().tts_voice).toBe(ko.defaultVoice);
  });

  it('repairs a voice left behind by an older build instead of serving it', async () => {
    // An older build wrote a hardcoded Korean voice into settings regardless of
    // the deployment's language. The client would then be handed a voice
    // /api/tts refuses, so the read has to fall back to the profile default.
    const { get, db } = await signedInApp('fr');
    db.prepare('UPDATE settings SET tts_voice=? WHERE id=1').run(ko.voices[0]);
    expect((await get('/api/settings')).json().tts_voice).toBe(fr.defaultVoice);
  });

  it('keeps a valid stored voice', async () => {
    const { get, db } = await signedInApp('fr');
    db.prepare('UPDATE settings SET tts_voice=? WHERE id=1').run(fr.voices[2]);
    expect((await get('/api/settings')).json().tts_voice).toBe(fr.voices[2]);
  });
});

describe('the profile the route resolves', () => {
  it('is the primary configured language, and phase 7 will make it the enrollment', async () => {
    // Pins the pre-enrollment behaviour so the phase 7 swap is a deliberate,
    // visible change rather than a silent one.
    const { get } = await signedInApp('fr');
    expect((await get('/api/settings')).json().tts_voice).toBe(fr.defaultVoice);
  });
});
