// Tests the running web server; uses the local token without printing it.
import 'dotenv/config';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const socket = new WebSocket(`ws://127.0.0.1:${process.env.CONVERSATION_PORT ?? 3001}/ws/conversation`);
let success = false, answer = '';
const deadline = setTimeout(() => { console.error('Web CLI smoke timed out'); socket.terminate(); }, 120000);
socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', token: process.env.G2_CLIENT_TOKEN })));
socket.on('message', raw => {
  try {
    const event = JSON.parse(raw.toString());
    if (event.type === 'ready') {
      assert.equal(event.capabilities.provider, 'codex-cli');
      console.log(JSON.stringify({ capabilities: event.capabilities, models: event.models }));
      socket.send(JSON.stringify({ type: 'text.submit', text: 'Hi Even，请用一句中文跟我打个招呼，不要联网。' }));
    }
    if (event.type === 'answer.delta') answer += event.text;
    if (event.type === 'answer.done') {
      assert.ok(answer.trim()); success = true;
      console.log('Authenticated web connection → CLI → answer: PASS'); socket.close();
    }
    if (event.type === 'error') throw new Error(`Server error: ${event.code}`);
  } catch (error) { console.error(error instanceof Error ? error.message : 'Test failed'); socket.close(); }
});
socket.on('error', () => console.error('Web connection failed'));
await new Promise<void>(resolve => socket.on('close', () => { clearTimeout(deadline); resolve(); }));
if (!success) process.exitCode = 1;
