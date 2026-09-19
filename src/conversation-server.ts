import 'dotenv/config';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { Conversation, type DialogueModel, type Event, type Message } from './conversation.js';
import { createDialogueProvider } from './dialogue-provider.js';
import { createSttProvider, type StreamingTranscriber } from './stt-provider.js';
import { TurnDetector } from './vad.js';
import { JobStore } from './job-store.js';
import { createMailSender, type MailSender } from './mail.js';
import { createDocumentRenderer, mailPresentation } from './document-presentation.js';
import { createDraftGenerator, type DraftGenerator } from './delivery-draft.js';
import { DeliveryDialogue, deliveryResult, mailFallback } from './delivery-dialogue.js';
import { calendarDetails, calendarAttachment, calendarConfirmationPhrase, calendarApprovalMatches } from './calendar.js';
import { GoogleCalendarService, loadCalendarTransport } from './google-calendar.js';
import { CalendarControl } from './calendar-control.js';
import { CalendarDialogue } from './calendar-dialogue.js';
import { createCalendarPlanner, type CalendarPlanner } from './calendar-planner.js';
import { createCalendarItineraryPlanner, type CalendarItineraryPlanner } from './calendar-itinerary-planner.js';
import { createCalendarAnswerer, type CalendarAnswerer } from './calendar-answer.js';
import { LocationRequestBroker, locationStatus, parseLocationReport } from './location.js';
import { LocationDialogue } from './location-dialogue.js';
import { createRouteProvider, type RouteProvider } from './routes.js';
import { createTimezoneProvider, resolveLocationTimezone, type TimezoneFallback, type TimezoneProvider } from './timezone.js';
import { createTimezoneFallback } from './timezone-fallback.js';
import { createEnvironmentProvider, type EnvironmentProvider } from './environment.js';
import { createPlanningEvidenceSelector, PlanningEvidenceDialogue, type PlanningEvidenceSelector } from './planning-evidence-dialogue.js';

