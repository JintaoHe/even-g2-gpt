import 'dotenv/config';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { Resampler } from './audio.js';

export function createPoc(options: { token: string; apiKey: string; upstreamUrl?: string; model?: string }) {
  if (options.token.length < 32) throw new Error('G2_CLIENT_TOKEN needs at least 32 characters');
  if (!options.apiKey) throw new Error('Set OPENAI_API_KEY in .env');
  const http = createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/health' ? { status: 'ok', stage: 'poc' } : { error: 'not found' }));
  });
  const wss = new WebSocketServer({ server: http, path: '/ws/g2', maxPayload: 65536 });
  let active = false;
  wss.on('connection', client => {
    let state = 'hello', upstream: WebSocket | undefined, ownsSlot = false;
    let audioBytes = 0, pending = Buffer.alloc(0), committed = false;
    const sessionId = randomUUID(), resampler = new Resampler();
    const send = (data: object) => {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 262144) client.send(JSON.stringify(data));
      else client.close(1013, 'Client too slow');
    };
    const fail = (code: string) => { send({ type: 'error', code }); client.close(1008, code); };
    const deadline = setTimeout(() => fail('AUTH_TIMEOUT'), 5000);
    const lifetime = setTimeout(() => fail('SESSION_LIMIT'), 5 * 60_000);
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (pcm: Buffer) => {
      if (!pcm.length) return;
      if (!upstream || upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > 262144) return fail('UPSTREAM_BACKPRESSURE');
      upstream.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }));
    };
    client.on('error', () => client.close());
    client.on('close', () => {
      clearTimeout(deadline); clearTimeout(lifetime); clearTimeout(stopTimer);
      upstream?.terminate();
      if (ownsSlot) active = false;
    });
    client.on('message', (raw, binary) => {
      try {
        if (binary) {
          if (state !== 'streaming') return fail('AUDIO_NOT_STARTED');
          const data = Buffer.from(raw as Buffer);
          audioBytes += data.length;
          if (!data.length || data.length % 2 || audioBytes > 16000 * 2 * 120) return fail('INVALID_AUDIO_OR_BUDGET');
          pending = Buffer.concat([pending, resampler.push(data)]);
          while (pending.length >= 2880) { append(pending.subarray(0, 2880)); pending = pending.subarray(2880); }
          return;
        }
        const msg = JSON.parse(raw.toString());
        if (state === 'hello') {
          const given = Buffer.from(typeof msg.token === 'string' ? msg.token : '');
          const expected = Buffer.from(options.token);
          if (msg.type !== 'hello' || msg.protocol_version !== 1 || given.length !== expected.length || !timingSafeEqual(given, expected)) return fail('AUTH_OR_PROTOCOL');
          if (msg.audio?.sample_rate !== 16000 || msg.audio?.channels !== 1 || msg.audio?.format !== 'pcm_s16le') return fail('AUDIO_FORMAT');
          clearTimeout(deadline); state = 'ready'; send({ type: 'ready', session_id: sessionId }); return;
        }
        if (msg.type === 'audio.start' && state === 'ready') {
          if (active) return fail('BUSY');
          active = true; ownsSlot = true; state = 'starting';
          upstream = new WebSocket(options.upstreamUrl ?? 'wss://api.openai.com/v1/realtime?intent=transcription', {
            headers: { Authorization: `Bearer ${options.apiKey}` }, handshakeTimeout: 10000, maxPayload: 1048576
          });
          stopTimer = setTimeout(() => fail('UPSTREAM_TIMEOUT'), 15000);
          upstream.on('error', () => fail('OPENAI_UNAVAILABLE'));
          upstream.on('close', () => { if (state !== 'done') fail('OPENAI_DISCONNECTED'); });
          upstream.on('open', () => upstream!.send(JSON.stringify({ type: 'session.update', session: {
            type: 'transcription', audio: { input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: { model: options.model ?? 'gpt-live-transcribe', languages: ['en', 'zh-cn'], delay: 'low', keywords: ['Even G2', 'OpenAI', 'Claude', 'API', 'deployment'] },
              turn_detection: null
            } }
          } })));
          upstream.on('message', rawEvent => {
            try {
              const event = JSON.parse(rawEvent.toString());
              if (event.type === 'error') return fail('OPENAI_ERROR');
              if (event.type === 'session.updated' && state === 'starting') {
                clearTimeout(stopTimer); state = 'streaming'; send({ type: 'audio.started' });
              }
              if (event.type === 'conversation.item.input_audio_transcription.delta') send({ type: 'transcript.delta', item_id: event.item_id, delta: event.delta });
              if (event.type === 'conversation.item.input_audio_transcription.failed') fail('TRANSCRIPTION_FAILED');
              if (event.type === 'conversation.item.input_audio_transcription.completed') {
                send({ type: 'transcript.final', item_id: event.item_id, text: event.transcript });
                if (committed) { state = 'done'; clearTimeout(stopTimer); send({ type: 'audio.stopped', audio_seconds: audioBytes / 32000 }); upstream?.close(); }
              }
            } catch { fail('INVALID_UPSTREAM_EVENT'); }
          });
          return;
        }
        if (msg.type === 'audio.stop' && state === 'streaming') {
          if (audioBytes < 6400) return fail('AUDIO_TOO_SHORT');
          state = 'stopping'; committed = true;
          append(Buffer.concat([pending, resampler.push(Buffer.alloc(0), true)])); pending = Buffer.alloc(0);
          upstream!.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          stopTimer = setTimeout(() => fail('FINAL_TIMEOUT'), 30000); return;
        }
        fail('INVALID_STATE');
      } catch { fail('INVALID_MESSAGE'); }
    });
  });
  return { http, wss, close: async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const app = createPoc({ token: process.env.G2_CLIENT_TOKEN ?? '', apiKey: process.env.OPENAI_API_KEY ?? '', model: process.env.OPENAI_TRANSCRIBE_MODEL });
    const port = Number(process.env.PORT ?? 3000);
    app.http.listen(port, '127.0.0.1', () => console.log(`POC listening: http://127.0.0.1:${port}/health`));
    process.on('SIGINT', () => { void app.close(); });
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
