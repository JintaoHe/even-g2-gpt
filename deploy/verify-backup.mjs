import { DatabaseSync } from 'node:sqlite';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
if (root !== '/var/backups/even-agent/.restore-check') throw new Error('Unexpected restore-check directory');

let databases = 0;
let jsonFiles = 0;
let foundJobs = false;

async function inspect(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error('Backup contains a symbolic link');
    if (item.isDirectory()) {
      await inspect(path);
      continue;
    }
    if (!item.isFile()) throw new Error('Backup contains an unsupported filesystem entry');
    if (path.endsWith('.json')) {
      if (metadata.size > 16 * 1024 * 1024) throw new Error('JSON file is unexpectedly large');
      JSON.parse(await readFile(path, 'utf8'));
      jsonFiles++;
    }
    if (path.endsWith('.sqlite')) {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        const rows = database.prepare('PRAGMA integrity_check').all();
        if (!rows.length || rows.some(row => String(row.integrity_check) !== 'ok')) throw new Error('SQLite integrity check failed');
      } finally {
        database.close();
      }
      databases++;
      if (basename(path) === 'jobs.sqlite') foundJobs = true;
    }
  }
}

await inspect(root);
if (!foundJobs) throw new Error('Required jobs.sqlite is missing');
console.log(`Backup restore drill passed: ${databases} SQLite database(s), ${jsonFiles} JSON file(s).`);
