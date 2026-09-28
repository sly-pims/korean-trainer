import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';
import { loadConfig, REPO_ROOT, warnAboutDefaults } from './config.js';

const envFile = path.join(REPO_ROOT, '.env');
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const config = loadConfig();

async function main() {
  const { app, ctx } = await buildApp({ config, logger: true });
  // After buildApp: the bootstrap-account check needs the database, which is
  // opened (and migrated) inside buildApp. It is the check worth having on
  // every boot, because AUTH_PASSWORD goes inert the moment the first account
  // exists and nobody editing .env months later will know that.
  warnAboutDefaults(config, ctx.db);
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();