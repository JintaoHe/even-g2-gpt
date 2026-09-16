import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexDialogue, createCodexRunner, codexArguments, codexEnvironment, type CodexRequest } from '../src/codex-dialogue.js';
import { createDialogueProvider } from '../src/dialogue-provider.js';
import { Conversation } from '../src/conversation.js';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createConversationServer } from '../src/conversation-server.js';

test('provider selection is explicit, keeps API default, never needs an API key for CLI text', () => {
  assert.throws(() => createDialogueProvider({}), /OPENAI_API_KEY/);
  assert.throws(() => createDialogueProvider({ DIALOGUE_PROVIDER: 'typo' }), /DIALOGUE_PROVIDER/);
  assert.equal(createDialogueProvider({ OPENAI_API_KEY: 'fake' }).provider, 'api');
  const cli = createDialogueProvider({ DIALOGUE_PROVIDER: 'codex-cli' });
  assert.equal(cli.provider, 'codex-cli'); assert.equal(cli.webSearch, true);
  assert.equal(createDialogueProvider({ DIALOGUE_PROVIDER: 'codex-cli', CODEX_WEB_SEARCH: 'false' }).webSearch, false);
  assert.equal(createDialogueProvider({ DIALOGUE_PROVIDER: 'codex-cli', OPENAI_WEB_SEARCH: 'false' }).webSearch, true);
  assert.throws(() => createDialogueProvider({ DIALOGUE_PROVIDER: 'codex-cli', CODEX_WEB_SEARCH: 'typo' }));
  assert.equal(cli.delivery, 'complete-message');
  assert.throws(() => createCodexRunner({ timeoutMs: NaN }));
  assert.throws(() => createCodexRunner({ executable: 'codex.cmd' }));
  assert.throws(() => createCodexRunner({ model: 'luna --unsafe' }));
});

test('CLI child environment and arguments do not leak API/client secrets or interpolate transcript', () => {
  const env = codexEnvironment({ PATH: 'path', USERPROFILE: 'user', CODEX_HOME: 'auth-dir', OPENAI_API_KEY: 'secret',
    CODEX_API_KEY: 'secret2', G2_CLIENT_TOKEN: 'password', NODE_OPTIONS: '--bad', UNKNOWN_SECRET: 'secret3' });
  assert.deepEqual(env, { PATH: 'path', USERPROFILE: 'user', CODEX_HOME: 'auth-dir' });
  const args = codexArguments({ prompt: '$(evil) & del anything', effort: 'medium' }, 'gpt-5.6-luna');
  assert.equal(args.at(-1), '-'); assert.ok(!args.some(a => a.includes('evil')));
  for (const arg of ['--ignore-user-config', '--ignore-rules', '--ephemeral', 'read-only', 'web_search="disabled"',
    'features.shell_tool=false', 'features.plugins=false', 'forced_login_method="chatgpt"', 'model_reasoning_effort="medium"']) assert.ok(args.includes(arg));
});

test('CLI dialogue preserves history, routes reasoning and semantic exit without HTTP requests', async () => {
  const calls: CodexRequest[] = []; let decision = 'respond', effort = 'medium';
  const model = new CodexDialogue(async (request, signal) => {
    signal.throwIfAborted(); calls.push(request);
    return request.schema ? JSON.stringify({ decision, reasoning_effort: effort }) : '回答';
  });
  const events: any[] = [], conversation = new Conversation(model, e => events.push(e));
  await conversation.submit('比较一下方案');
  assert.equal(calls.length, 2); assert.equal(calls[0].effort, 'none'); assert.equal(calls[1].effort, 'medium');
  assert.equal(calls[0].search, undefined); assert.equal(calls[1].search, true);
  effort = 'none'; await conversation.submit('谢谢');
  assert.match(calls[2].prompt, /比较一下方案/); assert.match(calls[2].prompt, /回答/);
  assert.equal(calls[3].effort, 'low'); // Search-capable CLI replies use a low floor.
  decision = 'exit'; await conversation.submit('退下吧');
  assert.equal(calls.length, 5); assert.equal(conversation.state, 'exit_pending');
  assert.ok(events.some(e => e.type === 'exit.confirmation_required'));
});

const fixture = fileURLToPath(new URL('./fixtures/codex-process.mjs', import.meta.url));
const launch: typeof spawn = ((command: string, args: string[], options: any) => {
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  return spawn(process.execPath, [fixture], options);
}) as typeof spawn;

