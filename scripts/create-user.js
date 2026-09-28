#!/usr/bin/env node
'use strict';

/**
 * Add a login to this deployment.
 *
 *   node scripts/create-user.js --username sibling --password 'correct horse'
 *   node scripts/create-user.js --username sibling --password '…' \
 *        --target-lang fr --native-lang en --ui-lang en --display-name 'Sister'
 *
 * Accounts are not created over HTTP. There is no signup endpoint, and that is
 * deliberate: a public "register" route on a personal trainer is a spam target
 * and an accidental way to hand a stranger a place in the database. Somebody
 * who has shell access to the box can already do anything, so the smallest
 * honest answer is a command they run themselves.
 *
 * The password hash comes from the server's own module rather than a second
 * implementation here. Two scrypt implementations that disagree on the format
 * are indistinguishable from a broken login, and the only version anyone can
 * test is the one they happened to write last.
 *
 * It reads the same environment the server does, so it opens the same database
 * and the same language configuration. Run it on the box, as the same user the
 * service runs as, with the service's environment loaded.
 */

function usage() {
  return [
    'Usage: node scripts/create-user.js --username <name> --password <secret> [options]',
    '',
    'Options:',
    '  --username <name>        login name, unique across the deployment (required)',
    '  --password <secret>      password; pass it in single quotes (required)',
    '  --display-name <text>    shown in the account menu (default: the username)',
    '  --target-lang <code>     first language to learn (default: deployment primary)',
    '  --native-lang <code>     language they already know (default: DEFAULT_UI_LANG)',
    '  --ui-lang <code>         interface language (default: --native-lang)',
    '  --help                   print this',
    '',
    'Further languages are added from the app after the first sign-in.',
  ].join('\n');
}

/**
 * Reads `--flag value` pairs into an object.
 *
 * Deliberately not a dependency: the deployment image is this repository and
 * nothing else, and a user-creation tool is the worst place to introduce a
 * transitive package that can fail to install.
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`);
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (key === 'help') return { help: true };
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    out[key] = value;
  }
  return out;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  if (args.help) {
    console.log(usage());
    return;
  }

  const username = (args.username ?? '').trim();
  const password = args.password ?? '';
  const displayName = (args['display-name'] ?? username).trim();

  if (!username) fail('--username is required');
  if (!password) fail('--password is required');
  if (username.length > 64) fail('--username must be 64 characters or fewer');
  if (password.length < 8) fail('--password must be at least 8 characters');
  if (displayName.length > 80) fail('--display-name must be 80 characters or fewer');
  if (!/^[A-Za-z0-9._-]+$/.test(username)) {
    fail('--username may contain letters, digits, dot, underscore and hyphen only');
  }

  // The built server, not the sources: a deployment runs `npm start` against
  // dist, and a script that hashed passwords with a different copy of the code
  // would produce accounts the running server cannot authenticate.
  let auth;
  let config;
  let dbMod;
  let enrollments;
  try {
    auth = await import('../server/dist/auth.js');
    config = await import('../server/dist/config.js');
    dbMod = await import('../server/dist/db.js');
    enrollments = await import('../server/dist/enrollments.js');
  } catch (err) {
    fail(
      `could not load the built server (${err instanceof Error ? err.message : String(err)}). ` +
        'Run "npm run build" first.',
    );
  }

  const cfg = config.loadConfig();
  const primary = cfg.supportedTargetLangs[0];
  const targetLang = args['target-lang'] ?? primary;
  const nativeLang = args['native-lang'] ?? cfg.defaultUiLang;
  const uiLang = args['ui-lang'] ?? nativeLang;

  if (!cfg.supportedTargetLangs.includes(targetLang)) {
    fail(`--target-lang ${targetLang} is not offered here (have: ${cfg.supportedTargetLangs.join(', ')})`);
  }
  if (!cfg.supportedUiLangs.includes(nativeLang)) {
    fail(`--native-lang ${nativeLang} is not a supported interface language (have: ${cfg.supportedUiLangs.join(', ')})`);
  }
  if (!cfg.supportedUiLangs.includes(uiLang)) {
    fail(`--ui-lang ${uiLang} is not a supported interface language (have: ${cfg.supportedUiLangs.join(', ')})`);
  }

  const profile = config.langFor(cfg, targetLang);
  const db = dbMod.openDb(cfg.dbPath, {
    defaultVoice: profile.defaultVoice,
    // Only consulted on an empty database, where the server's own bootstrap
    // would have created this account on first boot anyway.
    bootstrapUser: {
      username: cfg.bootstrapUsername,
      password: cfg.authPassword,
      displayName: cfg.bootstrapDisplayName,
    },
    bootstrapEnrollment: { targetLang: primary, nativeLang: cfg.defaultUiLang, uiLang: cfg.defaultUiLang },
  });

  try {
    const existing = db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if (existing) {
      // Refusing rather than resetting: a typo'd username must not be able to
      // hand an existing person's account a new password.
      fail(`there is already an account called "${username}"`);
    }

    const now = new Date().toISOString();
    const inserted = db
      .prepare(
        'INSERT INTO users (username, password_hash, display_name, is_bootstrap, created_at) VALUES (?,?,?,0,?)',
      )
      .run(username, auth.hashPassword(password), displayName, now);
    const userId = Number(inserted.lastInsertRowid);

    const { enrollment } = enrollments.createEnrollment(db, userId, { targetLang, nativeLang, uiLang });
    // A settings row per enrollment, from the start: every screen assumes one
    // exists, and the level/voice defaults are the profile's, not the last
    // account's.
    enrollments.ensureSettingsRow(db, enrollment.id, profile.defaultVoice, cfg.tz);

    console.log(`created account "${username}" (user ${userId})`);
    console.log(`  first enrollment: ${enrollment.id} — learning ${targetLang}, interface ${uiLang}`);
    console.log('  they can add more languages from the app after signing in.');
  } finally {
    db.close();
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack ?? err.message : String(err));
});
