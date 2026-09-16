import 'dotenv/config';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { Conversation, type DialogueModel, type Event, type Message } from './conversation.js';
import { createDialogueProvider } from './dialogue-provider.js';
import { LiveTranscriber } from './live-transcriber.js';
import { TurnDetector } from './vad.js';
import { JobStore } from './job-store.js';
import { createMailSender, type MailSender } from './mail.js';

type Transcriber = Pick<LiveTranscriber, 'result' | 'push' | 'finish' | 'cancel'>;
export function createConversationServer(options: {
  token: string; model: DialogueModel; transcriber: (delta: (text: string) => void) => Transcriber;
  save?: (id: string, history: Message[]) => Promise<void>; idleMs?: number;
  models?: { intent: string; reply: string };
  capabilities?: { provider: string; delivery: string; webSearch: boolean; speech: boolean };
  jobs?: JobStore;
  mail?: MailSender;
}) {
  if (options.token.length < 32) throw new Error('G2_CLIENT_TOKEN must have at least 32 characters');
  const files: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript'], '/mic.js': ['mic.js', 'text/javascript'],
    '/citations.js': ['citations.js', 'text/javascript'], '/progress.js': ['progress.js', 'text/javascript']
  };
  const http = createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { res.writeHead(403); res.end(); return; }
    if (req.method === 'GET' && req.url?.startsWith('/artifacts/')) {
      const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      const expected = Buffer.from(options.token);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) { res.writeHead(401); res.end(); return; }
      const match = /^\/artifacts\/([a-f0-9-]{36})$/.exec(req.url);
      try {
        if (!match || !options.jobs) throw new Error('Unavailable');
        const bytes = await options.jobs.download(match[1]);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="conversation-${match[1]}.md"`,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
        res.end(bytes);
      } catch { res.writeHead(404); res.end('Artifact unavailable'); }
      return;
    }
    const file = files[req.url ?? ''];
    if (req.method !== 'GET' || !file) { res.writeHead(404); res.end(); return; }
    try {
      const bytes = await readFile(new URL(`../web/${file[0]}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        'Permissions-Policy': 'microphone=(self)' });
      res.end(bytes);
    } catch (error) {
      // Server-only releases intentionally omit the development browser UI.
      res.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500);
      res.end('Local UI unavailable');
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });
  http.on('upgrade', (req, socket, head) => {
    const host = req.headers.host ?? '', origin = req.headers.origin;
    if (req.url !== '/ws/conversation' || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)
      || (origin && origin !== `http://${host}`) || wss.clients.size >= 4) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client, req));
  });
  let owner: WebSocket | undefined;
  wss.on('connection', client => {
    const id = randomUUID(); let authenticated = false, closed = false, generation = 0;
    let current: Transcriber | undefined, lastActivity = Date.now(), totalBytes = 0, forced = false, segmentId = 0;
    let budgetStart = Date.now(), budgetFrames = 0;
    let slots: { text?: string; job: Transcriber }[] = [];
    const send = (event: Event) => {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 262144) client.send(JSON.stringify(event));
      else client.close(1013, 'Client too slow');
    };
    const clearCapture = () => {
      generation++; detector.reset(); current = undefined; forced = false;
      for (const slot of slots) slot.job.cancel(); slots = [];
    };
    const conversation = new Conversation(options.model, event => {
      if (event.type === 'state' && ['paused', 'exit_pending', 'closed'].includes(String(event.state))) clearCapture();
      send(event);
      if (event.type === 'state' && event.state === 'closed') client.close(1000, 'Conversation ended');
    }, history => options.save?.(id, history) ?? Promise.resolve());
    const flush = () => {
      if (closed || detector.active || !conversation.acceptsInput || slots.some(s => s.text === undefined)) return;
      const text = slots.map(s => s.text).filter(Boolean).join('\n'); slots = [];
      const submitForced = forced; forced = false;
      if (text || submitForced) void conversation.submit(text, submitForced);
      else send({ type: 'notice', text: '没有识别到文字；如误打断，可点“继续上一答”。' });
    };
    const detector = new TurnDetector(() => {
      lastActivity = Date.now(); conversation.interrupt();
      if (slots.length >= 4) { conversation.pause(); send({ type: 'error', code: 'TRANSCRIPTION_BACKLOG' }); return; }
      const epoch = generation;
      const segment = ++segmentId;
      current = options.transcriber(text => { if (generation === epoch && conversation.acceptsInput) send({ type: 'transcript.delta', text, segment_id: segment }); });
      const slot: { text?: string; job: Transcriber } = { job: current }; slots.push(slot);
      send({ type: 'speech.started', segment_id: segment });
      void current.result.then(text => {
        if (epoch !== generation || closed) return;
        slot.text = text; send({ type: 'transcript.final', text, segment_id: segment }); flush();
      }).catch(() => {
        if (epoch !== generation || closed) return;
        conversation.pause(); send({ type: 'error', code: 'TRANSCRIPTION_FAILED' });
      });
    }, pcm => current?.push(pcm), () => {
      const job = current; current = undefined; job?.finish(); send({ type: 'speech.ended', segment_id: segmentId });
    });
    const authTimer = setTimeout(() => client.close(1008, 'Auth timeout'), 5000);
    const idle = setInterval(() => {
      if (authenticated && conversation.state === 'listening' && !detector.active && slots.length === 0
        && Date.now() - lastActivity >= (options.idleMs ?? 180000)) {
        conversation.pause(); send({ type: 'notice', text: '长时间没有输入，已暂停收音；点击恢复继续。' });
      }
    }, 1000);
    const lifetime = setTimeout(() => { conversation.pause(); send({ type: 'error', code: 'SESSION_TIME_LIMIT' }); client.close(); }, 30 * 60000);
    client.on('message', (raw, binary) => {
      try {
        // Bound message bursts from local clients as well as total audio per session.
        if (Date.now() - budgetStart >= 1000) { budgetStart = Date.now(); budgetFrames = 0; }
        if (++budgetFrames > 250) throw new Error('Rate limit');
        if (binary) {
          if (!authenticated) throw new Error('Auth required');
          if (options.capabilities?.speech === false) { send({ type: 'notice', text: '当前为文字模式；语音转录需要 OPENAI_API_KEY。' }); return; }
          if (!conversation.acceptsInput) return; // Drop queued audio after pause/exit.
          const pcm = Buffer.from(raw as Buffer); totalBytes += pcm.length;
          if (!pcm.length || pcm.length % 2 || pcm.length > 6400 || totalBytes > 32000 * 1800) throw new Error('Audio limit');
          detector.push(pcm); return;
        }
        const msg = JSON.parse(raw.toString());
        if (!authenticated) {
          const given = Buffer.from(typeof msg.token === 'string' ? msg.token : '');
          const expected = Buffer.from(options.token);
          if (msg.type !== 'hello' || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('Auth');
          if (owner && owner !== client) { send({ type: 'error', code: 'BUSY' }); client.close(); return; }
          owner = client; authenticated = true; clearTimeout(authTimer);
          send({ type: 'ready', session_id: id, models: options.models, capabilities: { ...options.capabilities, email: !!options.mail } }); send({ type: 'state', state: conversation.state }); return;
        }
        lastActivity = Date.now();
        switch (msg.type) {
          case 'jobs.email':
            if (!options.jobs || !options.mail) { send({ type: 'notice', text: '邮件发送未启用。' }); break; }
            if (typeof msg.id !== 'string' || Object.keys(msg).some(key => !['type', 'id'].includes(key))) throw new Error('Invalid mail request');
            send({ type: 'notice', text: '正在处理邮件请求；收件人为服务器配置的固定邮箱。' });
            void options.jobs.email(msg.id, options.mail).then(result => {
              send({ type: 'notice', text: result === 'accepted' ? '邮件已由发送服务器接受，请检查收件箱或垃圾邮件。'
                : result === 'sending' ? '邮件发送中，请勿重复提交。'
                : result === 'failed' ? '邮件发送失败；文件仍已保存。请检查发件配置。'
                : '邮件发送结果不确定，请先检查邮箱；为避免重复，不会自动重发。' });
              send({ type: 'jobs.list', jobs: options.jobs!.list() });
            }).catch(() => send({ type: 'notice', text: '暂时无法发送：请确认文件已完成、没有其他发送任务，且未达到每日 20 次上限。' }));
            break;
          case 'jobs.list': send({ type: 'jobs.list', jobs: options.jobs?.list() ?? [] }); break;
          case 'jobs.export':
            if (!options.jobs) { send({ type: 'notice', text: '文件存储未启用。' }); break; }
            try {
              const job = options.jobs.enqueue(conversation.history.map(m => ({ ...m })));
              send({ type: 'job.created', job });
            } catch { send({ type: 'notice', text: '无法创建导出任务：请确认有对话内容且未超过存储或任务上限。' }); }
            break;
          case 'jobs.cancel':
            if (typeof msg.id !== 'string') throw new Error('Invalid job');
            options.jobs?.cancel(msg.id); send({ type: 'jobs.list', jobs: options.jobs?.list() ?? [] }); break;
          case 'text.submit':
            if (typeof msg.text !== 'string' || !msg.text.trim() || msg.text.length > 6000) throw new Error('Text');
            if (conversation.acceptsInput) { clearCapture(); void conversation.submit(msg.text, true); } break;
          case 'turn.submit':
            if (!conversation.acceptsInput) break;
            forced = true; if (detector.active) detector.finish(); else flush(); break;
          case 'pause': conversation.pause(); break;
          case 'resume': conversation.resume(); break;
          case 'interrupt': conversation.interrupt(); break;
          case 'answer.retry':
            if (conversation.acceptsInput) { clearCapture(); void conversation.submit('请继续刚才被打断的回答。', true); } break;
          case 'exit.request': void conversation.requestExit(); break;
          case 'exit.confirm':
            if (typeof msg.confirm !== 'boolean') throw new Error('Confirmation');
            conversation.confirmExit(msg.confirm); break;
          default: throw new Error('Unknown message');
        }
      } catch { send({ type: 'error', code: 'INVALID_MESSAGE' }); client.close(1008); }
    });
    client.on('error', () => client.close());
    client.on('close', () => {
      closed = true; clearTimeout(authTimer); clearInterval(idle); clearTimeout(lifetime);
      clearCapture(); conversation.close(); if (owner === client) owner = undefined;
    });
  });
  return { http, wss, close: async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  } };
}

