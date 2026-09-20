import 'dotenv/config';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { activeTopicHistory, Conversation, type DialogueModel, type Event, type Message } from './conversation.js';
import { createDialogueProvider } from './dialogue-provider.js';
import { createSttProvider, type StreamingTranscriber } from './stt-provider.js';
import { TurnDetector } from './vad.js';
import { JobStore } from './job-store.js';
import { createCostAlertSender, createMailSender, type MailSender } from './mail.js';
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
import { CostLedger } from './cost-ledger.js';
import { createMeteredOpenAIFetch } from './metered-openai.js';
import { ConversationStore, DeviceCredentialError, ResumeCredentialError } from './conversation-store.js';
import { runConversationMaintenance } from './conversation-maintenance.js';
import { readConversationStartupConfig } from './conversation-startup-config.js';
import { StoreConversationPersistence } from './conversation-persistence.js';
import { ContextBuilder } from './context-builder.js';
import { OpenAISessionSummaryGenerator, SessionSummaryService } from './session-summary.js';
import { ActiveInputLeaseError, SessionRegistry, SessionUnavailableError,
  type ManagedSessionRuntime, type SessionDisposeReason, type SessionInterruptReason } from './session-registry.js';
import { CONVERSATION_PROTOCOL_VERSION, parseCoreClientMessage } from './conversation-protocol.js';

