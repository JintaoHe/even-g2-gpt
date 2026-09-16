import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket, { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { Resampler, readWav } from '../src/audio.js';
import { createPoc } from '../src/server.js';

test('resampling is invariant to chunk boundaries and preserves duration', () => {
  const input = Buffer.alloc(16000 * 2);
  for (let i = 0; i < 16000; i++) input.writeInt16LE(Math.round(20000 * Math.sin(i / 9)), i * 2);
  const full = new Resampler().push(input, true);
  const stream = new Resampler(), chunks: Buffer[] = [];
  for (let i = 0; i < input.length; i += 74) chunks.push(stream.push(input.subarray(i, i + 74)));
  chunks.push(stream.push(Buffer.alloc(0), true));
  const result = Buffer.concat(chunks);
  assert.ok(Math.abs(result.length / 2 - 24000) <= 1);
  assert.ok(Math.abs(result.length - full.length) <= 2);
  for (let i = 0; i < Math.min(result.length, full.length); i += 2) assert.ok(Math.abs(result.readInt16LE(i) - full.readInt16LE(i)) <= 1);
  assert.throws(() => stream.push(Buffer.alloc(3)));
});

test('WAV parser rejects wrong format and malformed input', () => {
  assert.throws(() => readWav(Buffer.alloc(0)));
  const wav = Buffer.alloc(44 + 6400);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(6400, 40);
  assert.equal(readWav(wav).length, 6400);
  wav.writeUInt32LE(24000, 24); assert.throws(() => readWav(wav));
});

test('authenticated binary audio → mock OpenAI → partial/final; failures stay private', { timeout: 10000 }, async () => {
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(provider, 'listening');
  let bytes = 0;
  provider.on('connection', socket => socket.on('message', raw => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'session.update') {
      assert.equal(event.session.audio.input.format.rate, 24000);
      assert.deepEqual(event.session.audio.input.transcription.languages, ['en', 'zh-cn']);
      assert.equal(event.session.audio.input.turn_detection, null);
      socket.send(JSON.stringify({ type: 'session.updated' }));
    }
    if (event.type === 'input_audio_buffer.append') bytes += Buffer.from(event.audio, 'base64').length;
    if (event.type === 'input_audio_buffer.commit') {
      socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', delta: '测试 ' }));
      socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: '测试 OpenAI' }));
    }
  }));
  const token = 'a'.repeat(64);
  const app = createPoc({ token, apiKey: 'fake-key', upstreamUrl: `ws://127.0.0.1:${(provider.address() as { port: number }).port}` });
  app.http.listen(0, '127.0.0.1'); await once(app.http, 'listening');
  const port = (app.http.address() as { port: number }).port;
  const url = `ws://127.0.0.1:${port}/ws/g2`;
  const hello = { type: 'hello', protocol_version: 1, token, audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 } };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    const client = new WebSocket(url); await once(client, 'open');
    const events: any[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on('error', reject);
      client.on('message', raw => {
        const e = JSON.parse(raw.toString()); events.push(e);
        if (e.type === 'ready') client.send(JSON.stringify({ type: 'audio.start' }));
        if (e.type === 'audio.started') { client.send(Buffer.alloc(6400)); client.send(JSON.stringify({ type: 'audio.stop' })); }
        if (e.type === 'error') reject(new Error(e.code));
        if (e.type === 'audio.stopped') { client.close(); resolve(); }
      });
      client.send(JSON.stringify(hello));
    });
    assert.equal(events.find(e => e.type === 'transcript.final').text, '测试 OpenAI');
    assert.ok(Math.abs(bytes - 9600) <= 2);
    for (const payload of [Buffer.alloc(8), JSON.stringify({ ...hello, token: 'wrong' }), '{']) {
      const bad = new WebSocket(url); await once(bad, 'open');
      const result = once(bad, 'message'); bad.send(payload);
      const [message] = await result;
      assert.equal(JSON.parse(message.toString()).type, 'error');
      assert.ok(!message.toString().includes('fake-key')); bad.close();
    }
  } finally {
    await app.close();
    for (const client of provider.clients) client.terminate();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
});
