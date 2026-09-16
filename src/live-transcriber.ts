import WebSocket from 'ws';
import { Resampler } from './audio.js';

/** One utterance, streamed while speaking. Keeps a bounded buffer during handshake. */
export class LiveTranscriber {
  readonly result: Promise<string>;
  private resolve!: (text: string) => void;
  private reject!: (error: Error) => void;
  private ws: WebSocket;
  private resampler = new Resampler();
  private pending = Buffer.alloc(0);
  private ready = false;
  private ended = false;
  private settled = false;
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout>;
  constructor(key: string, model: string, private delta: (text: string) => void,
    url = 'wss://api.openai.com/v1/realtime?intent=transcription') {
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // Consumers attach final handlers at end-of-speech; prevent premature unhandled rejection.
    void this.result.catch(() => {});
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 10000, maxPayload: 1048576 });
    this.timer = setTimeout(() => this.fail(), 15000);
    this.ws.on('error', () => this.fail());
    this.ws.on('close', () => { if (!this.settled) this.fail(); });
    this.ws.on('open', () => this.send({ type: 'session.update', session: { type: 'transcription', audio: { input: {
      format: { type: 'audio/pcm', rate: 24000 },
      transcription: { model, languages: ['en', 'zh-cn'], delay: 'low', keywords: ['Even G2', 'deployment', 'OpenAI'] },
      turn_detection: null
    } } } }));
    this.ws.on('message', raw => {
      if (this.settled) return;
      try {
        const event = JSON.parse(raw.toString());
        if (event.type === 'session.updated' && !this.ready) {
          this.ready = true; clearTimeout(this.timer);
          this.timer = setTimeout(() => this.fail(), 90000);
          this.flush(); if (this.ended) this.commit();
        }
        if (event.type === 'conversation.item.input_audio_transcription.delta' && typeof event.delta === 'string') this.delta(event.delta);
        if (event.type === 'conversation.item.input_audio_transcription.completed' && this.ended) {
          if (typeof event.transcript !== 'string' || event.transcript.length > 6000) return this.fail();
          this.settled = true; clearTimeout(this.timer); this.resolve(event.transcript); this.ws.close();
        }
        if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') this.fail();
      } catch { this.fail(); }
    });
  }
  private send(event: object) {
    if (this.settled) return;
    if (this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 262144) return this.fail();
    this.ws.send(JSON.stringify(event));
  }
  private flush() {
    if (!this.ready || this.settled) return;
    while (this.pending.length >= 2880 || (this.ended && this.pending.length)) {
      const size = Math.min(2880, this.pending.length);
      this.send({ type: 'input_audio_buffer.append', audio: this.pending.subarray(0, size).toString('base64') });
      this.pending = this.pending.subarray(size);
    }
  }
  push(pcm: Buffer) {
    if (this.ended || this.settled) return;
    this.bytes += pcm.length;
    if (this.bytes > 65 * 32000) return this.fail();
    this.pending = Buffer.concat([this.pending, this.resampler.push(pcm)]);
    if (this.pending.length > 750000) return this.fail();
    this.flush();
  }
  finish() {
    if (this.ended || this.settled) return;
    this.ended = true;
    this.pending = Buffer.concat([this.pending, this.resampler.push(Buffer.alloc(0), true)]);
    this.flush(); if (this.ready) this.commit();
  }
  private commit() {
    this.send({ type: 'input_audio_buffer.commit' });
    clearTimeout(this.timer); this.timer = setTimeout(() => this.fail(), 20000);
  }
  cancel() { this.fail(); }
  private fail() {
    if (this.settled) return;
    this.settled = true; clearTimeout(this.timer); this.pending = Buffer.alloc(0);
    this.ws.terminate(); this.reject(new Error('TRANSCRIPTION_FAILED'));
  }
}
