/**
 * Release gate for Phase 2/7: rehearse the multi-account migration end to end
 * against both a fresh install and a genuine single-user legacy database, then
 * clean up after itself.
 *
 *   node scripts/rehearse.mjs
 *
 * Exits non-zero if any check fails, so CI and the Pi deploy both stop on it.
 * Needs `npm run build` first: it exercises `server/dist`, not the sources.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = (script, args = []) =>
  execFileSync(process.execPath, [path.join(HERE, script), ...args], { stdio: 'inherit' });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-all-'));
const legacy = path.join(dir, 'legacy.db');
let failed = false;
try {
  console.log('=== fresh install ===');
  run('rehearse-migration.mjs');
  console.log('\n=== migrating a single-user legacy database ===');
  run('make-legacy-db.mjs', [legacy]);
  run('rehearse-migration.mjs', ['--db', legacy]);
} catch (err) {
  failed = true;
  console.error(String(err?.message ?? err));
} finally {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

if (failed) {
  console.error('\nrehearsal FAILED');
  process.exit(1);
}
console.log('\nrehearsal passed');
