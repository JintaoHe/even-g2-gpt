import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { Conversation, type DialogueModel, type Event, type Message } from '../src/conversation.js';
import { sse, parseDecision, OpenAIDialogue } from '../src/dialogue-model.js';
import { TurnDetector } from '../src/vad.js';
import { createConversationServer, fileSaver } from '../src/conversation-server.js';
import { LiveTranscriber } from '../src/live-transcriber.js';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';

const immediate: DialogueModel = { decide: async () => 'respond', reply: async (_h, _s, delta) => { delta('收到'); } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }

test('microphone worklet outputs little-endian PCM and flushes the manual-submit tail', async () => {
  const events: any[] = []; let Processor: any;
  runInNewContext(await readFile(new URL('../web/mic.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage: (data: unknown) => events.push(data), onmessage: undefined }; },
    registerProcessor: (_name: string, processor: unknown) => { Processor = processor; }
  });
  const processor = new Processor();
  processor.process([[new Float32Array(960).fill(0.5)]]);
  assert.equal(events[0].byteLength, 1920); assert.equal(new DataView(events[0]).getInt16(0, true), 16384);
  processor.process([[new Float32Array(17).fill(-1)]]);
  processor.port.onmessage({ data: { type: 'flush' } });
  assert.equal(events[1].byteLength, 34); assert.equal(new DataView(events[1]).getInt16(0, true), -32768);
  assert.equal(events[2].type, 'flushed'); assert.equal(processor.offset, 0);
});

test('10 follow-up turns preserve full ordered history', async () => {
  const lengths: number[] = [];
  const c = new Conversation({ ...immediate, reply: async (h, _s, delta) => { lengths.push(h.length); delta('answer'); } }, () => {});
  for (let i = 0; i < 10; i++) await c.submit(`第 ${i} 个 follow-up`);
  assert.deepEqual(lengths, [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
  assert.equal(c.history.length, 20); assert.equal(c.state, 'listening');
});

test('semantic wait accumulates bilingual fragments; explicit submit overrides wait', async () => {
  const seen: string[] = [];
  const c = new Conversation({ ...immediate, decide: async (_h, text) => { seen.push(text); return seen.length === 1 ? 'wait' : 'respond'; } }, () => {});
  await c.submit('把 deployment date 改到'); assert.equal(c.history.length, 0);
  await c.submit('next Friday，不要删除原备注');
  assert.equal(seen[1], '把 deployment date 改到\nnext Friday，不要删除原备注');
  const manual = new Conversation({ ...immediate, decide: async () => 'wait' }, () => {});
  await manual.submit('改到'); await manual.submit('', true); assert.equal(manual.history.length, 2);
});

test('interruption aborts work, records partial answer and suppresses late deltas', async () => {
  const gate = deferred<void>(), events: Event[] = []; let calls = 0, firstSignal: AbortSignal | undefined;
  const c = new Conversation({ ...immediate, reply: async (_h, signal, delta) => {
    if (++calls === 1) { firstSignal = signal; delta('旧答案'); await gate.promise; delta('不应显示'); }
    else delta('新答案');
  } }, e => events.push(e));
  const first = c.submit('所有安排'); await tick(); c.interrupt();
  assert.equal(firstSignal?.aborted, true);
  await c.submit('只看下午'); gate.resolve(); await first;
  assert.ok(!events.some(e => e.text === '不应显示'));
  assert.ok(c.history.some(h => h.content.includes('回答被用户打断')));
  assert.equal(c.history.at(-1)?.content, '新答案'); assert.equal(c.state, 'listening');
});

test('late exit decision after new speech cannot close conversation', async () => {
  const gate = deferred<'exit'>();
  const c = new Conversation({ ...immediate, decide: async () => gate.promise }, () => {});
  const task = c.submit('再见'); c.interrupt(); gate.resolve('exit'); await task;
  assert.equal(c.state, 'listening'); assert.equal(c.pending, '再见');
});

test('exit stops input before save; cancel remains paused; save failure is visible', async () => {
  const events: Event[] = [], saved = deferred<void>();
  const c = new Conversation({ ...immediate, decide: async () => 'exit' }, e => events.push(e), () => saved.promise);
  const task = c.submit('退下吧'); await tick();
  assert.equal(c.state, 'exit_pending'); assert.equal(c.acceptsInput, false);
  assert.ok(events.some(e => e.type === 'exit.confirmation_required'));
  await c.submit('不应进入'); assert.equal(c.history.length, 1);
  c.confirmExit(false); assert.equal(c.state, 'paused'); c.resume(); assert.equal(c.state, 'listening');
  saved.resolve(); await task;
  const failing = new Conversation(immediate, e => events.push(e), async () => { throw new Error('disk'); });
  await failing.requestExit(); assert.equal(failing.state, 'exit_pending');
  assert.ok(events.some(e => e.code === 'SAVE_FAILED'));
});

test('model decisions, not keyword matches, govern exit; ambiguous intent asks', async () => {
  // Stub tests orchestration only, NOT model linguistic accuracy (live eval is separate).
  for (const text of ['不要退出', '把备注改成再见', '他说了再见']) {
    const c = new Conversation(immediate, () => {}); await c.submit(text); assert.equal(c.state, 'listening');
  }
  const c = new Conversation({ ...immediate, decide: async () => 'clarify_exit' }, () => {});
  await c.submit('就这样？'); assert.match(c.history.at(-1)!.content, /结束/); assert.equal(c.state, 'listening');
  assert.throws(() => parseDecision({ decision: 'delete_everything' }));
});

test('energy detector handles silence, short spikes, pause and chunk boundaries', () => {
  const frame = (level: number) => { const b = Buffer.alloc(640); for (let i = 0; i < 640; i += 2) b.writeInt16LE(level, i); return b; };
  const quiet = frame(0), loud = frame(4000);
  const run = (size: number) => {
    let starts = 0, ends = 0, bytes = 0;
    const vad = new TurnDetector(() => starts++, b => { bytes += b.length; }, () => ends++);
    const audio = Buffer.concat([...Array(20).fill(quiet), ...Array(3).fill(loud), ...Array(20).fill(quiet),
      ...Array(20).fill(loud), ...Array(30).fill(quiet), ...Array(20).fill(loud), ...Array(60).fill(quiet)]);
    for (let i = 0; i < audio.length; i += size) vad.push(audio.subarray(i, i + size));
    assert.equal(vad.active, false); return { starts, ends, bytes };
  };
  assert.deepEqual(run(74), run(6400)); assert.equal(run(74).starts, 1); assert.equal(run(74).ends, 1);
});

test('800ms pre-roll preserves soft onset, stays bounded and clears on reset', () => {
  const frame = (level: number) => { const b = Buffer.alloc(640); for (let i = 0; i < 640; i += 2) b.writeInt16LE(level, i); return b; };
  const run = (size: number) => {
    const output: Buffer[] = []; let starts = 0;
    const vad = new TurnDetector(() => starts++, b => output.push(Buffer.from(b)), () => {});
    // 400ms soft opening followed by 160ms of speech: all of the opening survives.
    const audio = Buffer.concat([...Array(50).fill(frame(0)), ...Array(20).fill(frame(200)), ...Array(8).fill(frame(4000))]);
    for (let i = 0; i < audio.length; i += size) vad.push(audio.subarray(i, i + size));
    assert.equal(starts, 1);
    const retained = Buffer.concat(output);
    assert.equal(retained.length, 40 * 640);
    assert.deepEqual(retained, audio.subarray(audio.length - 40 * 640));
    assert.equal(retained.subarray(12 * 640, 32 * 640).equals(Buffer.concat(Array(20).fill(frame(200)))), true);
    vad.reset(); output.length = 0;
    for (let i = 0; i < 8; i++) vad.push(frame(5000));
    assert.deepEqual(Buffer.concat(output), Buffer.concat(Array(8).fill(frame(5000))));
    return retained;
  };
  assert.deepEqual(run(74), run(6400));
});

test('SSE decoder handles split unicode, CRLF, multi-line and incomplete streams', async () => {
  const bytes = new TextEncoder().encode('data: {"type":"response.output_text.delta",\r\ndata: "delta":"你好"}\r\n\r\ndata: [DONE]\n\n');
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  const events = []; for await (const e of sse(body)) events.push(e);
  assert.equal(events[0].delta, '你好');
  const broken = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {}')); c.close(); } });
  await assert.rejects(async () => { for await (const _ of sse(broken)) {} });
});

test('Responses adapter sends strict schema/store:false and parses streaming answer', async () => {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); assert.equal(data.store, false); assert.equal(data.model, 'test-model');
    if (!data.stream) {
      assert.equal(data.text.format.strict, true);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"decision":"respond"}' }] }] }));
    } else { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: {"type":"response.output_text.delta","delta":"你好"}\n\ndata: {"type":"response.completed"}\n\n'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const model = new OpenAIDialogue('fake', 'test-model', `http://127.0.0.1:${(server.address() as any).port}`);
    assert.equal(await model.decide([], 'hello', false, new AbortController().signal), 'respond');
    let answer = ''; await model.reply([], new AbortController().signal, text => { answer += text; }); assert.equal(answer, '你好');
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('streaming transcriber buffers handshake, resamples and commits once', async () => {
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(provider, 'listening');
  let bytes = 0, commits = 0;
  provider.on('connection', client => client.on('message', raw => {
    const e = JSON.parse(raw.toString());
    if (e.type === 'session.update') { assert.equal(e.session.audio.input.turn_detection, null); client.send(JSON.stringify({ type: 'session.updated' })); }
    if (e.type === 'input_audio_buffer.append') bytes += Buffer.from(e.audio, 'base64').length;
    if (e.type === 'input_audio_buffer.commit') { commits++; client.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: '中英 mixed' })); }
  }));
  try {
    const t = new LiveTranscriber('fake', 'gpt-live-transcribe', () => {}, `ws://127.0.0.1:${(provider.address() as any).port}`);
    t.push(Buffer.alloc(16000)); t.finish(); t.finish();
    assert.equal(await t.result, '中英 mixed'); assert.equal(commits, 1); assert.ok(Math.abs(bytes - 24000) <= 2);
  } finally { for (const c of provider.clients) c.terminate(); await new Promise<void>(r => provider.close(() => r())); }
});

test('file persistence serializes snapshots and rejects arbitrary paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'even-conversation-test-'));
  try {
    const save = fileSaver(directory), id = '12345678-1234-1234-1234-123456789abc';
    await Promise.all([save(id, []), save(id, [{ role: 'user', content: '最后版本' }])]);
    assert.equal(JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')).history[0].content, '最后版本');
    await assert.rejects(save('../escape', []));
  } finally { await rm(directory, { recursive: true }); }
});

test('local WebSocket authenticates, runs dialogue, pauses and rejects cross-origin', { timeout: 10000 }, async () => {
  const token = 't'.repeat(64), app = createConversationServer({ token, model: immediate, transcriber: () => { throw new Error('not used'); } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const host = `127.0.0.1:${(app.http.address() as any).port}`;
  try {
    const page = await fetch(`http://${host}/`); assert.equal(page.status, 200); assert.ok((await page.text()).includes('Conversation Lab'));
    const client = new WebSocket(`ws://${host}/ws/conversation`); await once(client, 'open');
    const events: Event[] = [];
    const waitFor = (type: string) => new Promise<Event>(resolve => {
      const fn = (raw: WebSocket.RawData) => { const e = JSON.parse(raw.toString()); if (e.type === type) { client.off('message', fn); resolve(e); } }; client.on('message', fn);
    });
    client.on('message', raw => events.push(JSON.parse(raw.toString())));
    let waiting = waitFor('ready'); client.send(JSON.stringify({ type: 'hello', token })); await waiting;
    waiting = waitFor('answer.done'); client.send(JSON.stringify({ type: 'text.submit', text: 'hello' })); await waiting;
    waiting = waitFor('exit.confirmation_required'); client.send(JSON.stringify({ type: 'exit.request' })); await waiting;
    client.send(Buffer.alloc(640)); client.send(JSON.stringify({ type: 'text.submit', text: 'ignored' }));
    waiting = waitFor('state'); client.send(JSON.stringify({ type: 'exit.confirm', confirm: false })); assert.equal((await waiting).state, 'paused');
    assert.equal(events.filter(e => e.type === 'turn.committed').length, 1);
    client.close();
    const cross = new WebSocket(`ws://${host}/ws/conversation`, { origin: 'https://evil.example' });
    await once(cross, 'error'); cross.terminate();
    const bad = new WebSocket(`ws://${host}/ws/conversation`); await once(bad, 'open');
    const result = once(bad, 'message'); bad.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
    assert.equal(JSON.parse((await result)[0].toString()).code, 'INVALID_MESSAGE'); bad.close();
  } finally { await app.close(); }
});

test('production ingress accepts only the configured public host and origin', { timeout: 10000 }, async () => {
  const app = createConversationServer({ token: 'p'.repeat(64), model: immediate, transcriber: () => { throw new Error('not used'); },
    ingress: { publicHosts: ['calendar.eveng2assistant.com'], allowedOrigins: ['https://calendar.eveng2assistant.com'] } });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const url = `ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`;
  try {
    const trusted = new WebSocket(url, { origin: 'https://calendar.eveng2assistant.com', headers: { host: 'calendar.eveng2assistant.com' } });
    await once(trusted, 'open'); trusted.close(); await once(trusted, 'close');
    const wrongOrigin = new WebSocket(url, { origin: 'https://evil.example', headers: { host: 'calendar.eveng2assistant.com' } });
    await once(wrongOrigin, 'error'); wrongOrigin.terminate();
    const wrongHost = new WebSocket(url, { origin: 'https://calendar.eveng2assistant.com', headers: { host: 'other.eveng2assistant.com' } });
    await once(wrongHost, 'error'); wrongHost.terminate();
  } finally { await app.close(); }
});

test('audio pipeline waits for ordered final transcripts; pause drops late results', { timeout: 10000 }, async () => {
  const jobs: ReturnType<typeof deferred<string>>[] = [], seen: string[] = [];
  const app = createConversationServer({ token: 'a'.repeat(64),
    model: { ...immediate, decide: async (_h, text) => { seen.push(text); return 'respond'; } },
    transcriber: () => {
      const job = deferred<string>(); jobs.push(job);
      return { result: job.promise, push: () => {}, finish: () => {}, cancel: () => {} };
    }
  });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`);
  await once(client, 'open');
  const waitFor = (type: string) => new Promise<any>(resolve => {
    const onMessage = (raw: WebSocket.RawData) => { const e = JSON.parse(raw.toString()); if (e.type === type) { client.off('message', onMessage); resolve(e); } };
    client.on('message', onMessage);
  });
  const utterance = async () => {
    const loud = Buffer.alloc(6400); for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(4000, i);
    const ended = waitFor('speech.ended'); client.send(loud);
    for (let i = 0; i < 7; i++) client.send(Buffer.alloc(6400)); await ended;
  };
  try {
    const ready = waitFor('ready'); client.send(JSON.stringify({ type: 'hello', token: 'a'.repeat(64) })); await ready;
    await utterance(); await utterance();
    let final = waitFor('transcript.final'); jobs[1].resolve('next Friday'); await final;
    assert.deepEqual(seen, []);
    const answer = waitFor('answer.done'); jobs[0].resolve('把日期改到'); await answer;
    assert.deepEqual(seen, ['把日期改到\nnext Friday']);
    await utterance();
    const paused = waitFor('state'); client.send(JSON.stringify({ type: 'pause' })); assert.equal((await paused).state, 'paused');
    jobs[2].resolve('再见'); await tick(); await tick(); assert.equal(seen.length, 1);
  } finally { client.terminate(); await app.close(); }
});
