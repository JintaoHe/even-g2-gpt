// Synthetic local preview only: never sends mail or reads real conversation history.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDocumentRenderer, mailPresentation } from '../src/document-presentation.js';

async function main() {
  const env = process.argv.includes('--ai') ? process.env : { ...process.env, EMAIL_AI_SUMMARY: 'false' };
  const document = await createDocumentRenderer(env)([
    { role: 'user', content: '我们周末想骑车去社区活动，帮我整理一下注意事项。具体去哪儿还没有决定。' },
    { role: 'assistant', content: '可以先选离家较近的社区活动，再核实开放时间、天气和自行车停车条件。路线应尽量避开繁忙道路，并准备饮水。目的地和日期尚未确认，因此目前只是出行建议，不是已确定的行程。' }
  ], new AbortController().signal);
  const mail = mailPresentation(document.presentation);
  const directory = resolve('.local/mail-preview'); await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'preview.html'), `<!doctype html><meta charset="utf-8">${mail.html}`, { mode: 0o600 });
  await writeFile(resolve(directory, mail.filename), document.markdown, { mode: 0o600 });
  console.log(JSON.stringify({ kind: document.presentation.kind, subject: mail.subject, text: mail.text,
    attachment: mail.filename, preview: resolve(directory, 'preview.html'), sent: false }, null, 2));
}
main().catch(() => { console.error('MAIL_PREVIEW_FAILED'); process.exitCode = 1; });
