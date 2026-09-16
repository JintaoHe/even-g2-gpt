// Uses existing CLI account auth only; never reads/copies credentials or falls back to API.
import { createCodexRunner, CodexDialogue } from '../src/codex-dialogue.js';
import { spawn } from 'node:child_process';
// Optional local diagnostics: event types and bounded, redacted error messages.
const launch: typeof spawn = ((...args: Parameters<typeof spawn>) => {
  const child = spawn(...args);
  if (process.env.CODEX_SMOKE_DIAG === 'true') {
    let pending = '';
    child.stdout?.on('data', chunk => {
      pending += chunk.toString(); let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {
          const event = JSON.parse(line);
          console.log(JSON.stringify({ event: event.type, item: event.item?.type }));
          if (event.type === 'error' || event.type === 'turn.failed' || event.item?.type === 'error') {
            const text = JSON.stringify(event).toLowerCase();
            const categories = ['auth', 'login', 'keyring', 'chatgpt', 'unauthorized', '401', '403', 'model', 'supported',
              'reasoning', 'none', 'schema', 'invalid', 'config', 'sandbox', 'network', 'connection', 'certificate', 'quota', 'rate', 'permission', 'access', 'token', 'missing'];
            const message = String(event.message ?? event.error?.message ?? event.item?.message ?? '')
              .replace(/Bearer\s+\S+|\bsk-\S+|\beyJ[\w.-]+/gi, '[redacted]')
              .replace(/https?:\/\/\S+/gi, '[url]').slice(0, 600);
            console.log(JSON.stringify({ diagnostic: categories.filter(word => text.includes(word)), type: event.type, message }));
          }
        } catch { /* No raw diagnostic text is printed. */ }
      }
    });
  }
  return child;
}) as typeof spawn;
const run = createCodexRunner({ executable: process.env.CODEX_CLI_PATH, model: process.env.CODEX_MODEL, timeoutMs: 90000 }, launch);
try {
  const model = new CodexDialogue(run);
  const start = Date.now();
  const plan = await model.plan([], 'Hi Even，你好！', false, new AbortController().signal);
  console.log(JSON.stringify({ test: 'intent', ...plan, ms: Date.now() - start }));
  let answer = '', searches = 0;
  await model.reply([{ role: 'user', content: '必须实际调用联网搜索工具：打开 OpenAI 官方 Codex changelog，告诉我最新发布的一个版本号和发布日期，附来源。如果没有调用搜索工具，请明确说没有联网，不能根据记忆回答。' }],
    new AbortController().signal, text => { answer += text; }, event => {
      if (event.type === 'search.status') { searches++; console.log(JSON.stringify(event)); }
    });
  console.log(JSON.stringify({ test: 'search-answer', searches, answer }));
  if (!searches || !answer) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'CLI test failed'); process.exitCode = 1;
} finally { await run.close(); }
