import WebSocket from 'ws';

type SonioxToken = { text?: unknown; is_final?: unknown };
type SonioxEvent = {
  tokens?: unknown;
  error_code?: unknown;
  finished?: unknown;
};

/**
 * One locally-delimited utterance sent to Soniox as native G2 PCM16 audio.
 * Final tokens are emitted once, so the existing append-only live transcript
 * protocol never displays a revised hypothesis as duplicate text.
 */
export class SonioxTranscriber {
  readonly result: Promise<string>;
  private resolve!: (text: string) => void;
  private reject!: (error: Error) => void;
  private ws: WebSocket;
  private pending = Buffer.alloc(0);
  private ready = false;
  private ended = false;
  private finalized = false;
  private settled = false;
  private bytes = 0;
  private transcript = '';
  private timer: ReturnType<typeof setTimeout>;

  constructor(key: string, model: string, private delta: (text: string) => void,
    url = 'wss://stt-rt.soniox.com/transcribe-websocket') {
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // Consumers attach their final handlers at end-of-speech.
    void this.result.catch(() => {});
    this.ws = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 1048576 });
    this.timer = setTimeout(() => this.fail(), 15000);
    this.ws.on('error', () => this.fail());
    this.ws.on('close', () => { if (!this.settled) this.fail(); });
    this.ws.on('open', () => {
      this.sendJson({
        api_key: key,
        model,
        audio_format: 'pcm_s16le',
        sample_rate: 16000,
        num_channels: 1,
        language_hints: ['en', 'zh'],
        language_hints_strict: false,
        enable_language_identification: true,
        // Local VAD owns turn boundaries; manual finalization avoids two
        // independent endpoint detectors disagreeing about a short pause.
        enable_endpoint_detection: false,
        context: {
          general: [{ key: 'domain', value: 'Bilingual Chinese-English personal assistant commands' }],
          terms: ['Hi, Even', 'Even G2', 'ChatGPT', 'OpenAI', 'Claude', 'Codex', 'Google Calendar', 'TypeScript',
            'deployment date', 'next Friday', 'Power BI', 'refresh data', 'to-do list']
        },
        client_reference_id: 'even-g2-assistant'
      });
      if (this.settled) return;
      this.ready = true;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.fail(), 90000);
      this.flush();
      if (this.ended) this.finalize();
    });
    this.ws.on('message', raw => this.onMessage(raw));
  }

  private onMessage(raw: WebSocket.RawData) {
    if (this.settled) return;
    try {
      const event = JSON.parse(raw.toString()) as SonioxEvent;
      if (event.error_code !== undefined && event.error_code !== null) return this.fail();
      let finalized = false;
      if (Array.isArray(event.tokens)) {
        for (const value of event.tokens as SonioxToken[]) {
          if (value?.is_final !== true || typeof value.text !== 'string') continue;
          if (value.text === '<fin>') {
            finalized = true;
            continue;
          }
          if (this.transcript.length + value.text.length > 6000) return this.fail();
          this.transcript += value.text;
          this.delta(value.text);
        }
      }
      if (finalized && this.ended) return this.complete();
      if (event.finished === true && this.ended) this.complete();
    } catch { this.fail(); }
  }

  private sendJson(event: object) {
    if (this.settled) return;
    if (this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 262144) return this.fail();
    this.ws.send(JSON.stringify(event));
  }

  private flush() {
    if (!this.ready || this.settled) return;
    // 100 ms at 16 kHz, 16-bit mono. Send the final shorter frame as-is.
    while (this.pending.length >= 3200 || (this.ended && this.pending.length)) {
      const size = Math.min(3200, this.pending.length);
      if (this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 262144) return this.fail();
      this.ws.send(this.pending.subarray(0, size), { binary: true });
      this.pending = this.pending.subarray(size);
    }
  }

  push(pcm: Buffer) {
    if (this.ended || this.settled) return;
    this.bytes += pcm.length;
    if (this.bytes > 65 * 32000) return this.fail();
    this.pending = Buffer.concat([this.pending, pcm]);
    if (!this.ready && this.pending.length > 750000) return this.fail();
    this.flush();
  }

  finish() {
    if (this.ended || this.settled) return;
    this.ended = true;
    // Soniox recommends about 200 ms of post-speech silence before finalize.
    this.pending = Buffer.concat([this.pending, Buffer.alloc(6400)]);
    this.flush();
    if (this.ready) this.finalize();
  }

  private finalize() {
    if (this.finalized || this.settled) return;
    this.finalized = true;
    this.sendJson({ type: 'finalize' });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(), 20000);
  }

  private complete() {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.pending = Buffer.alloc(0);
    this.resolve(this.transcript.trim());
    this.ws.close();
  }

  cancel() { this.fail(); }

  private fail() {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.pending = Buffer.alloc(0);
    this.ws.terminate();
    this.reject(new Error('TRANSCRIPTION_FAILED'));
  }
}
