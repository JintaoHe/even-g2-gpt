import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { readWav } from './audio.js';

async function main() {
  if (!process.argv[2]) throw new Error('Pass a 16kHz mono PCM16 WAV (max 30 seconds)');
  const pcm = readWav(await readFile(process.argv[2]));
  if (pcm.length > 30 * 32000) throw new Error('Smoke test limit: 30 seconds');
  const socket = new WebSocket(`ws://127.0.0.1:${process.env.CONVERSATION_PORT ?? 3001}/ws/conversation`);
  let sent = false, answers = 0, starts = 0, transcripts = 0, success = false;
  const deadline = setTimeout(() => { console.error('Audio conversation timed out'); socket.terminate(); }, 90000);
  socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', token: process.env.G2_CLIENT_TOKEN })));
  socket.on('message', raw => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'ready') void (async () => {
      const stream = Buffer.concat([pcm, Buffer.alloc(1600 * 32)]), began = performance.now();
      for (let at = 0; at < stream.length; at += 1920) {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(stream.subarray(at, at + 1920));
        await sleep(Math.max(0, began + Math.min(at + 1920, stream.length) / 32 - performance.now()));
      }
      sent = true;
    })().catch(() => socket.close());
    if (event.type === 'speech.started') starts++;
    if (event.type === 'transcript.final') { transcripts++; console.log(`Transcription segment ${transcripts}: ${event.text.length} characters`); }
    if (event.type === 'answer.done') answers++;
    if (event.type === 'turn.waiting' && sent) {
      console.error('Final utterance classified incomplete; retry manually in the lab.'); socket.close();
    }
    if (event.type === 'state' && event.state === 'listening' && sent && answers > 0 && transcripts === starts) {
      success = true; console.log(`Audio → automatic endpoint → intent → answer: PASS (${transcripts} segments, ${answers} answers)`); socket.close();
    }
    if (event.type === 'error' || event.type === 'exit.confirmation_required') { console.error(event.code ?? 'Unexpected exit intent'); socket.close(); }
  });
  socket.on('error', () => { console.error('Local connection failed'); });
  await new Promise<void>(resolve => socket.on('close', () => { clearTimeout(deadline); resolve(); }));
  if (!success) process.exitCode = 1;
}
main().catch(() => { console.error('Audio smoke test failed. Check WAV and local server.'); process.exitCode = 1; });
