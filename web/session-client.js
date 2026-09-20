const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BACKOFF = [500, 1000, 2000, 5000, 10000, 30000];
const COMMANDS = new Set(['turn.submit', 'pause', 'resume', 'interrupt', 'answer.retry', 'exit.request']);
const CLIENT_KEY = 'conversation-lab.client-id.v2', RESUME_KEY = 'conversation-lab.resume.v2';

export function isLoopbackHost(hostname) { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname); }
export function browserReconnectDelay(attempt, random = Math.random) {
  return Math.min(30000, Math.round(BACKOFF[Math.min(Math.max(0, attempt), BACKOFF.length - 1)] * (0.8 + Math.min(1, Math.max(0, random())) * 0.4)));
}

export class BrowserSessionClient {
  constructor({ url, storage = localStorage, socket = value => new WebSocket(value), onEvent, onStatus = () => {},
    random = Math.random, uuid = () => crypto.randomUUID(), setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    this.url = url; this.storage = storage; this.socketFactory = socket; this.onEvent = onEvent; this.onStatus = onStatus;
    this.random = random; this.uuid = uuid; this.setTimer = setTimer; this.clearTimer = clearTimer; this.now = now;
    this.socket = undefined; this.timer = undefined; this.attempt = 0; this.generation = 0; this.lastSeen = 0;
    this.token = ''; this.disposed = false; this.ending = false; this.forceFresh = false; this.recoveryFailed = false; this.lastSubmission = undefined;
  }
  clientId() {
    try { const current = this.storage.getItem(CLIENT_KEY); if (UUID.test(current ?? '')) return current;
      const created = this.uuid(); this.storage.setItem(CLIENT_KEY, created); return created; }
    catch { return this.uuid(); }
  }
  credential() {
    try { const value = JSON.parse(this.storage.getItem(RESUME_KEY) || 'null');
      if (!value || !UUID.test(value.clientId) || !UUID.test(value.sessionId) || typeof value.secret !== 'string'
        || value.secret.length < 32 || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= this.now()
        || Object.keys(value).some(key => !['clientId', 'sessionId', 'secret', 'expiresAt'].includes(key))) throw Error('invalid');
      return value;
    } catch { try { this.storage.removeItem(RESUME_KEY); } catch {} return undefined; }
  }
  saveCredential(event) {
    const value = { clientId: this.clientId(), sessionId: event.session_id,
      secret: event.resume_credential, expiresAt: event.resume_expires_at };
    if (!UUID.test(value.sessionId) || typeof value.secret !== 'string' || value.secret.length < 32
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= this.now()) return false;
    try { this.storage.setItem(RESUME_KEY, JSON.stringify(value)); return true; } catch { return false; }
  }
  clearCredential() { try { this.storage.removeItem(RESUME_KEY); } catch {} }
  connect(token = '') {
    if (this.disposed) return false; if (token.trim()) this.token = token.trim();
    this.ending = false; this.forceFresh = false; this.recoveryFailed = false; this.attempt = 0; this.cancelTimer();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) return false;
    return this.open(false);
  }
  resumeIfAvailable() { if (!this.credential() || this.disposed) return false; return this.open(true); }
  open(recovering) {
    const credential = this.forceFresh ? undefined : this.credential();
    if (!credential && !this.token) { this.onStatus({ state: 'disconnected', reason: this.forceFresh ? 'credential_expired' : 'token_required' }); return false; }
    const ws = this.socketFactory(this.url), generation = ++this.generation; this.socket = ws;
    this.onStatus({ state: recovering || this.attempt ? 'recovering' : 'connecting', attempt: this.attempt });
    ws.onopen = () => { if (this.socket !== ws || generation !== this.generation) return ws.close();
      const hello = { type: 'hello', protocol_version: 2, client_id: credential?.clientId ?? this.clientId() };
      if (credential) Object.assign(hello, { resume_session_id: credential.sessionId, resume_credential: credential.secret, last_seen_sequence: this.lastSeen });
      else hello.token = this.token; ws.send(JSON.stringify(hello)); };
    ws.onmessage = ({ data }) => { if (this.socket !== ws || generation !== this.generation || typeof data !== 'string') return;
      let event; try { event = JSON.parse(data); } catch { return; }
      if (event.type === 'ready' && event.protocol_version === 2 && this.saveCredential(event)) {
        this.forceFresh = false; this.attempt = 0; this.observe(event.latest_sequence);
        const reason = event.resumed ? 'resumed' : this.recoveryFailed ? 'new_session' : undefined;
        this.recoveryFailed = false;
        this.onStatus({ state: 'connected', reason,
          connectionId: event.connection_id, sessionId: event.session_id });
      } else if (event.type === 'resume.credential') this.saveCredential(event);
      else if (event.type === 'message.ack' || event.type === 'answer.committed') this.observe(event.sequence);
      else if (event.type === 'error' && event.code === 'SESSION_UNAVAILABLE') { this.clearCredential(); this.forceFresh = true; this.recoveryFailed = true; }
      this.onEvent(event); };
    ws.onerror = () => { if (this.socket === ws) this.onStatus({ state: 'recovering', reason: 'offline' }); };
    ws.onclose = () => { if (this.socket !== ws || generation !== this.generation) return; this.socket = undefined;
      if (this.disposed || this.ending) return this.onStatus({ state: 'disconnected' }); this.schedule(); };
    return true;
  }
  observe(sequence) { if (Number.isSafeInteger(sequence) && sequence >= 0) this.lastSeen = Math.max(this.lastSeen, sequence); }
  schedule() { if (this.timer || this.disposed || this.ending) return; const delay = browserReconnectDelay(this.attempt, this.random), attempt = ++this.attempt;
    this.onStatus({ state: 'recovering', reason: this.forceFresh ? 'credential_expired' : 'reconnecting', attempt, retryInMs: delay });
    this.timer = this.setTimer(() => { this.timer = undefined; this.open(true); }, delay); }
  cancelTimer() { if (this.timer === undefined) return; this.clearTimer(this.timer); this.timer = undefined; }
  networkAvailable() { if (this.disposed || this.ending || this.socket?.readyState === WebSocket.OPEN) return false; this.cancelTimer(); return this.open(true); }
  envelope(value) { const message = { ...value };
    if (message.type === 'text.submit' && !message.message_id) message.message_id = this.uuid();
    if ((COMMANDS.has(message.type) || ['exit.confirm', 'test.session.expire'].includes(message.type)) && !message.command_id) message.command_id = this.uuid();
    return message; }
  send(value) { if (this.socket?.readyState !== WebSocket.OPEN) return false; const message = this.envelope(value);
    if (message.type === 'text.submit') this.lastSubmission = message; this.socket.send(JSON.stringify(message)); return true; }
  sendBinary(value) { if (this.socket?.readyState !== WebSocket.OPEN) return false; this.socket.send(value); return true; }
  repeatLastSubmission() { if (!this.lastSubmission || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(this.lastSubmission)); return true; }
  simulateDrop() { if (!this.socket) return false; this.socket.close(4000, 'Simulator drop'); return true; }
  simulateExpiry() { if (this.socket?.readyState !== WebSocket.OPEN || !this.token) return false;
    this.forceFresh = true; this.recoveryFailed = true; this.clearCredential(); return this.send({ type: 'test.session.expire' }); }
  confirmExit(confirm) { if (confirm) { this.ending = true; this.clearCredential(); this.cancelTimer(); } return this.send({ type: 'exit.confirm', confirm }); }
  dispose() { this.disposed = true; this.cancelTimer(); const ws = this.socket; this.socket = undefined; this.generation++; ws?.close(); }
}
