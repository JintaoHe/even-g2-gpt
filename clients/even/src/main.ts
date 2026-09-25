import { waitForEvenAppBridge, CreateStartUpPageContainer, RebuildPageContainer, TextContainerProperty, TextContainerUpgrade,
  DeviceConnectType, OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { ReadingHistory } from './reading-history';
import { DisplaySession } from './display-session';
import { conversationWebSocketUrl } from './backend-url';
import { LocationController, locationReport } from './location';
import { AudioController } from './audio-controller';
import { ConnectionController, type ConnectionStatus } from './connection-controller';
import { SessionCredentialStore } from './session-credential';

const element = (id: string) => document.getElementById(id)!;
const packagedBackendOrigin = typeof __EVEN_BACKEND_ORIGIN__ === 'string' ? __EVEN_BACKEND_ORIGIN__ : '';
const connectionLabel = typeof __EVEN_CONNECTION_LABEL__ === 'string' ? __EVEN_CONNECTION_LABEL__ : '连接配置不可见';
element('backend-target').textContent = `连接目标：${connectionLabel}`;
element('recovery-window').textContent = '会话恢复窗口：连接后由服务器确认';
const pager = new ReadingHistory('manual-pages');
const display = new DisplaySession();
let shutdown: Promise<void> | undefined;
pager.reset('请在伴随页面连接后端。\n首轮自动开麦，之后长按说话、松手发送。');
let bridge: EvenAppBridge | undefined, audioController: AudioController | undefined;
let developmentSessionControls: { handleEvent: (event: any) => boolean } | undefined;
let locationController: LocationController | undefined, locationAvailable = false;
let developmentLocation: { label: string; latitude: number; longitude: number; accuracy: number; timezone: string } | undefined;
let connected = false, speech = false, audio = false, state = 'closed', channel = '?';
let status = '未连接', answerId: unknown, dirty = true, drawing = false, last = '', disposed = false, exiting = false;
let hasReady = false;
let lastHeader = '', viewRevision = 0;
let startupResumePending = true, startupCapture = true, startupResumeInFlight = false;
let pushToTalkAvailable = false, holding = false, holdGeneration = 0;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
let memorySessionId: string | undefined, memoryBoundary: string | undefined;
const memoryResetText = '本次对话的上下文已更新，请重新提出需要继续的问题。';
function resetMemoryView(text = memoryResetText) {
  viewRevision++; lastHeader = '';
  answerId = undefined; void stopAudio(); void locationController?.stop();
  pager.reset(text); last = ''; status = text;
  (element('text') as HTMLTextAreaElement).value = '';
}
let accessMode = 'unknown';
async function clearPrivateView(text: string, preserveMicIntent = false) {
  viewRevision++; lastHeader = '';
  hasReady = false; answerId = undefined; connected = false; state = 'closed';
  void preserveMicIntent;
  void stopAudio();
  void locationController?.stop();
  pager.reset(text); last = ''; status = text;
  element('preview').textContent = text;
  element('connection-meta').textContent = '';
  (element('token') as HTMLInputElement).value = '';
  (element('text') as HTMLTextAreaElement).value = '';
  (element('guest-enter') as HTMLButtonElement).disabled = true;
  (element('guest-unlock') as HTMLButtonElement).disabled = true;
  refresh();
  // Wait behind any in-flight BLE write, then overwrite it before permitting
  // automatic guest reconnection. A failed SDK clear must not claim success.
  while (drawing && !disposed) await new Promise(resolve => setTimeout(resolve, 10));
  if (bridge && display.open && !disposed && !exiting) {
    drawing = true;
    try {
      if (!await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 2,
        containerName: 'status', content: '已清屏 OFF' }))) throw Error('Display clear failed');
      if (!await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1,
        containerName: 'conversation', content: text }))) throw Error('Display clear failed');
      last = text; lastHeader = '已清屏 OFF';
    } finally { drawing = false; }
  }
}
const active = () => connected && !exiting && !disposed && !['paused', 'exit_pending', 'closed'].includes(state);
let credentialStore: SessionCredentialStore;
let connection: ConnectionController;
function send(event: Record<string, unknown>) { connection?.send(event); }
function microphoneStatus() {
  if (connected && speech && !pushToTalkAvailable) return '按住说话需要更新后端；当前仅可输入文字';
  if (audioController?.state === 'requires_reopen') return '开麦失败：请重新打开应用';
  if (audioController?.state === 'unavailable') return '麦克风暂时不可用';
  if (audioController?.state === 'starting') return '正在开启麦克风';
  if (audio) return status;
  if (connected && speech && state === 'listening') return audioController?.desired
    ? '麦克风未就绪，尚未收音' : '麦克风已暂停，长按说话，松手发送';
  return status;
}
function refresh() { dirty = true; element('status').textContent = `${microphoneStatus()} · 麦克风${audio ? '开启' : '关闭'}`; }
function syncAudioAvailability() { void audioController?.setBackendAvailable(active() && speech && display.open); }
const locationPermissionKey = 'glass-assistant.location-succeeded.v1';
function firstLocationRequest() {
  try { return localStorage.getItem(locationPermissionKey) !== '1'; }
  catch { return true; }
}
function rememberLocationSuccess() {
  try { localStorage.setItem(locationPermissionKey, '1'); }
  catch { /* The hint can safely reappear when storage is unavailable. */ }
}
async function automaticLocation(event: any, ws: WebSocket) {
  if (!bridge || !locationController || !locationAvailable || typeof event.request_id !== 'string'
    || !Array.isArray(event.attempts) || event.attempts.length < 1 || event.attempts.length > 3
    || !event.attempts.every((a: any) => a && ['high', 'medium'].includes(a.accuracy)
      && Number.isInteger(a.timeout_ms) && a.timeout_ms >= 1000 && a.timeout_ms <= 10_000)
    || !Number.isFinite(event.maximum_accuracy_m)) {
    send({ type: 'location.failed', request_id: event.request_id, reason: 'unavailable' }); return;
  }
  if (import.meta.env.DEV && developmentLocation) {
    const selected = developmentLocation;
    const report = locationReport('once', {
      latitude: selected.latitude, longitude: selected.longitude,
      accuracy: selected.accuracy, timestamp: Date.now()
    }, event.request_id, selected.timezone);
    status = `模拟定位 · ${selected.label}`; refresh();
    if (connection.socket === ws && ws.readyState === WebSocket.OPEN && report) send(report);
    else send({ type: 'location.failed', request_id: event.request_id, reason: 'unavailable' });
    return;
  }
  if (firstLocationRequest()) {
    pager.notice('首次定位可能在手机上弹出权限请求。\n请选择允许使用期间访问位置。');
  }
  const result = await locationController.automatic(event.request_id, event.attempts, event.maximum_accuracy_m,
    (attempt, total) => { status = `正在定位 ${attempt}/${total}`; refresh(); });
  if (result.ok) {
    rememberLocationSuccess();
    // Continuous updates are opt-in; automatic requests only acquire one fix.
  }
  if (connection.socket !== ws || ws.readyState !== WebSocket.OPEN || result.ok || result.reason === 'cancelled') return;
  send({ type: 'location.failed', request_id: event.request_id, reason: result.reason });
}
async function stopAudio() {
  startupCapture = false;
  holding = false; holdGeneration++; clearTimeout(holdTimer); holdTimer = undefined;
  await audioController?.setDesired(false);
}
function beginHold() {
  if (holding) return;
  if (!bridge || !connected || !speech || !pushToTalkAvailable || exiting || disposed
    || state === 'exit_pending' || !display.open || !audioController || audioController.state === 'requires_reopen') {
    status = '按住说话尚不可用，请确认连接及后端版本'; refresh(); return;
  }
  holding = true;
  startupCapture = false;
  const generation = ++holdGeneration, socket = connection.socket;
  if (state === 'paused') send({ type: 'resume' });
  send({ type: 'turn.begin' });
  holdTimer = setTimeout(() => { endHold(); status = '已到 60 秒录音上限，已停止并提交'; refresh(); }, 60_000);
  void audioController.setDesired(true);
  if (locationAvailable && locationController) {
    if (firstLocationRequest()) pager.notice('首次定位可能在手机上请求权限；定位不会阻塞录音。');
    void locationController.once(() => holding && generation === holdGeneration && connected
      && connection.socket === socket).then(ok => { if (ok) rememberLocationSuccess(); }).catch(() => {});
  }
  refresh();
}
function endHold() {
  if (!holding) return;
  void stopAudio(); // PCM gate closes synchronously, before the native close ACK.
  if (connected) send({ type: 'turn.submit' });
  status = '已停止收音，正在提交识别'; refresh();
}
function exitDialog() {
  if (shutdown) return shutdown;
  shutdown = requestExit().finally(() => { shutdown = undefined; });
  return shutdown;
}
async function requestExit() {
  if (exiting) return;
  exiting = true;
  display.close();
  await stopAudio();
  if (bridge) {
    const ok = await bridge.shutDownPageContainer(1).catch(() => false);
    if (!ok) { status = '系统退出请求未成功，请点恢复后重试'; refresh(); }
  } else { status = '无 SDK：已停收音，恢复按钮可取消退出'; refresh(); }
  // An SDK acknowledgement is not proof the user confirmed. Stay paused until
  // unload/disconnect, or explicit cancellation through the companion control.
}
function handleConnectionStatus(next: ConnectionStatus) {
  connected = next.state === 'connected';
  if (next.state === 'recovering') status = next.reason === 'credential_expired'
    ? '恢复凭证已过期，正在建立新会话'
    : `正在重连${next.attempt ? ` · 第 ${next.attempt} 次` : ''}`;
  else if (next.state === 'connecting') status = '正在连接后端';
  else if (next.state === 'disconnected' && next.reason === 'credential_expired') status = '恢复凭证已过期，请重新输入应用 token';
  else if (next.state === 'disconnected' && next.reason !== 'disposed') status = '连接已断开；等待恢复或重新连接';
  if (next.connectionId && next.sessionId) {
    const mode = next.reason === 'resumed' ? '会话已恢复' : next.reason === 'new_session' ? '恢复失败后新会话' : '新会话';
    element('connection-meta').textContent = `${mode} · 连接 ${next.connectionId.slice(0, 8)} · 会话 ${next.sessionId.slice(0, 8)}`;
  }
  syncAudioAvailability(); refresh();
}

