import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';
import { loadConfig, REPO_ROOT, warnAboutDefaults } from './config.js';

const envFile = path.join(REPO_ROOT, '.env');
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const config = loadConfig();
warnAboutDefaults(config);

async function main() {
  const { app } = await buildApp({ config, logger: true });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();