import { SessionCredentialStore, type DeviceCredential, type ResumeSessionCredential } from './session-credential.ts';

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
  onclose: null | ((event?: { code?: number }) => void);
  onerror: null | (() => void);
  onmessage: null | ((event: { data: unknown }) => void);
};

type Timer = ReturnType<typeof setTimeout>;
type ControllerOptions = {
  url: () => string;
  socket: (url: string) => SocketLike;
  credentials: SessionCredentialStore;
  /** May return a promise for the physical display-clear barrier. */
  onEvent: (event: any) => unknown;
  onStatus?: (status: ConnectionStatus) => void;
  now?: () => number;
  random?: () => number;
  uuid?: () => string;
  setTimer?: (callback: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  clientCapabilities?: { location: boolean };
};

const OPEN = 1;
const CLOSING = 2;
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
const COMMAND_TYPES = new Set(['turn.begin', 'turn.submit', 'pause', 'resume', 'interrupt', 'answer.retry', 'exit.request']);

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
  private deviceAttempted = false;
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
    if (this.disposed || (!this.options.credentials.load() && !this.options.credentials.loadDevice())) return false;
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
    const deviceCredential = this.options.credentials.loadDevice();
    if (!credential && !deviceCredential && !this.accessToken) {
      this.update({ state: 'disconnected', reason: this.forceFresh ? 'credential_expired' : 'offline' });
      return false;
    }
    const generation = ++this.generation;
    const ws = this.options.socket(this.options.url());
    this.socketValue = ws;
    this.resumeAttempted = !!credential;
    this.deviceAttempted = !credential && !!deviceCredential;
    this.update({ state: recovering || this.attempt > 0 ? 'recovering' : 'connecting',
      reason: recovering || this.attempt > 0 ? 'reconnecting' : undefined, attempt: this.attempt });
    ws.onopen = () => {
      if (!this.current(ws, generation)) return ws.close();
      const hello: Record<string, unknown> = {
        type: 'hello', protocol_version: 2, client_id: credential?.clientId ?? this.options.credentials.clientId(),
        credential_storage: 'even_host_v1',
      };
      hello.client_capabilities = { location: false, ...this.options.clientCapabilities, guest_mode: true };
      if (credential) {
        hello.resume_session_id = credential.sessionId;
        hello.resume_credential = credential.secret;
        hello.last_seen_sequence = this.lastSeenSequence;
      } else if (deviceCredential) hello.device_credential = deviceCredential.secret;
      else hello.token = this.accessToken;
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = event => {
      if (!this.current(ws, generation) || typeof event.data !== 'string') return;
      let message: any;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'access.changed') { void this.accessChanged(message, ws); return; }
      if (message.type === 'ready') this.ready(message, ws, generation);
      else if (message.type === 'resume.credential') this.replaceCredential(message);
      else if (message.type === 'message.ack' || message.type === 'answer.committed') this.observeSequence(message.sequence);
      else if (message.type === 'error' && message.code === 'SESSION_UNAVAILABLE') {
        void this.options.credentials.clearSession();
        this.forceFresh = true;
        this.recoveryFailed = true;
        this.update({ state: 'recovering', reason: 'credential_expired', attempt: this.attempt });
      } else if (message.type === 'error' && message.code === 'DEVICE_CREDENTIAL_INVALID') {
        void this.options.credentials.clearDevice();
        this.forceFresh = true;
        this.recoveryFailed = true;
        this.update({ state: 'recovering', reason: 'credential_expired', attempt: this.attempt });
      }
      this.options.onEvent(message);
    };
    ws.onerror = () => {
      if (this.current(ws, generation) && this.state !== 'connected') this.update({ state: 'recovering', reason: 'offline', attempt: this.attempt });
    };
    ws.onclose = event => {
      if (!this.current(ws, generation)) return;
      this.socketValue = undefined;
      this.lastSeenSequence = 0;
      if (event?.code === 4003) {
        this.accessToken = ''; this.ending = true;
        void this.options.credentials.clearSession(); void this.options.credentials.clearDevice();
      }
      this.options.onEvent({ type: 'transport.cleared', recoverable: !this.disposed && !this.ending });
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

  private async accessChanged(message: any, socket: SocketLike) {
    this.ending = true; this.cancelRetry(); this.accessToken = ''; this.lastSeenSequence = 0;
    this.socketValue = undefined; const generation = ++this.generation;
    const clearView = Promise.resolve(this.options.onEvent(message)).then(() => true, () => false); socket.close();
    this.update({ state: 'disconnected' });
    const cleared = await this.options.credentials.clearSession();
    const unlocked = message.mode === 'reauthorize';
    const deviceCleared = unlocked ? await this.options.credentials.clearDevice() : true;
    if (!await clearView) { this.options.onEvent({ type: 'notice', text: '眼镜清屏未确认，请重新打开应用；尚未重连。' }); return; }
    if (!cleared || !deviceCleared) {
      this.options.onEvent({ type: 'notice', text: '恢复引用清理未确认，请重新打开应用后再连接。' }); return;
    }
    if (!this.disposed && this.generation === generation && message.mode === 'guest' && message.reconnect === true) {
      this.ending = false; this.forceFresh = true; this.open(true);
    }
  }

  private ready(message: any, socket: SocketLike, generation: number) {
    if (message.protocol_version !== 2 || typeof message.connection_id !== 'string'
      || typeof message.session_id !== 'string' || typeof message.resume_credential !== 'string'
      || !Number.isSafeInteger(message.resume_expires_at)) return;
    const clientId = this.options.credentials.clientId();
    if (message.access_mode === 'guest') this.accessToken = '';
    if (this.statusValue.sessionId !== message.session_id) this.lastSeenSequence = 0;
    const credential: ResumeSessionCredential = { clientId, sessionId: message.session_id,
      secret: message.resume_credential, expiresAt: message.resume_expires_at };
    this.persistCredential(credential);
    if (message.device_credential_id !== undefined || message.device_credential !== undefined
      || message.device_expires_at !== undefined || message.device_persist_deadline_at !== undefined) {
      if (typeof message.device_credential_id !== 'string' || typeof message.device_credential !== 'string'
        || !Number.isSafeInteger(message.device_expires_at) || !Number.isSafeInteger(message.device_persist_deadline_at)) return;
      const device: DeviceCredential = { clientId, id: message.device_credential_id,
        secret: message.device_credential, expiresAt: message.device_expires_at };
      try {
        void this.options.credentials.saveDevice(device).then(saved => {
          if (!this.current(socket, generation)) return;
          if (saved && socket.readyState === OPEN) socket.send(JSON.stringify({
            type: 'credential.persisted', credential_id: device.id,
          }));
          else if (!saved) this.options.onEvent({ type: 'notice', text: '设备恢复凭证未保存；冷启动后可能需要重新输入应用 token' });
        });
      } catch {
        void this.options.credentials.clearDevice();
      }
    }
    this.forceFresh = false;
    this.attempt = 0;
    this.cancelRetry();
    this.observeSequence(message.latest_sequence);
    const reason = message.resumed === true ? 'resumed'
      : this.recoveryFailed || this.resumeAttempted || this.deviceAttempted ? 'new_session' : undefined;
    this.recoveryFailed = false;
    this.deviceAttempted = false;
    this.update({ state: 'connected', reason, connectionId: message.connection_id, sessionId: message.session_id });
  }

  private replaceCredential(message: any) {
    const current = this.options.credentials.load();
    if (!current || current.sessionId !== message.session_id || typeof message.resume_credential !== 'string'
      || !Number.isSafeInteger(message.resume_expires_at)) return;
    this.persistCredential({ ...current, secret: message.resume_credential, expiresAt: message.resume_expires_at });
  }

  private persistCredential(credential: ResumeSessionCredential) {
    try {
      void this.options.credentials.save(credential).then(saved => {
        if (!saved) this.options.onEvent({ type: 'notice', text: '会话恢复凭证未保存；应用重开后可能需要重新连接' });
      });
    } catch {
      void this.options.credentials.clearSession();
    }
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
    if (this.socketValue && this.socketValue.readyState < CLOSING) return false;
    this.cancelRetry();
    return this.open(true);
  }

  send(value: Record<string, unknown>) {
    const ws = this.socketValue;
    if (!ws || ws.readyState !== OPEN) return false;
    const message = { ...value };
    if (message.type === 'text.submit' && message.message_id === undefined) message.message_id = this.options.uuid();
    if ((COMMAND_TYPES.has(String(message.type)) || message.type === 'exit.confirm' || String(message.type).startsWith('test.') || String(message.type).startsWith('guest.'))
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
      void this.options.credentials.clearSession();
    }
    return this.send({ type: 'exit.confirm', confirm });
  }

  forgetResumeCredential() {
    if (!this.connected || (!this.accessToken && !this.options.credentials.loadDevice())) return false;
    this.forceFresh = true;
    this.recoveryFailed = true;
    void this.options.credentials.clearSession();
    return true;
  }

  reconnectNow() {
    if (!this.connected || !this.socketValue) return false;
    this.socketValue.close(4000, 'Reconnect requested');
    return true;
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