type Transcriber = StreamingTranscriber;
export function createConversationServer(options: {
  token: string; model: DialogueModel; transcriber: (delta: (text: string) => void) => Transcriber;
  save?: (id: string, history: Message[]) => Promise<void>; idleMs?: number;
  models?: { intent: string; reply: string };
  capabilities?: { provider: string; delivery: string; webSearch: boolean; speech: boolean; speechProvider?: string; location?: boolean; routes?: boolean;
    environment?: boolean; conditionalTasks?: boolean };
  jobs?: JobStore;
  mail?: MailSender;
  draftGenerator?: DraftGenerator;
  calendar?: GoogleCalendarService;
  calendarPlanner?: CalendarPlanner;
  calendarItineraryPlanner?: CalendarItineraryPlanner;
  calendarAnswerer?: CalendarAnswerer;
  routeProvider?: RouteProvider;
  timezoneProvider?: TimezoneProvider;
  timezoneFallback?: TimezoneFallback;
  environmentProvider?: EnvironmentProvider;
  planningEvidenceSelector?: PlanningEvidenceSelector;
  ingress?: { publicHosts?: string[]; allowedOrigins?: string[] };
}) {
  if (options.token.length < 32) throw new Error('G2_CLIENT_TOKEN must have at least 32 characters');
  const localHost = /^(127\.0\.0\.1|localhost):\d+$/;
  const publicHosts = new Set((options.ingress?.publicHosts ?? []).map(value => value.trim().toLowerCase()).filter(Boolean));
  const allowedOrigins = new Set((options.ingress?.allowedOrigins ?? []).map(value => value.trim()).filter(Boolean));
  for (const host of publicHosts) {
    if (!/^[a-z0-9.-]+(?::\d+)?$/.test(host)) throw new Error('Invalid public host');
    if (!options.ingress?.allowedOrigins?.length) allowedOrigins.add(`https://${host}`);
  }
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid allowed origin');
  }
  const hostAllowed = (host: string) => localHost.test(host) || publicHosts.has(host.toLowerCase());
  const originAllowed = (host: string, origin?: string) => !origin
    || (localHost.test(host) && origin === `http://${host}`)
    || allowedOrigins.has(origin);
  const calendarTasks = new Set<Promise<void>>();
  const files: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript'], '/mic.js': ['mic.js', 'text/javascript'],
    '/citations.js': ['citations.js', 'text/javascript'], '/progress.js': ['progress.js', 'text/javascript'], '/calendar.js': ['calendar.js', 'text/javascript']
  };
  const http = createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    if (!hostAllowed(host)) { res.writeHead(403); res.end(); return; }
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.method === 'GET' && req.url === '/internal/health/calendar') {
      if (!localHost.test(host)) { res.writeHead(404); res.end(); return; }
      if (!options.calendar) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('{"status":"ok","calendar":"disabled"}');
        return;
      }
      try {
        const health = await options.calendar.checkHealth();
        const healthy = health.state === 'healthy';
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: healthy ? 'ok' : 'unavailable', calendar: health.state }));
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('{"status":"unavailable","calendar":"error"}');
      }
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/artifacts/')) {
      const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      const expected = Buffer.from(options.token);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) { res.writeHead(401); res.end(); return; }
      const match = /^\/artifacts\/([a-f0-9-]{36})(\/calendar)?$/.exec(req.url);
      try {
        if (!match || !options.jobs) throw new Error('Unavailable');
        const markdown = await options.jobs.download(match[1]);
        const calendar = match[2] ? options.jobs.calendar(match[1]) : undefined;
        if (match[2] && !calendar) throw new Error('Unavailable');
        const file = calendar ? calendarAttachment(match[1], calendar, options.jobs.get(match[1])!.created) : undefined;
        const bytes = file?.content ?? markdown;
        const filename = encodeURIComponent(file?.filename ?? mailPresentation(options.jobs.metadata(match[1])).filename).replace(/'/g, '%27');
        res.writeHead(200, { 'Content-Type': file?.contentType ?? 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${file ? 'event.ics' : 'conversation.md'}"; filename*=UTF-8''${filename}`,
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
    if (req.url !== '/ws/conversation' || !hostAllowed(host)
      || !originAllowed(host, origin) || wss.clients.size >= 4) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client, req));
  });
  let owner: WebSocket | undefined;
  wss.on('connection', client => {
    const id = randomUUID(); let authenticated = false, closed = false, generation = 0;
    let current: Transcriber | undefined, lastActivity = Date.now(), totalBytes = 0, forced = false, segmentId = 0;
    let budgetStart = Date.now(), budgetFrames = 0;
    let slots: { text?: string; job: Transcriber }[] = [];
    let mailApproval: { id: string; token: string; expires: number; retryAttempt?: number } | undefined;
    let unsubscribeCalendarHealth: (() => void) | undefined;
    const delivery = options.jobs && options.draftGenerator ? new DeliveryDialogue(options.model, options.jobs, options.draftGenerator, options.mail, Date.now,
      (jobId, result) => { if (!closed) { send({ type: 'notice', job_id: jobId, text: deliveryResult(result) }); send({ type: 'jobs.list', jobs: options.jobs!.list() }); } }) : undefined;
    const send = (event: Event) => {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 262144) client.send(JSON.stringify(event));
      else client.close(1013, 'Client too slow');
    };
    const locationBroker = new LocationRequestBroker(send, randomUUID);
    const resolveCalendarTimezone = async (history: Message[], signal: AbortSignal) => {
      const cached = locationBroker.timezone();
      if (cached) return cached;
      const location = await locationBroker.request(signal);
      const timezone = await resolveLocationTimezone(location, history, options.timezoneProvider, options.timezoneFallback, signal,
        () => console.warn(JSON.stringify({ event: 'timezone_provider_fallback', provider: 'google-timezone', fallback: 'luna' })));
      return locationBroker.rememberTimezone(timezone)!;
    };
    const clearCapture = () => {
      generation++; detector.reset(); current = undefined; forced = false;
      for (const slot of slots) slot.job.cancel(); slots = [];
    };
    const calendarControl = options.calendar ? new CalendarControl(options.calendar, send) : undefined;
    const calendarDialogue = options.calendar && options.calendarPlanner ? new CalendarDialogue(delivery ?? options.model, options.calendar, options.calendarPlanner,
      text => { if (!closed) send({ type: 'notice', text }); }, Date.now, options.calendarAnswerer, options.calendarItineraryPlanner,
      options.capabilities?.location === true ? resolveCalendarTimezone : undefined) : undefined;
    const locationDialogue = options.routeProvider && options.capabilities?.location === true
      ? new LocationDialogue(calendarDialogue ?? delivery ?? options.model, locationBroker, options.routeProvider,
        process.env.CONVERSATION_TIMEZONE ?? 'America/Chicago', Date.now, options.model) : undefined;
    const planningEvidenceDialogue = options.environmentProvider && options.planningEvidenceSelector
      ? new PlanningEvidenceDialogue(locationDialogue ?? calendarDialogue ?? delivery ?? options.model,
        options.planningEvidenceSelector, locationBroker, options.environmentProvider) : undefined;
    const conversationModel = planningEvidenceDialogue ?? locationDialogue ?? calendarDialogue ?? delivery ?? options.model;
    let sessionEnded = false;
    const endSession = () => {
      if (sessionEnded) return;
      sessionEnded = true; locationDialogue?.endSession(); calendarDialogue?.endSession(); options.model.endSession?.();
    };
    const conversation = new Conversation(conversationModel, event => {
      if (event.type === 'state' && ['paused', 'exit_pending', 'closed'].includes(String(event.state))) {
        clearCapture(); delivery?.invalidate(); mailApproval = undefined; calendarControl?.invalidate(); calendarDialogue?.invalidate();
        locationDialogue?.invalidate();
      }
      if (event.type === 'state' && event.state === 'closed') endSession();
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
      lastActivity = Date.now(); mailApproval = undefined; conversation.interrupt();
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
          if (options.capabilities?.speech === false) { send({ type: 'notice', text: '当前为文字模式；请检查所选 STT provider 的 API key。' }); return; }
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
          options.model.startSession?.(); locationDialogue?.startSession();
          send({ type: 'ready', session_id: id, models: options.models, capabilities: { ...options.capabilities, email: !!options.mail, calendar: !!options.calendar } }); send({ type: 'state', state: conversation.state });
          if (options.calendar) {
            let lastHealthState = '';
            send({ type: 'calendar.health', health: options.calendar.health() });
            unsubscribeCalendarHealth = options.calendar.subscribeHealth(health => {
              if (closed) return;
              send({ type: 'calendar.health', health });
              if (health.state === 'retrying' && lastHealthState !== 'retrying') send({ type: 'notice', text: '日历读取异常，正在自动重试一次。' });
              lastHealthState = health.state;
            });
          }
          return;
        }
        lastActivity = Date.now();
        if (typeof msg.type === 'string' && msg.type.startsWith('calendar.')) {
          if (!calendarControl) send({ type: 'calendar.error', code: 'CALENDAR_DISABLED' });
          else if (['closed', 'exit_pending'].includes(conversation.state)) send({ type: 'calendar.error', code: 'CALENDAR_SESSION_CLOSED' });
          else {
            const task = calendarControl.handle(msg);
            calendarTasks.add(task); void task.finally(() => calendarTasks.delete(task));
          }
          return;
        }
        switch (msg.type) {
          case 'jobs.email.received':
            if (!options.jobs || typeof msg.id !== 'string' || Object.keys(msg).some(key => !['type', 'id'].includes(key))) throw new Error('Invalid receipt');
            mailApproval = undefined; delivery?.invalidate();
            try { options.jobs.acknowledgeReceipt(msg.id); send({ type: 'notice', text: '已记录你确认收到，不会再重发这份文件。' }); }
            catch { send({ type: 'notice', text: '暂无可关联的发送记录，或发送仍在进行。' }); }
            send({ type: 'jobs.list', jobs: options.jobs.list() }); break;
          case 'location.report': {
            if (options.capabilities?.location !== true) { send({ type: 'location.status', state: 'disabled' }); break; }
            try {
              const report = parseLocationReport(msg);
              if (report.requestId) {
                if (locationBroker.accept(report)) send(locationStatus(report.location));
                else send({ type: 'location.status', state: 'cleared' });
              } else if (locationBroker.prime(report)) send(locationStatus(report.location));
              else send({ type: 'location.status', state: 'unavailable', reason: 'low_accuracy' });
            } catch {
              send({ type: 'location.status', state: 'unavailable', reason: 'invalid_or_stale' });
            }
            break;
          }
          case 'location.failed':
            if (options.capabilities?.location !== true) { send({ type: 'location.status', state: 'disabled' }); break; }
            if (!locationBroker.fail(msg)) send({ type: 'location.status', state: 'cleared' });
            break;
          case 'location.clear':
            if (Object.keys(msg).some(key => key !== 'type')) throw new Error('Invalid location clear');
            locationBroker.clear(); break;
          case 'route.mode': {
            if (Object.keys(msg).some(key => !['type', 'mode'].includes(key))
              || !['drive', 'walk', 'bicycle'].includes(msg.mode)) throw new Error('Invalid route mode');
            if (!locationDialogue) { send({ type: 'notice', text: '实时路线尚未启用。' }); break; }
            locationDialogue.setPreferredMode(msg.mode);
            const names = { drive: '驾车', walk: '步行', bicycle: '骑车' } as const;
            send({ type: 'notice', text: `本次对话默认交通方式已切换为${names[msg.mode as keyof typeof names]}。` });
            break;
          }
          case 'jobs.email.cancel': mailApproval = undefined; send({ type: 'notice', text: '已取消本次发送确认，没有发送邮件。' }); break;
          case 'jobs.email.prepare': {
            if (!options.jobs || !options.mail) { send({ type: 'notice', text: '邮件发送未启用。' }); break; }
            if (typeof msg.id !== 'string' || (msg.retry !== undefined && typeof msg.retry !== 'boolean') || Object.keys(msg).some(key => !['type', 'id', 'retry'].includes(key))) throw new Error('Invalid mail request');
            mailApproval = undefined; delivery?.invalidate();
            if (options.jobs.get(msg.id)?.state !== 'completed' || options.jobs.superseded(msg.id) || (msg.retry ? !options.jobs.canRetryEmail(msg.id) : options.jobs.mailState(msg.id))) { send({ type: 'notice', text: '无法发送或重发：文件未完成、旧版失效、已收到或重发次数已用完。' + mailFallback }); break; }
            const metadata = mailPresentation(options.jobs.metadata(msg.id)), calendar = options.jobs.calendar(msg.id);
            mailApproval = { id: msg.id, token: randomUUID(), expires: Date.now() + 5 * 60000, retryAttempt: msg.retry ? options.jobs.mailAttempts(msg.id) : undefined };
            send({ type: 'mail.confirmation_required', id: msg.id, confirmation: mailApproval.token,
              calendar_confirmation: calendar ? calendarConfirmationPhrase(calendar, !!msg.retry) : undefined,
              preview: (msg.retry ? mailFallback + '\n重发同一份文件，可能收到重复邮件。每份文件最多重发一次。\n\n' : '') + metadata.text + (calendar ? '\n\n' + calendarDetails(calendar) : '') });
            break;
          }
          case 'jobs.email': {
            if (!options.jobs || !options.mail) { send({ type: 'notice', text: '邮件发送未启用。' }); break; }
            if (typeof msg.id !== 'string' || Object.keys(msg).some(key => !['type', 'id', 'confirmation', 'calendar_confirmation'].includes(key))) throw new Error('Invalid mail request');
            if (!mailApproval || mailApproval.id !== msg.id || mailApproval.token !== msg.confirmation || mailApproval.expires <= Date.now()) { send({ type: 'notice', text: '发送确认已失效，请重新预览并确认。' }); break; }
            const retryAttempt = mailApproval.retryAttempt;
            mailApproval = undefined; delivery?.invalidate();
            const calendar = options.jobs.calendar(msg.id);
            if (calendar && (typeof msg.calendar_confirmation !== 'string' || !calendarApprovalMatches(msg.calendar_confirmation, calendar, !!retryAttempt))) {
              send({ type: 'notice', text: '日历日期／主时区未明确确认，没有发送。请重新预览并确认指定时区。' }); break;
            }
            send({ type: 'notice', text: '正在处理邮件请求；收件人为服务器配置的固定邮箱。' });
            void (retryAttempt ? options.jobs.retryEmail(msg.id, options.mail, retryAttempt) : options.jobs.email(msg.id, options.mail)).then(result => {
              send({ type: 'notice', text: deliveryResult(result) });
              send({ type: 'jobs.list', jobs: options.jobs!.list() });
            }).catch(() => send({ type: 'notice', text: '暂时无法发送：请确认文件已完成、没有其他发送任务，且未达到每日 20 次上限。' }));
            break;
          }
          case 'jobs.list': send({ type: 'jobs.list', jobs: options.jobs?.list() ?? [] }); break;
          case 'jobs.export':
            mailApproval = undefined; delivery?.invalidate();
            if (!options.jobs) { send({ type: 'notice', text: '文件存储未启用。' }); break; }
            try {
              if (Object.keys(msg).some(key => !['type', 'calendar'].includes(key))) throw new Error('Invalid export request');
              const job = options.jobs.enqueue(conversation.history.map(m => ({ ...m })), msg.calendar);
              send({ type: 'job.created', job });
            } catch { send({ type: 'notice', text: '无法创建导出任务：请检查日程日期、起止时间与时区偏移（含夏令时）是否一致，并确认有对话内容且未超过任务上限。' }); }
            break;
          case 'jobs.cancel':
            if (typeof msg.id !== 'string') throw new Error('Invalid job');
            options.jobs?.cancel(msg.id); send({ type: 'jobs.list', jobs: options.jobs?.list() ?? [] }); break;
          case 'text.submit':
            if (typeof msg.text !== 'string' || !msg.text.trim() || msg.text.length > 6000) throw new Error('Text');
            if (conversation.acceptsInput) { mailApproval = undefined; clearCapture(); void conversation.submit(msg.text, true); } break;
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
      unsubscribeCalendarHealth?.();
      locationBroker.cancel(); clearCapture(); conversation.close(); endSession(); if (owner === client) owner = undefined;
    });
  });
  return { http, wss, close: async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    await Promise.allSettled(calendarTasks);
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
  const stt = createSttProvider();
  const routeProvider = createRouteProvider();
  const timezoneProvider = createTimezoneProvider();
  const environmentProvider = createEnvironmentProvider();
  const mail = createMailSender();
  const dataDirectory = resolve(process.env.EVEN_DATA_DIR ?? '.local');
  const jobs = await JobStore.create(dataDirectory, createDocumentRenderer());
  let calendar: GoogleCalendarService | undefined;
  if (process.env.GOOGLE_CALENDAR_ENABLED === 'true') {
    try {
      if (!process.env.EMAIL_TO?.trim()) throw new Error('Calendar creation requires a fixed invitation recipient');
      const google = await loadCalendarTransport(dataDirectory);
      calendar = await GoogleCalendarService.create(dataDirectory, google.calendarId, google.transport, Date.now, process.env.EMAIL_TO);
    } catch { await jobs.close(); throw new Error('Google Calendar setup invalid; check private auth files and calendar binding.'); }
  }
  const save = fileSaver(resolve(dataDirectory, 'conversations'));
  const timezoneFallback = calendar && hybrid.provider === 'api' && key
    ? createTimezoneFallback(key, hybrid.models.reply) : undefined;
  const planningEvidenceSelector = hybrid.provider === 'api' && key && environmentProvider
    ? createPlanningEvidenceSelector(key, hybrid.models.reply, 'https://api.openai.com/v1/responses',
      process.env.CONVERSATION_TIMEZONE ?? 'America/Chicago') : undefined;
  const publicHost = process.env.EVEN_PUBLIC_HOST?.trim().toLowerCase();
  const publicOrigin = process.env.EVEN_PUBLIC_ORIGIN?.trim();
  const app = createConversationServer({ token, ...hybrid,
    jobs, mail, calendar, calendarPlanner: calendar && hybrid.provider === 'api' ? createCalendarPlanner() : undefined,
    calendarItineraryPlanner: calendar && hybrid.provider === 'api' && key
      ? createCalendarItineraryPlanner(key, hybrid.models.reply, 'https://api.openai.com/v1/responses',
        process.env.CONVERSATION_TIMEZONE ?? 'America/Chicago') : undefined,
    calendarAnswerer: calendar && hybrid.provider === 'api' ? createCalendarAnswerer() : undefined,
    routeProvider,
    timezoneProvider,
    timezoneFallback,
    environmentProvider,
    planningEvidenceSelector,
    draftGenerator: hybrid.provider === 'api' ? createDraftGenerator() : undefined,
    capabilities: { provider: hybrid.provider, delivery: hybrid.delivery, webSearch: hybrid.webSearch, speech: stt.configured, speechProvider: stt.name, location: true,
      routes: !!routeProvider, environment: !!planningEvidenceSelector, conditionalTasks: false },
    ingress: publicHost ? { publicHosts: [publicHost], allowedOrigins: publicOrigin ? [publicOrigin] : undefined } : undefined,
    transcriber: delta => stt.create(delta),
    save
  });
  const port = Number(process.env.CONVERSATION_PORT ?? 3001);
  app.http.on('error', (error: NodeJS.ErrnoException) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Open http://127.0.0.1:${port} or stop the old conversation server before restarting.` : `Server error: ${error.code ?? 'UNKNOWN'}`);
    process.exitCode = 1;
    void shutdown();
  });
  app.http.listen(port, '127.0.0.1', () => console.log(`Conversation lab: http://127.0.0.1:${port} | provider=${hybrid.provider} | intent=${hybrid.models.intent} | reply=${hybrid.models.reply} | stt=${stt.name}/${stt.model} | speech=${stt.configured}`));
  let stopping: Promise<void> | undefined;
  function shutdown() {
    return stopping ??= (async () => {
      const deadline = setTimeout(() => process.exit(1), 25000); deadline.unref();
      try {
        await Promise.allSettled([app.close()]);
        await calendar?.close();
        await Promise.all([hybrid.close(), jobs.close(), save.flush()]);
      } finally { clearTimeout(deadline); }
    })().catch(() => { process.exitCode = 1; });
  }
  const stopFromSignal = () => { void shutdown().finally(() => process.exit(process.exitCode ?? 0)); };
  process.once('SIGINT', stopFromSignal);
  process.once('SIGTERM', stopFromSignal);
}
