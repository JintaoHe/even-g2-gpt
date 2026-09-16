// Retain fractional position across pushes. Finish extends the last sample once.
export class Resampler {
  private samples: number[] = [];
  private position = 0;
  push(pcm: Buffer, final = false): Buffer {
    if (pcm.length % 2) throw new Error('PCM must contain whole 16-bit samples');
    for (let i = 0; i < pcm.length; i += 2) this.samples.push(pcm.readInt16LE(i));
    const output: number[] = [];
    while (this.position < this.samples.length * 3 && (final || this.position + 3 < this.samples.length * 3)) {
      const i = Math.floor(this.position / 3), fraction = (this.position % 3) / 3;
      const a = this.samples[i], b = this.samples[i + 1] ?? a;
      output.push(Math.round(a + (b - a) * fraction));
      this.position += 2;
    }
    const consumed = Math.min(Math.floor(this.position / 3), this.samples.length);
    this.samples.splice(0, consumed);
    this.position -= consumed * 3;
    const buffer = Buffer.alloc(output.length * 2);
    output.forEach((sample, i) => buffer.writeInt16LE(sample, i * 2));
    return buffer;
  }
}

export function readWav(data: Buffer): Buffer {
  if (data.length < 12 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected RIFF WAV');
  let valid = false;
  let audio: Buffer | undefined;
  for (let at = 12; at + 8 <= data.length;) {
    const id = data.toString('ascii', at, at + 4), size = data.readUInt32LE(at + 4);
    const start = at + 8;
    if (start + size > data.length) throw new Error('Truncated WAV');
    if (id === 'fmt ') {
      valid = size >= 16 && data.readUInt16LE(start) === 1 && data.readUInt16LE(start + 2) === 1 && data.readUInt32LE(start + 4) === 16000 && data.readUInt16LE(start + 14) === 16;
    }
    if (id === 'data') audio = data.subarray(start, start + size);
    at = start + size + (size % 2);
  }
  if (!valid || !audio || audio.length % 2 || audio.length < 6400) throw new Error('WAV must be PCM16 little-endian, 16 kHz, mono, at least 200 ms');
  return audio;
}
