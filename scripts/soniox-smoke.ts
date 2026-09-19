import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { readWav } from '../src/audio.js';
import { SonioxTranscriber } from '../src/soniox-transcriber.js';

const path = process.argv[2];
if (!path) throw new Error('Usage: npm run stt:soniox:check -- path/to/16khz-mono.wav');
const key = process.env.SONIOX_API_KEY?.trim();
if (!key) throw new Error('SONIOX_API_KEY is not configured');
const pcm = readWav(await readFile(path));
if (pcm.length > 65 * 32000) throw new Error('Audio exceeds the 65-second utterance limit');

const transcriber = new SonioxTranscriber(key, process.env.SONIOX_TRANSCRIBE_MODEL?.trim() || 'stt-rt-v5',
  text => process.stdout.write(text));
const started = performance.now();
for (let offset = 0; offset < pcm.length; offset += 3200) {
  transcriber.push(pcm.subarray(offset, offset + 3200));
  await sleep(Math.max(0, started + Math.min(offset + 3200, pcm.length) / 32 - performance.now()));
}
transcriber.finish();
console.log(`\nFINAL: ${await transcriber.result}`);
