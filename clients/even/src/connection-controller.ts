import { SessionCredentialStore, type ResumeSessionCredential } from './session-credential.ts';

export type ClientConnectionState = 'disconnected' | 'connecting' | 'connected' | 'recovering';
export type ConnectionStatus = {
  state: ClientConnectionState;
  reason?: 'reconnecting' | 'resumed' | 'new_session' | 'credential_expired' | 'offline' | 'disposed';
  attempt?: number;
  retryInMs?: number;
  connectionId?: string;
  sessionId?: string;
};

export type SocketLike = {
  readyState: number;
  bufferedAmount?: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: null | (() => void);
  onclose: null | (() => void);
  onerror: null | (() => void);
  onmessage: null | ((event: { data: unknown }) => void);
};

type Timer = ReturnType<typeof setTimeout>;
type ControllerOptions = {
  url: () => string;
  socket: (url: string) => SocketLike;
  credentials: SessionCredentialStore;
  onEvent: (event: any) => void;
  onStatus?: (status: ConnectionStatus) => void;
  now?: () => number;
  random?: () => number;
  uuid?: () => string;
  setTimer?: (callback: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
};

const OPEN = 1;
const CLOSING = 2;
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
const COMMAND_TYPES = new Set(['turn.submit', 'pause', 'resume', 'interrupt', 'answer.retry', 'exit.request']);

export function reconnectDelay(attempt: number, random = Math.random) {
  const base = BACKOFF_MS[Math.min(Math.max(0, attempt), BACKOFF_MS.length - 1)];
  return Math.min(30_000, Math.round(base * (0.8 + Math.min(1, Math.max(0, random())) * 0.4)));
}

export class ConnectionController {
  private readonly options: Required<Pick<ControllerOptions, 'now' | 'random' | 'uuid' | 'setTimer' | 'clearTimer'>> & ControllerOptions;
  private socketValue?: SocketLike;
  private retryTimer?: Timer;
  private attempt = 0;
  private generation = 0;
  private accessToken = '';
  private disposed = false;
  private ending = false;
  private forceFresh = false;
  private recoveryFailed = false;
  private lastSeenSequence = 0;
  private resumeAttempted = false;
  private statusValue: ConnectionStatus = { state: 'disconnected' };

  constructor(options: ControllerOptions) {
    this.options = {
      ...options,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
      uuid: options.uuid ?? (() => crypto.randomUUID()),
      setTimer: options.setTimer ?? ((callback, delay) => setTimeout(callback, delay)),
      clearTimer: options.clearTimer ?? (timer => clearTimeout(timer)),
    };
  }

  get state() { return this.statusValue.state; }
  get status() { return { ...this.statusValue }; }
  get socket() { return this.socketValue; }
  get connected() { return this.state === 'connected' && this.socketValue?.readyState === OPEN; }

  connect(token = '') {
    if (this.disposed) return false;
    if (token.trim()) this.accessToken = token.trim();
    this.ending = false;
    this.forceFresh = false;
    this.recoveryFailed = false;
    this.attempt = 0;
    this.cancelRetry();
    if (this.socketValue && this.socketValue.readyState < CLOSING) return false;
    return this.open(false);
  }

  resumeIfAvailable() {
    if (this.disposed || !this.options.credentials.load()) return false;
    this.cancelRetry();
    return this.open(true);
  }

  private update(status: ConnectionStatus) {
    this.statusValue = status;
    this.options.onStatus?.({ ...status });
  }

  private open(recovering: boolean) {
    if (this.disposed) return false;
    const credential = this.forceFresh ? undefined : this.options.credentials.load();
    if (!credential && !this.accessToken) {
      this.update({ state: 'disconnected', reason: this.forceFresh ? 'credential_expired' : 'offline' });
      return false;
    }
    const generation = ++this.generation;
    const ws = this.options.socket(this.options.url());
    this.socketValue = ws;
    this.resumeAttempted = !!credential;
    this.update({ state: recovering || this.attempt > 0 ? 'recovering' : 'connecting',
      reason: recovering || this.attempt > 0 ? 'reconnecting' : undefined, attempt: this.attempt });
    ws.onopen = () => {
      if (!this.current(ws, generation)) return ws.close();
      const hello: Record<string, unknown> = {
        type: 'hello', protocol_version: 2, client_id: credential?.clientId ?? this.options.credentials.clientId(),
      };
      if (credential) {
        hello.resume_session_id = credential.sessionId;
        hello.resume_credential = credential.secret;
        hello.last_seen_sequence = this.lastSeenSequence;
      } else hello.token = this.accessToken;
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = event => {
      if (!this.current(ws, generation) || typeof event.data !== 'string') return;
      let message: any;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'ready') this.ready(message);
      else if (message.type === 'resume.credential') this.replaceCredential(message);
      else if (message.type === 'message.ack' || message.type === 'answer.committed') this.observeSequence(message.sequence);
      else if (message.type === 'error' && message.code === 'SESSION_UNAVAILABLE') {
        this.options.credentials.clearSession();
        this.forceFresh = true;
        this.recoveryFailed = true;
        this.update({ state: 'recovering', reason: 'credential_expired', attempt: this.attempt });
      }
      this.options.onEvent(message);
    };
    ws.onerror = () => {
      if (this.current(ws, generation) && this.state !== 'connected') this.update({ state: 'recovering', reason: 'offline', attempt: this.attempt });
    };
    ws.onclose = () => {
      if (!this.current(ws, generation)) return;
      this.socketValue = undefined;
      if (this.disposed || this.ending) {
        this.cancelRetry();
        this.update({ state: 'disconnected', reason: this.disposed ? 'disposed' : undefined });
        return;
      }
      this.scheduleReconnect();
    };
    return true;
  }

  private current(socket: SocketLike, generation: number) {
    return this.socketValue === socket && this.generation === generation;
  }

  private ready(message: any) {
    if (message.protocol_version !== 2 || typeof message.connection_id !== 'string'
      || typeof message.session_id !== 'string' || typeof message.resume_credential !== 'string'
      || !Number.isSafeInteger(message.resume_expires_at)) return;
    const clientId = this.options.credentials.clientId();
    const credential: ResumeSessionCredential = { clientId, sessionId: message.session_id,
      secret: message.resume_credential, expiresAt: message.resume_expires_at };
    try { this.options.credentials.save(credential); } catch { this.options.credentials.clearSession(); }
    this.forceFresh = false;
    this.attempt = 0;
    this.cancelRetry();
    this.observeSequence(message.latest_sequence);
    const reason = message.resumed === true ? 'resumed' : this.recoveryFailed || this.resumeAttempted ? 'new_session' : undefined;
    this.recoveryFailed = false;
    this.update({ state: 'connected', reason, connectionId: message.connection_id, sessionId: message.session_id });
  }

  private replaceCredential(message: any) {
    const current = this.options.credentials.load();
    if (!current || current.sessionId !== message.session_id || typeof message.resume_credential !== 'string'
      || !Number.isSafeInteger(message.resume_expires_at)) return;
    this.options.credentials.save({ ...current, secret: message.resume_credential, expiresAt: message.resume_expires_at });
  }

  private observeSequence(value: unknown) {
    if (Number.isSafeInteger(value) && Number(value) >= 0) this.lastSeenSequence = Math.max(this.lastSeenSequence, Number(value));
  }

  private scheduleReconnect() {
    if (this.retryTimer || this.disposed || this.ending) return;
    const delay = reconnectDelay(this.attempt, this.options.random);
    const attempt = ++this.attempt;
    this.update({ state: 'recovering', reason: this.forceFresh ? 'credential_expired' : 'reconnecting', attempt, retryInMs: delay });
    this.retryTimer = this.options.setTimer(() => {
      this.retryTimer = undefined;
      this.open(true);
    }, delay);
  }

  private cancelRetry() {
    if (!this.retryTimer) return;
    this.options.clearTimer(this.retryTimer);
    this.retryTimer = undefined;
  }

  networkAvailable() {
    if (this.disposed || this.ending || this.connected) return false;
    this.cancelRetry();
    return this.open(true);
  }

  send(value: Record<string, unknown>) {
    const ws = this.socketValue;
    if (!ws || ws.readyState !== OPEN) return false;
    const message = { ...value };
    if (message.type === 'text.submit' && message.message_id === undefined) message.message_id = this.options.uuid();
    if ((COMMAND_TYPES.has(String(message.type)) || message.type === 'exit.confirm' || message.type === 'test.session.expire')
      && message.command_id === undefined) message.command_id = this.options.uuid();
    ws.send(JSON.stringify(message));
    return true;
  }

  sendBinary(value: ArrayBuffer | ArrayBufferView) {
    const ws = this.socketValue;
    if (!ws || ws.readyState !== OPEN) return false;
    ws.send(value); return true;
  }

  confirmExit(confirm: boolean) {
    if (confirm) {
      this.ending = true;
      this.cancelRetry();
      this.options.credentials.clearSession();
    }
    return this.send({ type: 'exit.confirm', confirm });
  }

  simulateSessionExpiry() {
    if (!this.connected || !this.accessToken) return false;
    this.forceFresh = true;
    this.recoveryFailed = true;
    this.options.credentials.clearSession();
    return this.send({ type: 'test.session.expire' });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRetry();
    const ws = this.socketValue;
    this.socketValue = undefined;
    this.generation++;
    ws?.close();
    this.update({ state: 'disconnected', reason: 'disposed' });
  }
}