function handleServerEvent(event: any) {
    if (event.type === 'access.changed' || event.type === 'transport.cleared') {
      memorySessionId = undefined; memoryBoundary = undefined;
      const text = event.mode === 'guest' ? '访客模式已锁定，正在连接。'
        : event.mode === 'reauthorize' ? '访客模式已结束，请重新输入主人凭证连接。' : '连接已断开，旧画面已清除。';
      const recoverable = event.type === 'transport.cleared' && event.recoverable === true;
      accessMode = event.mode ?? 'unknown'; const clearing = clearPrivateView(text, recoverable);
      element('access-mode').textContent = text;
      if (event.type === 'access.changed') return clearing;
      void clearing.catch(() => { status = '眼镜清屏未确认，请重新打开应用'; refresh(); }); return;
    }
    if (event.type === 'guest.unlock.challenge') {
      const field = element('token') as HTMLInputElement;
      const token = field.value.trim(); field.value = '';
      if (token) send({ type: 'guest.unlock.confirm', challenge: event.challenge, owner_token: token.trim() });
      else { status = '请在密码框重新输入主人凭证，再点主人重新授权'; refresh(); }
      return;
    }
    developmentSessionControls?.handleEvent(event);
    if (event.type === 'ready') {
      const startupReady = !hasReady && startupResumePending;
      const boundary = typeof event.memory_boundary === 'string' ? event.memory_boundary : undefined;
      const memoryChanged = hasReady && typeof event.session_id === 'string' && event.session_id === memorySessionId
        && memoryBoundary !== undefined && boundary !== undefined && memoryBoundary !== boundary;
      if (memoryChanged) resetMemoryView();
      if (event.session_id !== memorySessionId) memoryBoundary = undefined;
      memorySessionId = event.session_id;
      if (boundary !== undefined) memoryBoundary = boundary;
      accessMode = event.access_mode ?? 'owner';
      element('access-mode').textContent = accessMode === 'guest' ? '访客模式 · 仅本次会话，无主人邮件、日历和历史权限' : '主人模式';
      (element('guest-enter') as HTMLButtonElement).disabled = !event.guest_mode_enabled || accessMode !== 'owner';
      (element('guest-unlock') as HTMLButtonElement).disabled = !event.guest_mode_enabled || accessMode !== 'guest';
      if (event.resumed === true && Array.isArray(event.snapshot?.messages)) pager.restoreSnapshot(event.snapshot.messages, !hasReady || memoryChanged);
      else if (hasReady && connection.status.reason === 'new_session') pager.reset('原会话已过期，已建立新会话。\n请继续说话或输入文字。');
      if (memoryChanged) pager.notice(memoryResetText);
      hasReady = true;
      connected = true; speech = event.capabilities?.speech === true;
      pushToTalkAvailable = event.capabilities?.push_to_talk === true;
      // A fresh launch (including glasses-menu launch with a locked phone)
      // expresses intent to talk, even if the restored session was paused.
      // Consume this once: later reconnects/pauses must not undo a manual mute.
      startupResumePending = false;
      if (typeof event.snapshot?.state === 'string') state = event.snapshot.state;
      if (startupReady && speech && state === 'paused' && audioController?.desired && !exiting) {
        startupResumeInFlight = true;
        send({ type: 'resume' });
      }
      syncAudioAvailability();
      locationAvailable = event.capabilities?.location === true;
      if (startupReady && startupCapture && speech && locationAvailable && locationController) {
        const socket = connection.socket, generation = holdGeneration;
        if (firstLocationRequest()) pager.notice('首次定位可能在手机上请求权限；定位不会阻塞录音。');
        void locationController.once(() => startupCapture && connected && connection.socket === socket
          && generation === holdGeneration).then(ok => { if (ok) rememberLocationSuccess(); }).catch(() => {});
      }
      channel = event.capabilities?.provider === 'api' ? 'API' : event.capabilities?.provider === 'codex-cli' ? 'CLI' : '?';
      const stt = event.capabilities?.speechProvider === 'soniox' ? 'Soniox' : event.capabilities?.speechProvider === 'openai' ? 'OpenAI' : 'STT';
      element('channel').textContent = `当前测试：${channel} · 模型 ${event.models?.reply ?? '?'} · 语音 ${stt}`;
      element('recovery-window').textContent = Number.isInteger(event.resume_window_minutes)
        ? `会话恢复窗口：${event.resume_window_minutes} 分钟` : '会话恢复窗口：服务器未提供';
      // A cold start can follow a WebView process death after the resume
      // window has elapsed. Reconcile durable side effects on every ready,
      // not only when the conversation session itself was resumed.
      if (event.capabilities?.email === true) connection.send({ type: 'jobs.list' });
      if (event.capabilities?.calendar === true) connection.send({ type: 'calendar.list' });
      if (!event.resumed) pager.reset('已连接。\n首轮自动开麦，之后长按说话、松手发送。');
    }
    pager.event(event);
    if (event.type === 'state') {
      state = event.state;
      if (state === 'listening') startupResumeInFlight = false;
      if (['paused', 'exit_pending', 'closed'].includes(state)
        && !(state === 'paused' && startupCapture && startupResumeInFlight)) void stopAudio();
      status = ({ listening: '等待说话 / 追问', thinking: '判断意图中', answering: '正在回答', paused: '已暂停', exit_pending: '等待系统退出确认', closed: '已结束' } as Record<string, string>)[state] ?? state;
      syncAudioAvailability();
    }
    if (event.type === 'answer.start') { answerId = event.id; if (startupCapture) void stopAudio(); }
    if (event.type === 'answer.cancelled' && event.id === answerId) { answerId = undefined; status = '已打断'; }
    if (event.type === 'answer.done' && event.id === answerId) answerId = undefined;
    if (event.type === 'search.status' && event.id === answerId) {
      status = event.status === 'searching' ? '正在查资料'
        : event.status === 'quota_exhausted' || event.status === 'session_quota_exhausted' ? '联网额度已用完，仍可聊天'
        : event.status === 'quota_unavailable' ? '无法核实联网额度，继续离线回答'
        : '整理回答中';
    }
    if (event.type === 'artifact.status' && event.id === answerId) status = event.status === 'sending' ? '正在提交邮件' : '正在生成文件';
    if (event.type === 'calendar.status' && event.id === answerId) status = event.status === 'saving' ? '正在保存日历' : event.status === 'querying' ? '正在查询日历' : '正在理解日历请求';
    if (event.type === 'task.status' && event.id === answerId) {
      status = event.status === 'planning' ? '正在规划任务'
        : event.status === 'calendar' ? '正在核对日历'
        : event.status === 'locating' ? '正在获取当前位置'
        : event.status === 'environment' ? '正在查询环境条件'
        : event.status === 'places' ? '正在比较地点和路线'
        : event.status === 'deciding' ? '正在形成建议'
        : event.status === 'previewing' ? '正在生成日历预览'
        : '正在保存日历';
    }
    if (event.type === 'route.status' && event.id === answerId) {
      status = event.status === 'locating' ? '正在获取当前位置'
        : event.status === 'searching' ? '正在查找附近地点'
        : event.status === 'comparing' ? '正在重新比较路线'
        : event.status === 'clarifying' ? '正在确认地点含义'
        : event.status === 'resolving' ? '正在解析出发地和目的地'
        : event.status === 'failed' ? `路线失败 · ${event.stage === 'places' ? '地点查询' : event.stage === 'routes' ? '路线计算' : '未知阶段'}`
        : '正在比较路线和评分';
      if (event.status === 'failed') console.warn('Route request failed', {
        stage: event.stage, providerStatus: event.provider_status, providerReason: event.provider_reason
      });
    }
    if (event.type === 'speech.started') status = '正在说 · 正在识别文字';
    if (event.type === 'speech.ended') status = '正在完成识别';
    if (event.type === 'transcript.final') status = '识别结果已保留';
    if (event.type === 'turn.waiting') status = '请继续说';
    if (event.type === 'location.request' && connection.socket) void automaticLocation(event, connection.socket as WebSocket);
    if (event.type === 'location.cancel') locationController?.cancelAutomatic(event.request_id);
    if (event.type === 'exit.confirmation_required') void exitDialog();
    if (event.type === 'error') status = event.code === 'SESSION_UNAVAILABLE' ? '恢复凭证已过期，正在建立新会话' : `错误：${event.code}`;
    if (event.type === 'notice') {
      if (event.code === 'MEMORY_CONTEXT_RESET') {
        if (typeof event.memory_boundary === 'string') memoryBoundary = event.memory_boundary;
        resetMemoryView(event.text);
      }
      status = event.text;
      if (event.code !== 'MEMORY_CONTEXT_RESET') pager.notice(event.text);
    }
    if (event.type === 'location.status') {
      status = event.state === 'available'
        ? `本次会话位置可用${typeof event.accuracy_m === 'number' ? ` · 精度约 ${event.accuracy_m}m` : ''}`
        : event.state === 'cleared' ? '本次会话位置已清除' : '位置不可用，请手动提供出发地';
    }
    refresh();
}

