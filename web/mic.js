// AudioWorklet runs at the explicitly requested 16 kHz context sample rate.
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = new Int16Array(960); this.offset = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'flush') { this.flush(); this.port.postMessage({ type: 'flushed' }); }
    };
  }
  flush() {
    if (!this.offset) return;
    const pcm = new ArrayBuffer(this.offset * 2), view = new DataView(pcm);
    for (let i = 0; i < this.offset; i++) view.setInt16(i * 2, this.samples[i], true);
    this.port.postMessage(pcm, [pcm]); this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) for (const value of channel) {
      const bounded = Math.max(-1, Math.min(1, value));
      this.samples[this.offset++] = Math.round(bounded * (bounded < 0 ? 32768 : 32767));
      if (this.offset === 960) {
        this.flush(); // Explicit little-endian, independent of host representation.
      }
    }
    return true;
  }
}
registerProcessor('pcm16', PCMProcessor);
