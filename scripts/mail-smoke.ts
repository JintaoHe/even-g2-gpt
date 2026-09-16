// Explicit manual smoke test. Never part of npm test or CI. No model calls.
import 'dotenv/config';
import { resolve } from 'node:path';
import { JobStore } from '../src/job-store.js';
import { createMailSender } from '../src/mail.js';

async function main() {
  if (!process.argv.includes('--send')) throw new Error('EXPLICIT_SEND_REQUIRED');
  const sender = createMailSender({ ...process.env, EVEN_EMAIL_ENABLED: 'true' });
  if (!sender) throw new Error('MAIL_DISABLED');
  const store = await JobStore.create(resolve(process.env.EVEN_DATA_DIR ?? '.local', 'mail-smoke'));
  try {
    // Persist one synthetic test artifact; rerunning never sends it twice.
    let job = process.argv.includes('--new-test') ? undefined : store.list()[0];
    if (!job) job = store.enqueue([{ role: 'user', content: 'Even Assistant email setup test.' },
      { role: 'assistant', content: 'This is a synthetic Markdown attachment. No personal conversation, recordings, credentials or model calls were used.' }]);
    for (let i = 0; i < 100 && ['queued', 'running'].includes(store.get(job.id)!.state); i++) await new Promise(r => setTimeout(r, 50));
    const result = await store.email(job.id, sender);
    console.log(`MAIL_SMOKE_${result.toUpperCase()}`);
    if (result !== 'accepted') process.exitCode = 1;
  } finally { await store.close(); }
}
main().catch(() => { console.error('MAIL_SMOKE_FAILED: check private mail configuration; no credentials logged.'); process.exitCode = 1; });
