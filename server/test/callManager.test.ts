import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDb } from '../src/db.js';
import { CallManager } from '../src/llm/callManager.js';
import { DailyCapReachedError, InvalidJSONError, ServerError } from '../src/llm/errors.js';
import { FakeProvider } from './helpers/fakeProvider.js';

const schema = z.object({ ok: z.boolean() });
const noSleep = () => new Promise<void>((r) => r());
const zeroBackoff = () => 0;
// A stand-in for the active language's default voice. These tests are about
// call accounting, not speech, so it deliberately names no language.
const TEST_VOICE = 'test-voice';

function makeManager(provider: FakeProvider, cap = 100, dbPath = ':memory:') {
  const db = openDb(dbPath, TEST_VOICE);
  const mgr = new CallManager(provider, db, cap, () => 'Pacific/Auckland', {
    sleep: noSleep,
    backoff: zeroBackoff,
  });
  return { db, mgr };
}

describe('CallManager (§4.2)', () => {
  it('returns valid JSON and records one call in llm_usage', async () => {
    const provider = new FakeProvider();
    provider.data = { ok: true };
    const { db, mgr } = makeManager(provider);
    const out = await mgr.generateJSON({ system: 's', prompt: 'p', schema });
    expect(out).toEqual({ ok: true });
    expect(provider.calls).toBe(1);
    expect((db.prepare('SELECT calls FROM llm_usage').get() as { calls: number }).calls).toBe(1);
  });

  it('retries on 429/5xx with backoff (max 3 tries), then succeeds', async () => {
    const provider = new FakeProvider();
    provider.data = { ok: true };
    provider.mode = 'rate-limit';
    provider.failuresRemaining = 2;
    const { mgr } = makeManager(provider);
    const out = await mgr.generateJSON({ system: 's', prompt: 'p', schema });
    expect(out).toEqual({ ok: true });
    expect(provider.calls).toBe(3); // 2 failures + 1 success
  });

  it('gives up after 3 retries on a persistent server error', async () => {
    const provider = new FakeProvider();
    provider.mode = 'server-error';
    const { mgr } = makeManager(provider);
    await expect(mgr.generateJSON({ system: 's', prompt: 'p', schema })).rejects.toBeInstanceOf(
      ServerError,
    );
    expect(provider.calls).toBe(4); // initial + 3 retries
  });

  it('retries invalid JSON once with a reminder, then returns valid', async () => {
    const provider = new FakeProvider();
    provider.mode = 'bad-json-then-ok';
    provider.data = { ok: true };
    const { mgr } = makeManager(provider);
    const out = await mgr.generateJSON({ system: 's', prompt: 'p', schema });
    expect(out).toEqual({ ok: true });
    expect(provider.calls).toBe(2);
  });

  it('throws after repeated invalid JSON', async () => {
    const provider = new FakeProvider();
    provider.mode = 'always-bad';
    const { mgr } = makeManager(provider);
    await expect(mgr.generateJSON({ system: 's', prompt: 'p', schema })).rejects.toBeInstanceOf(
      InvalidJSONError,
    );
  });

  it('enforces the daily cap', async () => {
    const provider = new FakeProvider();
    provider.data = { ok: true };
    const { mgr } = makeManager(provider, 1);
    await mgr.generateJSON({ system: 's', prompt: 'p', schema }); // 1 call -> cap
    await expect(mgr.generateJSON({ system: 's', prompt: 'p', schema })).rejects.toBeInstanceOf(
      DailyCapReachedError,
    );
    expect(provider.calls).toBe(1);
  });

  it('audio generation works through the same pipeline', async () => {
    const provider = new FakeProvider();
    provider.data = { ok: true };
    const { mgr } = makeManager(provider);
    const out = await mgr.generateJSONFromAudio({
      system: 's',
      prompt: 'p',
      schema,
      audio: Buffer.from('bytes'),
      mimeType: 'audio/wav',
    });
    expect(out).toEqual({ ok: true });
  });
});