element('connect').onclick = async () => {
  if (disposed) return;
  if (!connection || !credentialStore) { status = 'Even SDK 与安全存储尚未就绪'; refresh(); return; }
  const tokenInput = element('token') as HTMLInputElement;
  const token = tokenInput.value.trim();
  if (!credentialStore.load() && !credentialStore.loadDevice() && token.length < 32) {
    status = '请输入至少 32 字符的应用 token'; refresh(); return;
  }
  if (exiting) {
    await stopAudio();
    if (!await restoreDisplay()) return;
  }
  if (!connection.connect(token)) { status = connection.connected ? '已经连接' : '无法连接，请检查 token 或恢复凭证'; refresh(); return; }
  tokenInput.value = '';
};
element('form').onsubmit = event => {
  event.preventDefault(); const input = element('text') as HTMLTextAreaElement;
  if (!active()) { status = '请先连接或恢复对话'; refresh(); return; }
  if (input.value.trim()) { send({ type: 'text.submit', text: input.value.trim() }); input.value = ''; }
};
element('audio').onpointerdown = event => { event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); beginHold(); };
element('audio').onpointerup = () => endHold();
element('audio').onpointercancel = () => { void stopAudio(); send({ type: 'pause' }); };
element('audio').onlostpointercapture = () => endHold();
element('guest-enter').onclick = () => send({ type: 'guest.enter' });
element('guest-unlock').onclick = () => send({ type: 'guest.unlock.begin' });
element('resume').onclick = async () => {
  if (disposed) return;
  if (exiting && !await restoreDisplay()) return;
  if (state === 'exit_pending') send({ type: 'exit.confirm', confirm: false });
  send({ type: 'resume' });
  if (!connected) status = '画面已恢复，请输入应用 token 重新连接';
  refresh();
};
element('interrupt').onclick = () => send({ type: 'interrupt' });
element('exit').onclick = () => { if (connected) send({ type: 'exit.request' }); else void exitDialog(); };
element('prev').onclick = () => { pager.move(-1); refresh(); };
element('next').onclick = () => { pager.move(1); refresh(); };
element('latest').onclick = () => { pager.latest(); refresh(); };
element('locate-once').onclick = async () => {
  if (!connected || !bridge || !locationAvailable || !locationController) { status = '定位尚不可用或后端未连接'; refresh(); return; }
  if (import.meta.env.DEV && developmentLocation) {
    const selected = developmentLocation;
    const report = locationReport('once', { latitude: selected.latitude, longitude: selected.longitude,
      accuracy: selected.accuracy, timestamp: Date.now() }, undefined, selected.timezone);
    if (report) send(report);
    status = report ? `模拟定位可用 · ${selected.label}（本次会话）` : '模拟定位无效'; refresh(); return;
  }
  status = '正在获取一次性位置'; refresh();
  const ok = await locationController.once().catch(() => false);
  if (!ok) { status = '定位被拒绝、超时或结果无效'; refresh(); }
};
element('locate-start').onclick = async () => {
  if (!connected || !bridge || !locationAvailable || !locationController) { status = '定位尚不可用或后端未连接'; refresh(); return; }
  if (import.meta.env.DEV && developmentLocation) {
    const selected = developmentLocation;
    const report = locationReport('continuous', { latitude: selected.latitude, longitude: selected.longitude,
      accuracy: selected.accuracy, timestamp: Date.now() }, undefined, selected.timezone);
    if (report) send(report);
    status = report ? `模拟连续定位 · ${selected.label}（固定测试点）` : '模拟定位无效'; refresh(); return;
  }
  status = '正在请求连续定位'; refresh();
  const ok = await locationController.start();
  status = ok ? '连续定位已开启 · 15 秒/25 米更新' : '连续定位未开启'; refresh();
};
element('locate-stop').onclick = async () => {
  const ok = await locationController?.stop(); send({ type: 'location.clear' });
  status = ok === false ? '定位停止状态未确认，位置已从会话清除' : '连续定位已停止，位置已清除'; refresh();
};
element('route-mode-apply').onclick = () => {
  const mode = (element('route-mode') as HTMLSelectElement).value;
  if (['drive', 'walk', 'bicycle'].includes(mode)) send({ type: 'route.mode', mode });
};
element('preview').onwheel = event => {
  event.preventDefault();
  if (event.deltaY) { pager.move(event.deltaY < 0 ? -1 : 1); refresh(); }
};

