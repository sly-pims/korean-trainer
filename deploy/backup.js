// Backup helper for the Korean trainer (runs on the Pi via deploy/backup.sh).
// Uses the built-in node:sqlite to produce a consistent DB snapshot (VACUUM INTO),
// then the shell script packs the database + recordings into a tar.
//
// Usage: node backup.js <data-dir> <backup-target.db>
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , dataDir, outDb] = process.argv;
if (!dataDir || !outDb) {
  console.error('usage: node backup.js <data-dir> <target.db>');
  process.exit(1);
}

mkdirSync(dirname(outDb), { recursive: true });
const db = new DatabaseSync(process.argv[2].endsWith('.db') ? process.argv[2] : `${process.argv[2]}/korean.db`);
db.exec(`VACUUM INTO '${outDb.replaceAll("'", "''")}'`);
db.close();
console.log(`snapshot written to ${outDb}`);