function requestsAnswerRecovery(value: string) {
  const text = value.trim().replace(/[\r\n\t]+/g, ' ');
  if (!text || text.length > 300
    || /(?:不要|不用|别|无需|假如|假设|如果|举例|例子|他说|她说|对方说|原话|quoted?|example|if\b|suppose|he said|she said|do not|don't)/i.test(text)) return false;
  const chinese = /(?:刚才|刚刚|上一轮|上一个|前面).{0,28}(?:没(?:有)?看到|没(?:有)?听到|没听清|没显示|中断|断了|再说|重说|重新回答|重复|回顾|复述)|(?:再说|重说|重新回答|重复|回顾|复述).{0,24}(?:刚才|刚刚|上一轮|上一个|答案|回答)/i;
  const english = /(?:didn't|did not|couldn't|could not).{0,24}(?:see|hear|catch|get).{0,24}(?:last|previous|answer|response)|(?:repeat|replay|say|answer).{0,24}(?:again|last|previous)/i;
  return chinese.test(text) || english.test(text);
}

type Transcriber = StreamingTranscriber;
export function createConversationServer(options: {
  token: string; model: DialogueModel; transcriber: (delta: (text: string) => void) => Transcriber;
  save?: (id: string, history: Message[]) => Promise<void>; idleMs?: number;
  conversationStore?: ConversationStore;
  storageWarningBytes?: { databaseWarningBytes: number; diskFreeWarningBytes: number };
  sessionSummary?: SessionSummaryService;
  resumeWindowMs?: number;
  /** Test override. Production refreshes at two-thirds of the resume window. */
  resumeCredentialRefreshMs?: number;
  /** Test overrides. Production device credentials rotate on use and expire after 30 idle days. */
  deviceCredentialTtlMs?: number;
  deviceCredentialPersistWindowMs?: number;
  ownerScope?: string;
  /** Fixed, non-arbitrary simulator controls. Never valid with a public host. */
  localTestControls?: { read: boolean; write: boolean };
  /** Application-level peer detection; tests may shorten these values. */
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
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
  if ((options.localTestControls?.read || options.localTestControls?.write) && publicHosts.size) {
    throw new Error('Local test controls are restricted to loopback development servers');
  }
  if (options.localTestControls?.write && !options.localTestControls.read) {
    throw new Error('Write test controls require read test controls');
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
    if (req.method === 'GET' && req.url === '/internal/health/storage') {
      if (!localHost.test(host)) { res.writeHead(404); res.end(); return; }
      if (!options.conversationStore) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('{"status":"ok","storage":"disabled"}');
        return;
      }
      try {
        const health = await options.conversationStore.storageHealth(options.storageWarningBytes);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify({ status: health.warnings.length ? 'warning' : 'ok',
          database_bytes: health.databaseBytes, available_disk_bytes: health.availableDiskBytes,
          sessions: health.sessions, messages: health.messages, warnings: health.warnings }));
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('{"status":"unavailable","storage":"error"}');
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
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 10
    || !Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < 10) {
    throw new Error('Invalid WebSocket heartbeat configuration');
  }
  http.on('upgrade', (req, socket, head) => {
    const host = req.headers.host ?? '', origin = req.headers.origin;
    if (req.url !== '/ws/conversation' || !hostAllowed(host)
      || !originAllowed(host, origin)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client, req));
  });
  const unauthenticatedSockets = new Set<WebSocket>();
  type MailApproval = { id: string; token: string; expires: number; retryAttempt?: number };
  type ServerSessionRuntime = ManagedSessionRuntime<Event> & {
    conversation: Conversation;
    delivery?: DeliveryDialogue;
    calendarControl?: CalendarControl;
    calendarDialogue?: CalendarDialogue;
    locationBroker: LocationRequestBroker;
    locationDialogue?: LocationDialogue;
    artifactSource(): Message[];
    mailApproval?: MailApproval;
    setCaptureStop(connectionId: string, stop: (() => void) | undefined): void;
  };
  const resumeWindowMs = options.resumeWindowMs ?? 15 * 60_000;
  const resumeCredentialTtlMs = Math.min(resumeWindowMs + 60_000, 16 * 60_000);
  const resumeCredentialRefreshMs = options.resumeCredentialRefreshMs
    ?? Math.max(60_000, Math.floor(resumeWindowMs * 2 / 3));
  if (!Number.isSafeInteger(resumeCredentialRefreshMs) || resumeCredentialRefreshMs < 10
    || resumeCredentialRefreshMs >= resumeCredentialTtlMs) throw new Error('Invalid resume credential refresh interval');
  const deviceCredentialTtlMs = options.deviceCredentialTtlMs ?? 30 * 24 * 60 * 60_000;
  const deviceCredentialPersistWindowMs = options.deviceCredentialPersistWindowMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(deviceCredentialTtlMs) || deviceCredentialTtlMs < 1_000
    || deviceCredentialTtlMs > 366 * 24 * 60 * 60_000
    || !Number.isSafeInteger(deviceCredentialPersistWindowMs) || deviceCredentialPersistWindowMs < 10
    || deviceCredentialPersistWindowMs > 10 * 60_000
    || deviceCredentialPersistWindowMs >= deviceCredentialTtlMs) throw new Error('Invalid device credential lifetime');
  const store = options.conversationStore;
  const buildRuntime = async (id: string, hydrate = false): Promise<ServerSessionRuntime> => {
    let sink: ((event: Event) => void) | undefined;
    let captureStop: { connectionId: string; stop: () => void } | undefined;
    let conversation!: Conversation;
    let ended = false, started = false;
    const send = (event: Event) => sink?.(event);
    const initialTopic = hydrate ? store?.listTopics(id).at(-1) : { id: randomUUID(), label: 'General' };
    if (store && !hydrate) store.createSession({ id, ownerScope: options.ownerScope ?? 'single-user', createdAt: Date.now(),
      initialTopic: initialTopic && { id: initialTopic.id, label: initialTopic.label } });
    const artifactSource = () => {
      const fallback = conversation?.history ?? [];
      const topicId = fallback.at(-1)?.topicId;
      if (!store || !topicId) return activeTopicHistory(fallback);
      const topic = store.listTopics(id).find(item => item.id === topicId);
      return store.listTopicMessages(id, topicId).map(message => ({
        role: message.role === 'system' ? 'assistant' as const : message.role,
        content: message.content,
        ...(message.citations ? { citations: message.citations as any } : {}),
        ...(topic ? { topicId: topic.id, topicLabel: topic.label } : {}),
        messageId: message.id, sequence: message.sequence, status: message.status,
      }));
    };
    const delivery = options.jobs && options.draftGenerator ? new DeliveryDialogue(options.model, options.jobs, options.draftGenerator, options.mail, Date.now,
      (jobId, result) => { send({ type: 'notice', job_id: jobId, text: deliveryResult(result) }); send({ type: 'jobs.list', jobs: options.jobs!.list() }); },
      artifactSource) : undefined;
    const locationBroker = new LocationRequestBroker(send, randomUUID);
    const resolveCalendarTimezone = async (history: Message[], signal: AbortSignal) => {
      const cached = locationBroker.timezone();
      if (cached) return cached;
      const location = await locationBroker.request(signal);
      const timezone = await resolveLocationTimezone(location, history, options.timezoneProvider, options.timezoneFallback, signal,
        () => console.warn(JSON.stringify({ event: 'timezone_provider_fallback', provider: 'google-timezone', fallback: 'luna' })));
      return locationBroker.rememberTimezone(timezone)!;
    };
    const calendarControl = options.calendar ? new CalendarControl(options.calendar, send) : undefined;
    const calendarDialogue = options.calendar && options.calendarPlanner ? new CalendarDialogue(delivery ?? options.model, options.calendar, options.calendarPlanner,
      text => send({ type: 'notice', text }), Date.now, options.calendarAnswerer, options.calendarItineraryPlanner,
      options.capabilities?.location === true ? resolveCalendarTimezone : undefined) : undefined;
    const locationDialogue = options.routeProvider && options.capabilities?.location === true
      ? new LocationDialogue(calendarDialogue ?? delivery ?? options.model, locationBroker, options.routeProvider,
        process.env.CONVERSATION_TIMEZONE ?? 'America/Chicago', Date.now, options.model) : undefined;
    const planningEvidenceDialogue = options.environmentProvider && options.planningEvidenceSelector
      ? new PlanningEvidenceDialogue(locationDialogue ?? calendarDialogue ?? delivery ?? options.model,
        options.planningEvidenceSelector, locationBroker, options.environmentProvider) : undefined;
    const model = planningEvidenceDialogue ?? locationDialogue ?? calendarDialogue ?? delivery ?? options.model;
    let runtime!: ServerSessionRuntime;
    const invalidate = () => {
      captureStop?.stop(); delivery?.invalidate(); runtime.mailApproval = undefined;
      calendarControl?.invalidate(); calendarDialogue?.invalidate(); locationDialogue?.invalidate();
    };
    const baseContextBuilder = new ContextBuilder();
    conversation = new Conversation(model, event => {
      if (event.type === 'state' && ['paused', 'exit_pending', 'closed'].includes(String(event.state))) invalidate();
      send(event);
    }, store ? undefined : history => options.save?.(id, history) ?? Promise.resolve(), store && initialTopic ? {
      sessionId: id,
      persistence: new StoreConversationPersistence(store, id),
      initialTopic: { id: initialTopic.id, label: initialTopic.label },
      idFactory: randomUUID,
      recoverAnswer: request => {
        if (!requestsAnswerRecovery(request)) return undefined;
        const prior = store.latestRecoverableTurn(id);
        if (!prior) return { kind: 'missing' };
        if (prior.output?.status === 'committed') return { kind: 'committed', turnId: prior.turn.id,
          content: prior.output.content, citations: prior.output.citations as any };
        return { kind: 'interrupted', turnId: prior.turn.id };
      },
      onTurnCommitted: () => { options.sessionSummary?.consider(id); },
    } : undefined, {
      build: input => {
        const summary = store?.latestSummary(id);
        return baseContextBuilder.build({ ...input, ...(summary ? { summary } : {}) });
      },
    });
    if (hydrate && store) {
      const topics = new Map(store.listTopics(id).map(topic => [topic.id, topic]));
      conversation.restoreHistory(store.listRecentMessages(id, 100).filter(message => ['committed', 'interrupted', 'failed'].includes(message.status))
        .map(message => {
          const topic = message.topicId ? topics.get(message.topicId) : undefined;
          const turn = message.turnId ? store.getTurn(message.turnId) : undefined;
          return {
            role: message.role === 'system' ? 'assistant' as const : message.role,
            content: message.status === 'interrupted' && message.role === 'assistant'
              ? `${message.content}\n[回答因连接中断，未完成]` : message.content,
            ...(message.citations ? { citations: message.citations as any } : {}),
            ...(topic ? { topicId: topic.id, topicLabel: topic.label } : {}),
            ...(turn?.cognitiveMode ? { cognitiveMode: turn.cognitiveMode as any, assistantMode: turn.cognitiveMode as any } : {}),
            messageId: message.id, sequence: message.sequence, status: message.status,
          };
        }));
    }
    const start = () => {
      if (started) return;
      started = true; options.model.startSession?.(); locationDialogue?.startSession();
    };
    const finish = () => {
      if (!started || ended) return;
      ended = true; locationDialogue?.endSession(); calendarDialogue?.endSession(); options.model.endSession?.();
    };
    runtime = {
      id,
      conversation,
      delivery,
      calendarControl,
      calendarDialogue,
      locationBroker,
      locationDialogue,
      artifactSource,
      replaceEventSink(next) {
        sink = next;
        if (next) { start(); store?.markSessionAttached(id, Date.now()); }
        else if (store && ['active', 'idle'].includes(store.getSession(id)?.status ?? '')) store.markSessionDetached(id, Date.now());
      },
      async detach(_reason) {
        // Connection-bound capture and approvals are revoked, but the durable
        // model turn keeps running without an event sink and may still commit.
        invalidate();
        locationBroker.cancel();
      },
      async interrupt(_reason: SessionInterruptReason) {
        captureStop?.stop(); invalidate(); locationBroker.cancel(); conversation.interrupt();
      },
      async dispose(reason: SessionDisposeReason) {
        invalidate(); locationBroker.cancel(); locationBroker.clear();
        if (conversation.state !== 'closed') conversation.close();
        finish();
        if (!store) return;
        const current = store.getSession(id);
        if (!current || ['ended', 'expired'].includes(current.status)) return;
        if (reason === 'ended') store.endSession(id, Date.now(), 'user_exit');
        else if (reason === 'expired') store.expireSession(id, Date.now());
        else store.markSessionDetached(id, Date.now());
      },
      setCaptureStop(connectionId, stop) {
        if (stop) captureStop = { connectionId, stop };
        else if (captureStop?.connectionId === connectionId) captureStop = undefined;
      },
    };
    return runtime;
  };
  const registry = new SessionRegistry<Event>({
    resumeWindowMs,
    create: id => buildRuntime(id),
    hydrate: store ? async id => {
      const session = store.getSession(id);
      if (!session || !['active', 'idle'].includes(session.status)) return undefined;
      return { runtime: await buildRuntime(id, true), lastDetachedAt: session.updatedAt };
    } : undefined,
  });
  const sessionSweep = setInterval(() => { void registry.sweepExpired(); }, 30_000);
  sessionSweep.unref();

  wss.on('connection', (client, request) => {
    const connectionId = randomUUID(); let authenticated = false, authSlotHeld = true, closed = false, generation = 0, protocolV2 = false;
    unauthenticatedSockets.add(client);
    if (unauthenticatedSockets.size > 4) {
      const oldest = unauthenticatedSockets.values().next().value as WebSocket | undefined;
      if (oldest && oldest !== client) { unauthenticatedSockets.delete(oldest); oldest.terminate(); }
    }
    const remote = request.socket.remoteAddress ?? '';
    const localTestConnection = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
    let expireOnClose = false, credentialRefresh: NodeJS.Timeout | undefined;
    let pendingDeviceCredentialId: string | undefined;
    let session: ServerSessionRuntime | undefined;
    let authenticatedClientId: string | undefined;
    let current: Transcriber | undefined, lastActivity = Date.now(), totalBytes = 0, forced = false, segmentId = 0;
    let budgetStart = Date.now(), budgetFrames = 0;
    let slots: { text?: string; job: Transcriber }[] = [];
    let unsubscribeCalendarHealth: (() => void) | undefined;
    let pongDeadline: NodeJS.Timeout | undefined;
    const releaseAuthSlot = () => {
      if (!authSlotHeld) return;
      authSlotHeld = false;
      unauthenticatedSockets.delete(client);
    };
    const send = (event: Event) => {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 262144) client.send(JSON.stringify(event));
      else client.close(1013, 'Client too slow');
    };
    const prepareMail = (active: ServerSessionRuntime, id: string, retry = false) => {
      if (!options.jobs || !options.mail) { send({ type: 'notice', text: '邮件发送未启用。' }); return false; }
      active.mailApproval = undefined; active.delivery?.invalidate();
      if (options.jobs.get(id)?.state !== 'completed' || options.jobs.superseded(id)
        || (retry ? !options.jobs.canRetryEmail(id) : options.jobs.mailState(id))) {
        send({ type: 'notice', text: '无法发送或重发：文件未完成、旧版失效、已收到或重发次数已用完。' + mailFallback });
        return false;
      }
      const metadata = mailPresentation(options.jobs.metadata(id)), calendar = options.jobs.calendar(id);
      active.mailApproval = { id, token: randomUUID(), expires: Date.now() + 5 * 60000,
        retryAttempt: retry ? options.jobs.mailAttempts(id) : undefined };
      send({ type: 'mail.confirmation_required', id, confirmation: active.mailApproval.token,
        calendar_confirmation: calendar ? calendarConfirmationPhrase(calendar, retry) : undefined,
        preview: (retry ? mailFallback + '\n重发同一份文件，可能收到重复邮件。每份文件最多重发一次。\n\n' : '')
          + metadata.text + (calendar ? '\n\n' + calendarDetails(calendar) : '') });
      return true;
    };
    const clearCapture = () => {
      generation++; detector.reset(); current = undefined; forced = false;
      for (const slot of slots) slot.job.cancel(); slots = [];
    };
    const flush = () => {
      if (closed || !session || detector.active || !session.conversation.acceptsInput || slots.some(s => s.text === undefined)) return;
      const text = slots.map(s => s.text).filter(Boolean).join('\n'); slots = [];
      const submitForced = forced; forced = false;
      if (text || submitForced) void session.conversation.submit(text, submitForced);
      else send({ type: 'notice', text: '没有识别到文字；如误打断，可点“继续上一答”。' });
    };
    const detector = new TurnDetector(() => {
      if (!session) return;
      lastActivity = Date.now(); session.mailApproval = undefined; session.conversation.interrupt();
      if (slots.length >= 4) { session.conversation.pause(); send({ type: 'error', code: 'TRANSCRIPTION_BACKLOG' }); return; }
      const epoch = generation;
      const segment = ++segmentId;
      current = options.transcriber(text => { if (generation === epoch && session?.conversation.acceptsInput) send({ type: 'transcript.delta', text, segment_id: segment }); });
      const slot: { text?: string; job: Transcriber } = { job: current }; slots.push(slot);
      send({ type: 'speech.started', segment_id: segment });
      void current.result.then(text => {
        if (epoch !== generation || closed) return;
        slot.text = text; send({ type: 'transcript.final', text, segment_id: segment }); flush();
      }).catch(() => {
        if (epoch !== generation || closed) return;
        session?.conversation.pause(); send({ type: 'error', code: 'TRANSCRIPTION_FAILED' });
      });
    }, pcm => current?.push(pcm), () => {
      const job = current; current = undefined; job?.finish(); send({ type: 'speech.ended', segment_id: segmentId });
    });
    const authTimer = setTimeout(() => client.close(1008, 'Auth timeout'), 5000);
    const heartbeat = setInterval(() => {
      if (client.readyState !== WebSocket.OPEN || pongDeadline) return;
      try {
        client.ping();
        pongDeadline = setTimeout(() => client.terminate(), heartbeatTimeoutMs);
        pongDeadline.unref();
      } catch { client.terminate(); }
    }, heartbeatIntervalMs);
    heartbeat.unref();
    client.on('pong', () => {
      if (!pongDeadline) return;
      clearTimeout(pongDeadline); pongDeadline = undefined;
    });
    const idle = setInterval(() => {
      if (authenticated && session?.conversation.state === 'listening' && !detector.active && slots.length === 0
        && Date.now() - lastActivity >= (options.idleMs ?? 180000)) {
        session.conversation.pause(); send({ type: 'notice', text: '长时间没有输入，已暂停收音；点击恢复继续。' });
      }
    }, 1000);
    const lifetime = setTimeout(() => { session?.conversation.pause(); send({ type: 'error', code: 'SESSION_TIME_LIMIT' }); client.close(); }, 30 * 60000);
    const authenticate = async (msg: any) => {
      if (msg?.type !== 'hello') throw new Error('Auth');
      protocolV2 = msg.protocol_version === CONVERSATION_PROTOCOL_VERSION;
      if (protocolV2) msg = parseCoreClientMessage(msg);
      if (protocolV2 && !store) throw new SessionUnavailableError();
      const clientId = protocolV2 ? String(msg.client_id ?? '') : randomUUID();
      if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error('Auth');
      let binding, credential: ReturnType<ConversationStore['issueResumeCredential']> | undefined;
      let deviceCredential: ReturnType<ConversationStore['issueDeviceCredential']> | undefined;
      if (protocolV2 && typeof msg.resume_credential === 'string' && typeof msg.resume_session_id === 'string') {
        if (!store) throw new SessionUnavailableError();
        binding = await registry.resume(msg.resume_session_id, connectionId, send, () => {
          credential = store.rotateResumeCredential({ secret: msg.resume_credential, clientId,
            sessionId: msg.resume_session_id, at: Date.now(), expiresAt: Date.now() + Math.min(resumeWindowMs + 60_000, 16 * 60_000) });
        });
        if (msg.credential_storage === 'even_host_v1') {
          const now = Date.now();
          // Re-provision on every authenticated resume. This closes the narrow
          // crash window where the resume secret reached host storage but the
          // first device credential did not.
          deviceCredential = store.issueDeviceCredential({ clientId, createdAt: now,
            expiresAt: now + deviceCredentialTtlMs,
            persistDeadlineAt: now + deviceCredentialPersistWindowMs });
        }
      } else if (protocolV2 && typeof msg.device_credential === 'string') {
        if (!store) throw new SessionUnavailableError();
        const now = Date.now();
        binding = await registry.create(connectionId, send, randomUUID(), () => {
          deviceCredential = store.rotateDeviceCredential({ secret: msg.device_credential, clientId, at: now,
            expiresAt: now + deviceCredentialTtlMs,
            persistDeadlineAt: now + deviceCredentialPersistWindowMs });
        });
      } else {
        const given = Buffer.from(typeof msg.token === 'string' ? msg.token : '');
        const expected = Buffer.from(options.token);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('Auth');
        store?.registerClient({ id: clientId, at: Date.now(), label: protocolV2 ? 'Even client' : 'Legacy client' });
        binding = await registry.create(connectionId, send);
        if (store) credential = store.issueResumeCredential({ clientId, sessionId: binding.sessionId,
          createdAt: Date.now(), expiresAt: Date.now() + Math.min(resumeWindowMs + 60_000, 16 * 60_000) });
        if (store && protocolV2 && msg.credential_storage === 'even_host_v1') {
          const now = Date.now();
          deviceCredential = store.issueDeviceCredential({ clientId, createdAt: now,
            expiresAt: now + deviceCredentialTtlMs,
            persistDeadlineAt: now + deviceCredentialPersistWindowMs });
        }
      }
      if (store && !credential) credential = store.issueResumeCredential({ clientId, sessionId: binding.sessionId,
        createdAt: Date.now(), expiresAt: Date.now() + Math.min(resumeWindowMs + 60_000, 16 * 60_000) });
      session = binding.runtime as ServerSessionRuntime;
      authenticatedClientId = clientId;
      session.setCaptureStop(connectionId, clearCapture);
      authenticated = true; releaseAuthSlot(); clearTimeout(authTimer);
      const lastSeen = protocolV2 && Number.isSafeInteger(msg.last_seen_sequence) && msg.last_seen_sequence >= 0 ? msg.last_seen_sequence : 0;
      const sessionRecord = store?.getSession(binding.sessionId);
      const recoverable = store?.latestRecoverableTurn(binding.sessionId);
      const snapshot = store ? store.listMessages(binding.sessionId, lastSeen, 100).filter(item => item.status !== 'streaming').map(item => ({
        id: item.id, turn_id: item.turnId, topic_id: item.topicId, sequence: item.sequence,
        role: item.role, status: item.status, content: item.content, created_at: item.createdAt,
      })) : [];
      send({ type: 'ready', protocol_version: protocolV2 ? CONVERSATION_PROTOCOL_VERSION : undefined,
        connection_id: connectionId, session_id: binding.sessionId, resumed: binding.resumed,
        latest_sequence: sessionRecord?.latestSequence ?? 0, resume_window_minutes: Math.ceil(resumeWindowMs / 60_000),
        resume_credential: credential?.secret, resume_expires_at: credential?.expiresAt,
        ...(deviceCredential ? { device_credential_id: deviceCredential.id,
          device_credential: deviceCredential.secret, device_expires_at: deviceCredential.expiresAt,
          device_persist_deadline_at: deviceCredential.persistDeadlineAt } : {}),
        snapshot: { state: session.conversation.state, messages: snapshot,
          ...(recoverable?.turn.status === 'interrupted' ? { interrupted_turn_id: recoverable.turn.id } : {}) },
        models: options.models, capabilities: { ...options.capabilities, email: !!options.mail, calendar: !!options.calendar } });
      pendingDeviceCredentialId = deviceCredential?.id;
      if (protocolV2 && store) {
        const refresh = () => {
          credentialRefresh = setTimeout(() => {
            if (closed || !session || client.readyState !== WebSocket.OPEN) return;
            try {
              const replacement = store.issueResumeCredential({ clientId, sessionId: session.id,
                createdAt: Date.now(), expiresAt: Date.now() + resumeCredentialTtlMs });
              send({ type: 'resume.credential', session_id: session.id,
                resume_credential: replacement.secret, resume_expires_at: replacement.expiresAt });
              refresh();
            } catch {
              send({ type: 'error', code: 'RESUME_CREDENTIAL_REFRESH_FAILED' });
              client.close(1011, 'Resume credential refresh failed');
            }
          }, resumeCredentialRefreshMs);
          credentialRefresh.unref();
        };
        refresh();
      }
      send({ type: 'state', state: session.conversation.state });
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
    };
    const handleMessage = async (raw: WebSocket.RawData, binary: boolean) => {
      try {
        // Bound message bursts from local clients as well as total audio per session.
        if (Date.now() - budgetStart >= 1000) { budgetStart = Date.now(); budgetFrames = 0; }
        if (++budgetFrames > 250) throw new Error('Rate limit');
        if (binary) {
          if (!authenticated) throw new Error('Auth required');
          if (options.capabilities?.speech === false) { send({ type: 'notice', text: '当前为文字模式；请检查所选 STT provider 的 API key。' }); return; }
          if (!session?.conversation.acceptsInput) return; // Drop queued audio after pause/exit.
          const pcm = Buffer.from(raw as Buffer); totalBytes += pcm.length;
          if (!pcm.length || pcm.length % 2 || pcm.length > 6400 || totalBytes > 32000 * 1800) throw new Error('Audio limit');
          detector.push(pcm); return;
        }
        let msg = JSON.parse(raw.toString());
        if (!authenticated) {
          try { await authenticate(msg); }
          catch (error) {
            send({ type: 'error', code: error instanceof ActiveInputLeaseError ? 'BUSY'
              : error instanceof DeviceCredentialError ? 'DEVICE_CREDENTIAL_INVALID'
              : error instanceof SessionUnavailableError || error instanceof ResumeCredentialError
                ? 'SESSION_UNAVAILABLE' : 'INVALID_MESSAGE' });
            client.close(1008);
          }
          return;
        }
        if (protocolV2 && ['text.submit', 'turn.submit', 'pause', 'resume', 'interrupt', 'answer.retry',
          'credential.persisted',
          'exit.request', 'exit.confirm', 'test.session.expire', 'test.storage.inspect', 'test.storage.seed_expired',
          'test.storage.cleanup_preview', 'test.storage.cleanup_apply'].includes(String(msg.type))) msg = parseCoreClientMessage(msg, {
            allowLocalTestControls: localTestConnection && (options.localTestControls?.read === true || options.localTestControls?.write === true),
          });
        const active = session!;
        const conversation = active.conversation, delivery = active.delivery, calendarControl = active.calendarControl;
        const locationBroker = active.locationBroker, locationDialogue = active.locationDialogue;
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
          case 'credential.persisted':
            if (!store || !authenticatedClientId || msg.credential_id !== pendingDeviceCredentialId) {
              throw new Error('Invalid credential ACK');
            }
            store.acknowledgeDeviceCredential({ id: msg.credential_id, clientId: authenticatedClientId, at: Date.now() });
            pendingDeviceCredentialId = undefined;
            send({ type: 'credential.acknowledged', credential_id: msg.credential_id });
            break;
          case 'jobs.email.received':
            if (!options.jobs || typeof msg.id !== 'string' || Object.keys(msg).some(key => !['type', 'id'].includes(key))) throw new Error('Invalid receipt');
            active.mailApproval = undefined; delivery?.invalidate();
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
          case 'jobs.email.cancel': active.mailApproval = undefined; send({ type: 'notice', text: '已取消本次发送确认，没有发送邮件。' }); break;
          case 'jobs.email.prepare': {
            if (typeof msg.id !== 'string' || (msg.retry !== undefined && typeof msg.retry !== 'boolean') || Object.keys(msg).some(key => !['type', 'id', 'retry'].includes(key))) throw new Error('Invalid mail request');
            prepareMail(active, msg.id, !!msg.retry);
            break;
          }
          case 'jobs.email': {
            if (!options.jobs || !options.mail) { send({ type: 'notice', text: '邮件发送未启用。' }); break; }
            if (typeof msg.id !== 'string' || Object.keys(msg).some(key => !['type', 'id', 'confirmation', 'calendar_confirmation'].includes(key))) throw new Error('Invalid mail request');
            if (!active.mailApproval || active.mailApproval.id !== msg.id || active.mailApproval.token !== msg.confirmation || active.mailApproval.expires <= Date.now()) {
              const state = options.jobs.mailState(msg.id);
              if (state) send({ type: 'notice', text: deliveryResult(state) });
              else prepareMail(active, msg.id);
              break;
            }
            const retryAttempt = active.mailApproval.retryAttempt;
            active.mailApproval = undefined; delivery?.invalidate();
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
            active.mailApproval = undefined; delivery?.invalidate();
            if (!options.jobs) { send({ type: 'notice', text: '文件存储未启用。' }); break; }
            try {
              if (Object.keys(msg).some(key => !['type', 'calendar'].includes(key))) throw new Error('Invalid export request');
              const selection = active.artifactSource().map(message => ({ ...message,
                citations: message.citations?.map(citation => ({ ...citation })) }));
              const job = options.jobs.enqueue(selection, msg.calendar);
              send({ type: 'job.created', job });
            } catch { send({ type: 'notice', text: '无法创建导出任务：请检查日程日期、起止时间与时区偏移（含夏令时）是否一致，并确认有对话内容且未超过任务上限。' }); }
            break;
          case 'jobs.cancel':
            if (typeof msg.id !== 'string') throw new Error('Invalid job');
            options.jobs?.cancel(msg.id); send({ type: 'jobs.list', jobs: options.jobs?.list() ?? [] }); break;
          case 'text.submit':
            if (typeof msg.text !== 'string' || !msg.text.trim() || msg.text.length > 6000) throw new Error('Text');
            if (protocolV2 && !/^[0-9a-f-]{36}$/i.test(String(msg.message_id ?? ''))) throw new Error('Message id');
            if (conversation.acceptsInput) { active.mailApproval = undefined; clearCapture();
              void conversation.submit(msg.text, true, protocolV2 ? { messageId: msg.message_id } : undefined); } break;
          case 'turn.submit':
            if (!conversation.acceptsInput) break;
            forced = true; if (detector.active) detector.finish(); else flush(); break;
          case 'pause': conversation.pause(); break;
          case 'resume': conversation.resume(); break;
          case 'interrupt': conversation.interrupt(); break;
          case 'answer.retry':
            if (!conversation.acceptsInput) break;
            clearCapture();
            if (!store) { void conversation.submit('请继续刚才被打断的回答。', true); break; }
            {
              const prior = store.latestRecoverableTurn(active.id);
              if (!prior) { send({ type: 'notice', text: '当前会话里没有可以恢复的上一轮回答。' }); break; }
              if (prior.output?.status === 'committed') {
                const replayId = `replay-${randomUUID()}`;
                send({ type: 'answer.start', id: replayId, session_id: active.id,
                  message_id: prior.output.id, turn_id: prior.turn.id, sequence: prior.output.sequence, replayed: true });
                if (prior.output.citations?.length) send({ type: 'answer.citations', id: replayId,
                  text: prior.output.content, citations: prior.output.citations });
                else send({ type: 'answer.delta', id: replayId, text: prior.output.content });
                send({ type: 'answer.done', id: replayId, session_id: active.id,
                  message_id: prior.output.id, turn_id: prior.turn.id, sequence: prior.output.sequence, replayed: true });
              } else if (prior.output?.status === 'interrupted' || prior.turn.status === 'interrupted') {
                void conversation.submit('请重新回答刚才被中断的问题。不要执行日历、邮件或其他写操作；如需写入，只生成新的预览并再次等待确认。',
                  true, { retryOfTurnId: prior.turn.id });
              } else send({ type: 'notice', text: '上一轮没有完整回答。请简短重述问题，我会接着处理。' });
            }
            break;
          case 'exit.request': void conversation.requestExit(); break;
          case 'exit.confirm':
            if (typeof msg.confirm !== 'boolean') throw new Error('Confirmation');
            conversation.confirmExit(msg.confirm);
            if (msg.confirm) { await registry.end(active.id); client.close(1000, 'Conversation ended'); }
            break;
          case 'test.session.expire':
            if (!options.localTestControls?.write || !localTestConnection) throw new Error('Test control disabled');
            expireOnClose = true;
            send({ type: 'notice', text: '正在模拟恢复窗口过期；重连后应创建新会话。' });
            client.close(1000, 'Simulated session expiry');
            break;
          case 'test.storage.inspect':
          case 'test.storage.seed_expired':
          case 'test.storage.cleanup_preview':
          case 'test.storage.cleanup_apply': {
            const write = msg.type === 'test.storage.seed_expired' || msg.type === 'test.storage.cleanup_apply';
            if (!options.localTestControls?.read || (write && !options.localTestControls.write)
              || !localTestConnection || !store) throw new Error('Test control disabled');
            const retentionDays = 1095, ownerScope = 'local-retention-test', now = Date.now();
            if (msg.type === 'test.storage.seed_expired') {
              const endedAt = now - retentionDays * 24 * 60 * 60 * 1000 - 60_000;
              const existing = store.cleanupExpiredSessions({ retentionDays, now, dryRun: true, ownerScope });
              if (existing.eligibleSessions === 0) {
                const fixtureId = randomUUID();
                store.createSession({ id: fixtureId, ownerScope, createdAt: endedAt - 1,
                  initialTopic: { id: randomUUID(), label: 'Retention test fixture' } });
                store.endSession(fixtureId, endedAt, 'retention_test_fixture');
              }
            }
            const apply = msg.type === 'test.storage.cleanup_apply';
            const retention = store.cleanupExpiredSessions({ retentionDays, now, dryRun: !apply, ownerScope });
            const [storage, sqlite, current] = await Promise.all([
              store.storageHealth(options.storageWarningBytes), Promise.resolve(store.health()),
              Promise.resolve(store.getSession(active.id)),
            ]);
            send({ type: 'test.storage.report', action: msg.type.slice('test.storage.'.length),
              generated_at: now, sqlite: { schema_version: sqlite.schemaVersion, journal_mode: sqlite.journalMode,
                foreign_keys: sqlite.foreignKeys },
              storage: { database_bytes: storage.databaseBytes, available_disk_bytes: storage.availableDiskBytes,
                sessions: storage.sessions, messages: storage.messages, warnings: storage.warnings },
              current_session: current ? { status: current.status, latest_sequence: current.latestSequence } : undefined,
              retention: { retention_days: retention.retentionDays, cutoff_at: retention.cutoffAt,
                test_eligible_sessions: retention.eligibleSessions, test_eligible_messages: retention.eligibleMessages,
                deleted_sessions: retention.deletedSessions, deleted_messages: retention.deletedMessages } });
            break;
          }
          default: throw new Error('Unknown message');
        }
      } catch { send({ type: 'error', code: 'INVALID_MESSAGE' }); client.close(1008); }
    };
    let incoming = Promise.resolve();
    client.on('message', (raw, binary) => { incoming = incoming.then(() => handleMessage(raw, binary)); });
    client.on('error', () => client.close());
    client.on('close', () => {
      closed = true; releaseAuthSlot(); clearTimeout(authTimer); clearInterval(heartbeat); clearTimeout(pongDeadline);
      clearInterval(idle); clearTimeout(lifetime); clearTimeout(credentialRefresh);
      unsubscribeCalendarHealth?.();
      clearCapture(); session?.setCaptureStop(connectionId, undefined);
      const sessionId = session?.id;
      void registry.detach(connectionId).then(() => expireOnClose && sessionId ? registry.expireDetached(sessionId) : undefined);
    });
  });
  return { http, wss, close: async () => {
    clearInterval(sessionSweep);
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await registry.shutdown();
    await options.sessionSummary?.close();
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
  const dataDirectory = resolve(process.env.EVEN_DATA_DIR ?? '.local');
  // Parse every setting that can fail before a store is opened or migrated.
  const startup = readConversationStartupConfig(process.env);
  const mail = createMailSender();
  const costs = await CostLedger.create(resolve(dataDirectory, 'cost-ledger.json'), process.env, createCostAlertSender());
  const openaiFetch = createMeteredOpenAIFetch(costs);
  const hybrid = createDialogueProvider(process.env, { fetcher: openaiFetch });
  const stt = createSttProvider(process.env, costs);
  const routeProvider = createRouteProvider(process.env, costs);
  const timezoneProvider = createTimezoneProvider(process.env, costs);
  const environmentProvider = createEnvironmentProvider(process.env, costs);
  const jobs = await JobStore.create(dataDirectory, createDocumentRenderer(process.env, openaiFetch));
  const conversationStore = await ConversationStore.create(dataDirectory);
  const maintenanceConfig = startup.maintenance;
  let maintenance: Promise<void> | undefined;
  const maintain = () => maintenance ??= runConversationMaintenance(conversationStore, maintenanceConfig).then(result => {
    const report = { retention_days: result.retention.retentionDays, retention_enabled: result.retention.enabled,
      eligible_sessions: result.retention.eligibleSessions, deleted_sessions: result.retention.deletedSessions,
      deleted_messages: result.retention.deletedMessages, sessions: result.storage.sessions, messages: result.storage.messages,
      database_bytes: result.storage.databaseBytes, available_disk_bytes: result.storage.availableDiskBytes,
      warnings: result.storage.warnings };
    console.log(`Conversation maintenance: ${JSON.stringify(report)}`);
  }).catch(() => { console.error('Conversation maintenance failed; no unverified cleanup retry was attempted.');
  }).finally(() => { maintenance = undefined; });
  await maintain();
  const maintenanceTimer = setInterval(() => { void maintain(); }, 24 * 60 * 60 * 1000);
  maintenanceTimer.unref();
  const sessionSummary = hybrid.provider === 'api' && key
    ? new SessionSummaryService(conversationStore,
      new OpenAISessionSummaryGenerator(key, process.env.SESSION_SUMMARY_MODEL?.trim() || hybrid.models.reply,
        'https://api.openai.com/v1/responses', openaiFetch))
    : undefined;
  let calendar: GoogleCalendarService | undefined;
  if (process.env.GOOGLE_CALENDAR_ENABLED === 'true') {
    try {
      if (!process.env.EMAIL_TO?.trim()) throw new Error('Calendar creation requires a fixed invitation recipient');
      const google = await loadCalendarTransport(dataDirectory);
      calendar = await GoogleCalendarService.create(dataDirectory, google.calendarId, google.transport, Date.now, process.env.EMAIL_TO);
    } catch {
      await Promise.all([sessionSummary?.close(), jobs.close(), conversationStore.close()]);
      throw new Error('Google Calendar setup invalid; check private auth files and calendar binding.');
    }
  }
  const timezoneFallback = calendar && hybrid.provider === 'api' && key
    ? createTimezoneFallback(key, hybrid.models.reply, 'https://api.openai.com/v1/responses', openaiFetch) : undefined;
  const planningEvidenceSelector = hybrid.provider === 'api' && key && environmentProvider
    ? createPlanningEvidenceSelector(key, hybrid.models.reply, 'https://api.openai.com/v1/responses',
      process.env.CONVERSATION_TIMEZONE ?? 'America/Chicago', openaiFetch) : undefined;
  const publicHost = process.env.EVEN_PUBLIC_HOST?.trim().toLowerCase();
  const publicOrigin = process.env.EVEN_PUBLIC_ORIGIN?.trim();
  const app = createConversationServer({ token, ...hybrid,
    conversationStore,
    storageWarningBytes: maintenanceConfig,
    sessionSummary,
    resumeWindowMs: startup.resumeWindowMs,
    localTestControls: startup.localTestControls,
    jobs, mail, calendar, calendarPlanner: calendar && hybrid.provider === 'api' ? createCalendarPlanner(process.env, openaiFetch) : undefined,
    calendarItineraryPlanner: calendar && hybrid.provider === 'api' && key
      ? createCalendarItineraryPlanner(key, hybrid.models.reply, 'https://api.openai.com/v1/responses',
        process.env.CONVERSATION_TIMEZONE ?? 'America/Chicago', openaiFetch) : undefined,
    calendarAnswerer: calendar && hybrid.provider === 'api' ? createCalendarAnswerer(process.env, openaiFetch) : undefined,
    routeProvider,
    timezoneProvider,
    timezoneFallback,
    environmentProvider,
    planningEvidenceSelector,
    draftGenerator: hybrid.provider === 'api' ? createDraftGenerator(process.env, openaiFetch) : undefined,
    capabilities: { provider: hybrid.provider, delivery: hybrid.delivery, webSearch: hybrid.webSearch, speech: stt.configured, speechProvider: stt.name, location: true,
      routes: !!routeProvider, environment: !!planningEvidenceSelector, conditionalTasks: false },
    ingress: publicHost ? { publicHosts: [publicHost], allowedOrigins: publicOrigin ? [publicOrigin] : undefined } : undefined,
    transcriber: delta => stt.create(delta)
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
      clearInterval(maintenanceTimer);
      const deadline = setTimeout(() => process.exit(1), 25000); deadline.unref();
      try {
        await maintenance;
        await Promise.allSettled([app.close()]);
        await calendar?.close();
        await Promise.all([hybrid.close(), jobs.close(), conversationStore.close()]);
      } finally { clearTimeout(deadline); }
    })().catch(() => { process.exitCode = 1; });
  }
  const stopFromSignal = () => { void shutdown().finally(() => process.exit(process.exitCode ?? 0)); };
  process.once('SIGINT', stopFromSignal);
  process.once('SIGTERM', stopFromSignal);
}