// Serialize and coalesce updates to avoid overlapping SDK calls or per-token BLE writes.
const timer = setInterval(async () => {
  if (!dirty || drawing || disposed) return;
  dirty = false; drawing = true;
  const revision = viewRevision;
  const micLabel = audioController?.state === 'requires_reopen' ? '开麦失败 OFF'
    : audioController?.state === 'starting' ? '开麦中 OFF' : audio ? 'MIC' : 'OFF';
  const header = `${accessMode === 'guest' ? '访客' : '助手'} ${micLabel} ${pager.label}`;
  const body = pager.selected?.pending && !pager.selected.raw ? status : pager.current || '等待说话';
  const text = `${header}\n${body}`;
  element('preview').textContent = text; element('page').textContent = `记录 ${pager.index + 1}/${pager.entries.length} · ${pager.label}`;
  try {
    if (bridge && display.open && !exiting) {
      if (header !== lastHeader) {
        if (!await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 2, containerName: 'status', content: header }))) throw Error('Display update failed');
        if (revision !== viewRevision) { dirty = true; return; }
        lastHeader = header;
      }
      if (body !== last && revision === viewRevision) {
        if (!await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'conversation', content: body }))) throw Error('Display update failed');
        if (revision !== viewRevision) { dirty = true; return; }
        last = body;
      }
    }
  } catch { element('bridge').textContent = 'SDK 更新失败；请重新打开模拟器'; }
  finally { drawing = false; }
}, 300);