test('native search enabled only for replies, emits sanitized real lifecycle and rejects other tools', async () => {
  assert.ok(codexArguments({ prompt: '', effort: 'none', search: true }, 'gpt-5.6-luna').includes('web_search="live"'));
  assert.ok(codexArguments({ prompt: '', effort: 'none', search: true, schema: 'schema.json' }, 'gpt-5.6-luna').includes('web_search="disabled"'));
  const run = createCodexRunner({ timeoutMs: 5000 }, launch), signal = new AbortController().signal;
  const events: any[] = [];
  await run({ prompt: 'ok', effort: 'none', search: true, update: e => events.push(e) }, signal);
  assert.equal(events.length, 0); // Merely enabling search is not evidence of researching.
  await run({ prompt: 'search', effort: 'none', search: true, update: e => events.push(e) }, signal);
  assert.deepEqual(events.map(e => e.status), ['searching', 'searching', 'searching', 'searching', 'completed']);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_QUERY/);
  events.length = 0;
  await run({ prompt: 'search-failed', effort: 'none', search: true, update: e => events.push(e) }, signal);
  assert.equal(events.at(-1).status, 'failed');
  await assert.rejects(run({ prompt: 'search', effort: 'none' }, signal), /Unexpected CLI tool/);
  await assert.rejects(run({ prompt: 'tool', effort: 'none', search: true }, signal), /Unexpected CLI tool/);
});

test('cancelling during native research terminates the process and suppresses late progress/answer', async () => {
  const controller = new AbortController(), statuses: any[] = [];
  const run = createCodexRunner({ timeoutMs: 5000 }, launch);
  await assert.rejects(run({ prompt: 'search-hang', effort: 'none', search: true, update: e => {
    statuses.push(e); controller.abort();
  } }, controller.signal), /cancelled/);
  assert.equal(statuses.length, 1);
});

test('CLI process reads split UTF-8 JSONL; rejects malformed, failed, truncated, nonzero and tool output', async () => {
  const run = createCodexRunner({ timeoutMs: 5000 }, launch), signal = new AbortController().signal;
  assert.equal(await run({ prompt: 'ok', effort: 'none' }, signal), '你好 Even');
  for (const prompt of ['malformed', 'failed', 'truncated', 'nonzero', 'tool', 'large']) {
    await assert.rejects(run({ prompt, effort: 'none' }, signal), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /SECRET_NOT_FOR_CLIENT/); return true;
    });
  }
});

test('CLI subprocess timeout and interruption terminate work and return no late answer', async () => {
  const run = createCodexRunner({ timeoutMs: 1000 }, launch);
  await assert.rejects(run({ prompt: 'hang', effort: 'low' }, new AbortController().signal), /timeout/);
  const controller = new AbortController();
  const pending = run({ prompt: 'hang', effort: 'medium' }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(pending, /cancelled/); } finally { clearTimeout(timer); }
  await assert.rejects(run({ prompt: 'ok', effort: 'none' }, controller.signal));
});

test('CLI text-only WebSocket advertises capabilities, rejects audio and still answers text', { timeout: 10000 }, async () => {
  const model = new CodexDialogue(async request => request.schema
    ? '{"decision":"respond","reasoning_effort":"low"}' : 'CLI answer');
  const app = createConversationServer({ token: 'x'.repeat(40), model,
    capabilities: { provider: 'codex-cli', delivery: 'complete-message', webSearch: false, speech: false },
    transcriber: () => { throw new Error('Must never start STT without key'); } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`);
  const waitFor = (type: string) => new Promise<any>(resolve => {
    const handler = (raw: WebSocket.RawData) => { const event = JSON.parse(raw.toString()); if (event.type === type) { client.off('message', handler); resolve(event); } };
    client.on('message', handler);
  });
  try {
    await once(client, 'open');
    let waiting = waitFor('ready'); client.send(JSON.stringify({ type: 'hello', token: 'x'.repeat(40) }));
    assert.equal((await waiting).capabilities.speech, false);
    waiting = waitFor('notice'); client.send(Buffer.alloc(640)); assert.match((await waiting).text, /OPENAI_API_KEY/);
    waiting = waitFor('answer.delta'); client.send(JSON.stringify({ type: 'text.submit', text: '你好' }));
    assert.equal((await waiting).text, 'CLI answer');
  } finally { client.terminate(); await app.close(); }
});