export function fileSaver(directory: string) {
  let queue = Promise.resolve();
  const save = (id: string, history: Message[]) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) return Promise.reject(new Error('Invalid id'));
    const snapshot = JSON.stringify({ session_id: id, updated_at: new Date().toISOString(), history }, null, 2);
    const operation = queue.catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true });
      const file = resolve(directory, `${id}.json`), temporary = `${file}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 }); await rename(temporary, file);
    });
    queue = operation; return operation;
  };
  return Object.assign(save, { flush: () => queue });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.OPENAI_API_KEY, token = process.env.G2_CLIENT_TOKEN;
  if (!token) throw new Error('Set G2_CLIENT_TOKEN in .env');
  const hybrid = createDialogueProvider();
  const mail = createMailSender();
  const dataDirectory = resolve(process.env.EVEN_DATA_DIR ?? '.local');
  const jobs = await JobStore.create(dataDirectory);
  const save = fileSaver(resolve(dataDirectory, 'conversations'));
  const app = createConversationServer({ token, ...hybrid,
    jobs, mail,
    capabilities: { provider: hybrid.provider, delivery: hybrid.delivery, webSearch: hybrid.webSearch, speech: !!key },
    transcriber: delta => {
      if (!key) throw new Error('Speech requires OPENAI_API_KEY');
      return new LiveTranscriber(key, process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-live-transcribe', delta);
    },
    save
  });
  const port = Number(process.env.CONVERSATION_PORT ?? 3001);
  app.http.on('error', (error: NodeJS.ErrnoException) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Open http://127.0.0.1:${port} or stop the old conversation server before restarting.` : `Server error: ${error.code ?? 'UNKNOWN'}`);
    process.exitCode = 1;
    void shutdown();
  });
  app.http.listen(port, '127.0.0.1', () => console.log(`Conversation lab: http://127.0.0.1:${port} | provider=${hybrid.provider} | intent=${hybrid.models.intent} | reply=${hybrid.models.reply} | speech=${!!key}`));
  let stopping: Promise<void> | undefined;
  function shutdown() {
    return stopping ??= (async () => {
      const deadline = setTimeout(() => process.exit(1), 25000); deadline.unref();
      try {
        await Promise.allSettled([app.close()]);
        await Promise.all([hybrid.close(), jobs.close(), save.flush()]);
      } finally { clearTimeout(deadline); }
    })().catch(() => { process.exitCode = 1; });
  }
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}
