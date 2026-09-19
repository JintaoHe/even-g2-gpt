import { waitForEvenAppBridge, CreateStartUpPageContainer, TextContainerProperty, TextContainerUpgrade,
  OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { ReadingHistory } from './reading-history';
import { DisplaySession } from './display-session';
import { conversationWebSocketUrl } from './backend-url';
import { LocationController, locationReport } from './location';

const element = (id: string) => document.getElementById(id)!;
const packagedBackendOrigin = typeof __EVEN_BACKEND_ORIGIN__ === 'string' ? __EVEN_BACKEND_ORIGIN__ : '';
const pager = new ReadingHistory();
const display = new DisplaySession();
let connecting = false;
let shutdown: Promise<void> | undefined;
pager.reset('请在伴随页面连接后端。\n连接后可输入文字或开启麦克风。');
let bridge: EvenAppBridge | undefined, socket: WebSocket | undefined;
let locationController: LocationController | undefined, locationAvailable = false;
let developmentLocation: { label: string; latitude: number; longitude: number; accuracy: number; timezone: string } | undefined;
let connected = false, speech = false, audio = false, audioEpoch = 0, state = 'closed', channel = '?';
let status = '未连接', answerId: unknown, dirty = true, drawing = false, last = '', disposed = false, exiting = false;
const active = () => connected && !exiting && !disposed && !['paused', 'exit_pending', 'closed'].includes(state);
function send(event: object) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); }
function refresh() { dirty = true; element('status').textContent = `${status} · 麦克风${audio ? '开启' : '关闭'}`; }
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
    if (socket === ws && ws.readyState === WebSocket.OPEN && report) send(report);
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
    // Once permission succeeds, keep the live session context fresh. The SDK
    // owns actual sampling; our request asks for at most one update per 10s.
    void locationController.start();
  }
  if (socket !== ws || ws.readyState !== WebSocket.OPEN || result.ok || result.reason === 'cancelled') return;
  send({ type: 'location.failed', request_id: event.request_id, reason: result.reason });
}
async function stopAudio() {
  audioEpoch++; audio = false; refresh();
  if (bridge) await bridge.audioControl(false).catch(() => false);
}
async function toggleAudio() {
  if (!bridge || !connected || !speech || exiting || disposed || state === 'exit_pending') { status = '请先连接 SDK 与后端，退出待确认时请先恢复'; refresh(); return; }
  if (audio) { await stopAudio(); send({ type: 'pause' }); return; }
  if (state === 'paused') send({ type: 'resume' });
  const epoch = ++audioEpoch;
  try {
    const ok = await bridge.audioControl(true);
    if (epoch !== audioEpoch || !connected || disposed) { await bridge.audioControl(false); return; }
    audio = ok; status = ok ? '正在听' : '麦克风开启失败'; refresh();
  } catch { status = '麦克风不可用'; refresh(); }
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
element('connect').onclick = async () => {
  if (connecting || disposed) return;
  if (!exiting && socket && socket.readyState < WebSocket.CLOSING) return;
  let token = (element('token') as HTMLInputElement).value.trim();
  if (token.length < 32) { status = '请输入至少 32 字符的应用 token'; refresh(); return; }
  connecting = true;
  try {
    if (exiting) {
      const old = socket; socket = undefined; old?.close();
      connected = false; state = 'closed'; answerId = undefined;
      await stopAudio();
      if (!await restoreDisplay()) return;
    }
  const ws = socket = new WebSocket(conversationWebSocketUrl(location, packagedBackendOrigin));
  ws.onopen = () => { if (socket !== ws) { token = ''; ws.close(); return; } ws.send(JSON.stringify({ type: 'hello', token })); token = ''; (element('token') as HTMLInputElement).value = ''; };
  ws.onmessage = ({ data }) => {
    if (socket !== ws) return;
    const event = JSON.parse(data);
    if (event.type === 'ready') {
      connected = true; speech = event.capabilities?.speech === true;
      locationAvailable = event.capabilities?.location === true;
      channel = event.capabilities?.provider === 'api' ? 'API' : event.capabilities?.provider === 'codex-cli' ? 'CLI' : '?';
      const stt = event.capabilities?.speechProvider === 'soniox' ? 'Soniox' : event.capabilities?.speechProvider === 'openai' ? 'OpenAI' : 'STT';
      element('channel').textContent = `当前测试：${channel} · 模型 ${event.models?.reply ?? '?'} · 语音 ${stt}`;
      pager.reset('已连接。\n可输入文字，或主动开启麦克风。');
    }
    pager.event(event);
    if (event.type === 'state') {
      state = event.state;
      status = ({ listening: '等待说话 / 追问', thinking: '判断意图中', answering: '正在回答', paused: '已暂停', exit_pending: '等待系统退出确认', closed: '已结束' } as Record<string, string>)[state] ?? state;
      if (!active()) void stopAudio();
    }
    if (event.type === 'answer.start') answerId = event.id;
    if (event.type === 'answer.cancelled' && event.id === answerId) { answerId = undefined; status = '已打断'; }
    if (event.type === 'answer.done' && event.id === answerId) answerId = undefined;
    if (event.type === 'search.status' && event.id === answerId) status = event.status === 'searching' ? '正在查资料' : '整理回答中';
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
    if (event.type === 'location.request') void automaticLocation(event, ws);
    if (event.type === 'location.cancel') locationController?.cancelAutomatic(event.request_id);
    if (event.type === 'exit.confirmation_required') void exitDialog();
    if (event.type === 'error') { status = `错误：${event.code}`; void stopAudio(); }
    if (event.type === 'notice') status = event.text;
    if (event.type === 'location.status') {
      status = event.state === 'available'
        ? `本次会话位置可用${typeof event.accuracy_m === 'number' ? ` · 精度约 ${event.accuracy_m}m` : ''}`
        : event.state === 'cleared' ? '本次会话位置已清除' : '位置不可用，请手动提供出发地';
    }
    refresh();
  };
  ws.onclose = () => { if (socket !== ws) return; connected = false; state = 'closed'; answerId = undefined; token = ''; status = '已断开，请重新连接'; element('channel').textContent = '通道：已断开'; void stopAudio(); void locationController?.stop(); refresh(); };
  ws.onerror = () => { if (socket !== ws) return; status = '连接失败，请检查后端'; refresh(); };
  } catch {
    status = '连接配置无效或后端不可用'; refresh();
  } finally { connecting = false; }
};
element('form').onsubmit = event => {
  event.preventDefault(); const input = element('text') as HTMLTextAreaElement;
  if (!active()) { status = '请先连接或恢复对话'; refresh(); return; }
  if (input.value.trim()) { send({ type: 'text.submit', text: input.value.trim() }); input.value = ''; }
};
element('audio').onclick = () => void toggleAudio();
element('resume').onclick = async () => {
  if (disposed || connecting) return;
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
  const text = `${channel} | ${status.slice(0, 18)} | ${audio ? 'MIC' : 'OFF'}\n${pager.label}\n${pager.current}`;
  element('preview').textContent = text; element('page').textContent = `记录 ${pager.index + 1}/${pager.entries.length} · ${pager.label}`;
  try {
    if (bridge && display.open && !exiting && text !== last) {
      if (!await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'conversation', content: text }))) throw Error('Display update failed');
      last = text;
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
    const created = await bridge!.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 1,
      textObject: [new TextContainerProperty({ containerID: 1, containerName: 'conversation', xPosition: 8, yPosition: 4,
        width: 560, height: 280, paddingLength: 4, borderWidth: 0, isEventCapture: 1, content: initialContent })] }));
    if (created === 0) return true;
    // Vite can reload the companion WebView while the simulator keeps container 1.
    // Adopt that existing container instead of leaving Browser and Glasses Display split.
    return await bridge!.textContainerUpgrade(new TextContainerUpgrade({
      containerID: 1, containerName: 'conversation', content: initialContent
    })).catch(() => false);
  });
  if (!ok || disposed) throw Error('Startup page rejected');
  exiting = false; last = ''; dirty = true;
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
  locationController = new LocationController(candidate, report => send(report));
  console.info('[even-agent] ready');
  candidate.onEvenHubEvent(event => {
    const system = event.sysEvent?.eventType;
    if (system === OsEventTypeList.FOREGROUND_EXIT_EVENT) { void stopAudio(); send({ type: 'pause' }); return; }
    if (system === OsEventTypeList.SYSTEM_EXIT_EVENT || system === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      exiting = true; display.close(); connected = false; state = 'closed'; answerId = undefined;
      const old = socket; socket = undefined; old?.close(); void stopAudio(); void locationController?.stop();
      status = '眼镜页面已退出；可重新连接或恢复画面'; refresh(); return;
    }
    if (event.audioEvent && audio && active() && socket?.readyState === WebSocket.OPEN) {
      const pcm = event.audioEvent.audioPcm;
      if (socket.bufferedAmount > 64000) { void stopAudio(); send({ type: 'pause' }); return; }
      for (let offset = 0; offset < pcm.length; offset += 3200) socket.send(pcm.slice(offset, offset + 3200));
      return;
    }
    const input = event.textEvent ?? event.sysEvent;
    if (!input) return;
    const type = input.eventType;
    if (type === OsEventTypeList.SCROLL_TOP_EVENT) pager.move(-1);
    else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) pager.move(1);
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) { if (connected) send({ type: 'exit.request' }); else void exitDialog(); }
    else if (event.textEvent && (type === OsEventTypeList.CLICK_EVENT || type === undefined)) void toggleAudio();
    refresh();
  });
  await restoreDisplay();
})().catch(() => { element('bridge').textContent = 'Even SDK 初始化失败；请在官方模拟器中打开'; });
window.addEventListener('pagehide', () => { disposed = true; display.close(); clearInterval(timer); void stopAudio(); locationController?.cancelAutomatic(); void locationController?.stop(); socket?.close(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { void stopAudio(); send({ type: 'pause' }); } });
if (import.meta.env.DEV) {
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
