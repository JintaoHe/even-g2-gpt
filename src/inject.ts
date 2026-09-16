import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { readWav } from './audio.js';

async function main() {
  if (!process.argv[2]) throw new Error('Usage: npm run inject -- path/to/16khz-mono.wav');
  const pcm = readWav(await readFile(process.argv[2]));
  if (pcm.length > 120 * 32000) throw new Error('POC limit: 120 seconds');
  const socket = new WebSocket(`ws://127.0.0.1:${process.env.PORT ?? 3000}/ws/g2`);
  let completed = false, failed = false;
  const timer = setTimeout(() => { socket.terminate(); process.exitCode = 1; }, 180000);
  socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', protocol_version: 1, token: process.env.G2_CLIENT_TOKEN,
    audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 } })));
  socket.on('message', async raw => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'ready') socket.send(JSON.stringify({ type: 'audio.start' }));
    if (event.type === 'audio.started') {
      const started = performance.now();
      for (let offset = 0; offset < pcm.length; offset += 1920) {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(pcm.subarray(offset, offset + 1920));
        await sleep(Math.max(0, started + Math.min(offset + 1920, pcm.length) / 32 - performance.now()));
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'audio.stop' }));
    }
    if (event.type === 'transcript.delta') process.stdout.write(event.delta);
    if (event.type === 'transcript.final') console.log('\nFINAL:', event.text);
    if (event.type === 'error') { console.error('POC error:', event.code); failed = true; process.exitCode = 1; socket.close(); }
    if (event.type === 'audio.stopped') { completed = true; console.log(`\nAudio: ${event.audio_seconds}s`); socket.close(); }
  });
  socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
  socket.on('close', () => { clearTimeout(timer); if (!completed && !failed) { console.error('Connection ended before completion'); process.exitCode = 1; } });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
