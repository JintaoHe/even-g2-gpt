import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConversationStore } from './conversation-store.js';
import { importLegacySessions } from './legacy-session-import.js';

export async function runLegacySessionImportCli(argv = process.argv.slice(2), env = process.env) {
  const apply = argv.includes('--apply');
  const dataArgument = argv.find(argument => argument.startsWith('--data-dir='));
  const dataDirectory = resolve(dataArgument?.slice('--data-dir='.length) || env.EVEN_DATA_DIR || '.local');
  let store: ConversationStore | undefined;
  try {
    if (apply) store = await ConversationStore.create(dataDirectory);
    const report = await importLegacySessions({ dataDirectory, apply, store });
    const mode = apply ? 'apply' : 'dry-run';
    console.log(`Legacy session import ${mode}: scanned=${report.scanned} valid=${report.valid} imported=${report.imported} duplicates=${report.duplicates} quarantined=${report.quarantined} errors=${report.errors.length}`);
    for (const error of report.errors) console.error(`Legacy session import rejected ${error.file}: ${error.code}`);
    if (report.errors.length) process.exitCode = 2;
    return report;
  } finally { await store?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runLegacySessionImportCli();
