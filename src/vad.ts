/** Baseline energy gate, NOT a speaker recognizer. 16kHz PCM16, 20ms frames. */
export class TurnDetector {
  // Keep 800ms before triggering, including the 160ms onset confirmation.
  // This replays captured audio; it does not add an 800ms wait before starting.
  private readonly prefixFrames = 800 / 20;
  private rest = Buffer.alloc(0);
  private prefix: Buffer[] = [];
  private loudMs = 0;
  private quietMs = 0;
  private durationMs = 0;
  active = false;
  constructor(private onStart: () => void, private onAudio: (pcm: Buffer) => void,
    private onEnd: () => void, private threshold = 0.018, private silenceMs = 1200) {}
  push(pcm: Buffer, held = false) {
    if (pcm.length % 2) throw new Error('Invalid PCM');
    this.rest = Buffer.concat([this.rest, pcm]);
    while (this.rest.length >= 640) {
      const frame = Buffer.from(this.rest.subarray(0, 640)); this.rest = this.rest.subarray(640);
      let sum = 0;
      for (let i = 0; i < 640; i += 2) sum += (frame.readInt16LE(i) / 32768) ** 2;
      const loud = Math.sqrt(sum / 320) >= this.threshold;
      if (!this.active) {
        this.prefix.push(frame); if (this.prefix.length > this.prefixFrames) this.prefix.shift();
        this.loudMs = loud ? this.loudMs + 20 : 0;
        if (!held && this.loudMs < 160) continue;
        this.active = true; this.durationMs = 0; this.quietMs = 0;
        this.onStart(); this.onAudio(Buffer.concat(this.prefix)); this.prefix = [];
      } else this.onAudio(frame);
      this.durationMs += 20; this.quietMs = loud ? 0 : this.quietMs + 20;
      if ((!held && this.quietMs >= this.silenceMs) || this.durationMs >= 60000) {
        this.active = false; this.prefix = []; this.loudMs = 0; this.quietMs = 0; this.durationMs = 0;
        this.onEnd();
      }
    }
  }
  finish() {
    if (!this.active) return;
    if (this.rest.length) this.onAudio(this.rest);
    this.reset(); this.onEnd();
  }
  reset() { this.active = false; this.rest = Buffer.alloc(0); this.prefix = []; this.loudMs = 0; this.quietMs = 0; this.durationMs = 0; }
}