async function restoreDisplay() {
  await shutdown;
  if (disposed) return false;
  if (!bridge) { exiting = false; return true; }
  try {
  const initialContent = 'Glass Assistant\n请在伴随页面连接后端。';
  const ok = await display.restore(async () => {
    const layout = { containerTotalNum: 2, textObject: [
      new TextContainerProperty({ containerID: 1, containerName: 'conversation', xPosition: 0, yPosition: 44,
        width: 576, height: 236, paddingLength: 2, borderWidth: 0, isEventCapture: 1, content: initialContent }),
      new TextContainerProperty({ containerID: 2, containerName: 'status', xPosition: 8, yPosition: 4,
        width: 560, height: 36, paddingLength: 4, borderWidth: 0, isEventCapture: 0, content: '助手 OFF' })] };
    const created = await bridge!.createStartUpPageContainer(new CreateStartUpPageContainer(layout));
    if (created === 0) return true;
    // Hot reload may retain the old single-container layout; rebuild both containers.
    return await bridge!.rebuildPageContainer(new RebuildPageContainer(layout)).catch(() => false);
  });
  if (!ok || disposed) throw Error('Startup page rejected');
  exiting = false; last = ''; lastHeader = ''; dirty = true;
  syncAudioAvailability();
  element('bridge').textContent = 'Even SDK 已连接 · 576 × 288 显示';
  return true;
  } catch {
    status = 'SDK 页面重建失败，请重新打开模拟器应用';
    element('bridge').textContent = status; refresh(); return false;
  }
}
void (async () => {
  const candidate = await waitForEvenAppBridge();
  if (disposed) return;
  bridge = candidate;
  const startupAt = Date.now();
  // Only fixed labels, booleans and elapsed time. Never log SDK payloads.
  candidate.onLaunchSource(source => {
    if (source === 'appMenu' || source === 'glassesMenu') console.info('[even-audio]', {
      event: 'launch', source, elapsedMs: Math.max(0, Date.now() - startupAt),
    });
  });
  credentialStore = await SessionCredentialStore.open(candidate, localStorage);
  connection = new ConnectionController({
    url: () => conversationWebSocketUrl(location, packagedBackendOrigin),
    socket: url => new WebSocket(url) as unknown as import('./connection-controller').SocketLike,
    credentials: credentialStore,
    clientCapabilities: { location: true },
    onEvent: handleServerEvent,
    onStatus: handleConnectionStatus,
  });
  audioController = new AudioController({
    bridge: { audioControl: async enabled => {
      try {
        const result = await candidate.audioControl(enabled);
        console.info('[even-audio]', { event: 'sdk_result', enabled, ok: result === true,
          elapsedMs: Math.max(0, Date.now() - startupAt) });
        return result;
      } catch (error) {
        console.info('[even-audio]', { event: 'sdk_error', enabled,
          elapsedMs: Math.max(0, Date.now() - startupAt) });
        throw error;
      }
    } },
    onState: next => { audio = next === 'streaming'; status = next === 'starting' ? '正在开启麦克风'
      : next === 'streaming' ? '正在听' : next === 'requires_reopen' ? '麦克风需重新打开应用'
        : next === 'unavailable' ? '麦克风暂时不可用' : status;
      console.info('[even-audio]', { event: 'state', audioState: next, desired: audioController?.desired === true,
        connected, speech, displayReady: display.open, elapsedMs: Math.max(0, Date.now() - startupAt) });
      refresh(); },
    onUnavailable: () => { void stopAudio(); send({ type: 'pause' }); status = '麦克风暂时不可用，请稍后重试'; refresh(); },
    onRequiresReopen: () => { void stopAudio(); send({ type: 'pause' }); status = '麦克风通道已卡住，请重新打开应用'; refresh(); },
  });
  locationController = new LocationController(candidate, report => send(report));
  // Exactly one automatic listening phase per page launch/reload, never reconnect.
  await audioController.setDesired(true);
  candidate.onDeviceStatusChanged(device => {
    const available = device.connectType === DeviceConnectType.Connected;
    if (!available) { void stopAudio(); if (connected) send({ type: 'pause' }); }
    void audioController?.setDeviceAvailable(available);
    if (!available) { status = device.connectType === DeviceConnectType.Connecting ? '眼镜正在重新连接'
      : device.connectType === DeviceConnectType.ConnectionFailed ? '眼镜连接失败' : '眼镜已断开'; refresh(); }
  });
  console.info('[even-agent] ready');
  candidate.onEvenHubEvent(event => {
    const system = event.sysEvent?.eventType;
    if (system === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      locationController?.cancelAutomatic(); void locationController?.stop();
      return;
    }
    if (system === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      if (!connected) connection.networkAvailable();
      dirty = true; refresh(); return;
    }
    if (system === OsEventTypeList.SYSTEM_EXIT_EVENT || system === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      const confirmedExit = system === OsEventTypeList.SYSTEM_EXIT_EVENT && state === 'exit_pending' && connection.connected;
      exiting = true; display.close(); connected = false; state = 'closed'; answerId = undefined;
      if (confirmedExit) connection.confirmExit(true);
      else connection.dispose();
      void stopAudio(); void locationController?.stop();
      status = '眼镜页面已退出；可重新连接或恢复画面'; refresh(); return;
    }
    if (event.audioEvent && (holding || startupCapture) && audio && active() && connection.socket?.readyState === WebSocket.OPEN) {
      const pcm = event.audioEvent.audioPcm;
      if ((connection.socket.bufferedAmount ?? 0) > 64000) { void stopAudio(); send({ type: 'pause' }); return; }
      for (let offset = 0; offset < pcm.length; offset += 3200) connection.sendBinary(pcm.slice(offset, offset + 3200));
      return;
    }
    const input = event.textEvent ?? event.sysEvent;
    if (!input) return;
    const type = input.eventType;
    if (type === OsEventTypeList.SCROLL_TOP_EVENT) pager.move(-1);
    else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) pager.move(1);
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) { if (connected) send({ type: 'exit.request' }); else void exitDialog(); }
    else if (type === OsEventTypeList.LONG_PRESS_EVENT) beginHold();
    else if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) endHold();
    // Ignore click after release: it must not reopen capture.
    refresh();
  });
  await restoreDisplay();
  if (credentialStore.load() || credentialStore.loadDevice()) connection.resumeIfAvailable();
})().catch(() => { element('bridge').textContent = 'Even SDK 初始化失败；请在官方模拟器中打开'; });
window.addEventListener('online', () => connection?.networkAvailable());
window.addEventListener('pagehide', () => {
  // pagehide may mean a reversible iOS background/navigation transition. Do
  // not destroy the resumable connection controller or mark the app disposed;
  // native FOREGROUND_ENTER_EVENT is the supported restoration signal.
  // Do not stop glasses capture merely because the companion UI is hidden.
  locationController?.cancelAutomatic(); void locationController?.stop();
});
if (import.meta.env.DEV) {
  void import('../dev/session-controls').then(({ installSessionControls }) => { developmentSessionControls = installSessionControls({
    backendUrl: conversationWebSocketUrl(location, packagedBackendOrigin),
    resume: () => connection.reconnectNow(),
    coldStart: async () => {
      if (!connection.connected || !credentialStore.load()) return false;
      await credentialStore.whenSettled();
      if (!connection.connected || !credentialStore.load() || !credentialStore.persistenceHealthy) return false;
      try { location.reload(); return true; }
      catch { return false; }
    },
    expire: () => connection.forgetResumeCredential() && connection.send({ type: 'test.session.expire' }),
    command: type => connection.send({ type }),
  }); });
  void import('../dev/location-presets').then(({ installLocationPresets }) => installLocationPresets(location => {
    developmentLocation = location;
    status = location ? `已选择模拟位置 · ${location.label}` : '已恢复真实 SDK 定位';
    refresh();
  }));
  void import('../dev/reading-demo').then(({ installReadingDemo }) => installReadingDemo(events => {
    if (connected) return;
    pager.reset('本地显示测试，不调用模型');
    for (const event of events) pager.event(event);
    status = '本地交互样例（非 AI）'; refresh();
  }));
  void import('../dev/layout-demo').then(({ installLayoutDemo }) => installLayoutDemo(text => {
    if (connected) return; // Never overwrite a real session with a fixture.
    pager.reset(text); status = '本地分页样例（非 AI）'; refresh();
  }));
}
