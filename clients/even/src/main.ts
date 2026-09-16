import { waitForEvenAppBridge, CreateStartUpPageContainer, TextContainerProperty, TextContainerUpgrade,
  OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { ReadingHistory } from './reading-history';

const element = (id: string) => document.getElementById(id)!;
const pager = new ReadingHistory();
pager.reset('请在伴随页面连接后端。\n连接后可输入文字或开启麦克风。');
let bridge: EvenAppBridge | undefined, socket: WebSocket | undefined;
let connected = false, speech = false, audio = false, audioEpoch = 0, state = 'closed', channel = '?';
let status = '未连接', answerId: unknown, dirty = true, drawing = false, last = '', disposed = false, exiting = false;
const active = () => connected && !['paused', 'exit_pending', 'closed'].includes(state);
function send(event: object) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); }
function refresh() { dirty = true; element('status').textContent = `${status} · 麦克风${audio ? '开启' : '关闭'}`; }
async function stopAudio() {
  audioEpoch++; audio = false; refresh();
  if (bridge) await bridge.audioControl(false).catch(() => false);
}
async function toggleAudio() {
  if (!bridge || !connected || !speech || state === 'exit_pending') { status = '请先连接 SDK 与后端，退出待确认时请先恢复'; refresh(); return; }
  if (audio) { await stopAudio(); send({ type: 'pause' }); return; }
  if (state === 'paused') send({ type: 'resume' });
  const epoch = ++audioEpoch;
  try {
    const ok = await bridge.audioControl(true);
    if (epoch !== audioEpoch || !connected || disposed) { await bridge.audioControl(false); return; }
    audio = ok; status = ok ? '正在听' : '麦克风开启失败'; refresh();
  } catch { status = '麦克风不可用'; refresh(); }
}
async function exitDialog() {
  if (exiting) return;
  exiting = true;
  await stopAudio();
  if (bridge) {
    const ok = await bridge.shutDownPageContainer(1).catch(() => false);
    if (!ok) { exiting = false; status = '系统退出请求未成功，请用双击重试'; refresh(); }
  } else { status = '无 SDK：已停收音，恢复按钮可取消退出'; refresh(); }
  // An SDK acknowledgement is not proof the user confirmed. Stay paused until
  // unload/disconnect, or explicit cancellation through the companion control.
}
element('connect').onclick = () => {
  if (socket && socket.readyState < WebSocket.CLOSING) return;
  let token = (element('token') as HTMLInputElement).value.trim();
  if (token.length < 32) { status = '请输入至少 32 字符的应用 token'; refresh(); return; }
  const ws = socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/conversation`);
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', token })); token = ''; (element('token') as HTMLInputElement).value = ''; };
  ws.onmessage = ({ data }) => {
    if (socket !== ws) return;
    const event = JSON.parse(data);
    if (event.type === 'ready') {
      connected = true; speech = event.capabilities?.speech === true;
      channel = event.capabilities?.provider === 'api' ? 'API' : event.capabilities?.provider === 'codex-cli' ? 'CLI' : '?';
      element('channel').textContent = `当前测试：${channel} · 模型 ${event.models?.reply ?? '?'} · 语音转录仍走 API`;
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
    if (event.type === 'speech.started') status = '正在说 · 正在识别文字';
    if (event.type === 'speech.ended') status = '正在完成识别';
    if (event.type === 'transcript.final') status = '识别结果已保留';
    if (event.type === 'turn.waiting') status = '请继续说';
    if (event.type === 'exit.confirmation_required') void exitDialog();
    if (event.type === 'error') { status = `错误：${event.code}`; void stopAudio(); }
    if (event.type === 'notice') status = event.text;
    refresh();
  };
  ws.onclose = () => { if (socket !== ws) return; connected = false; state = 'closed'; answerId = undefined; token = ''; status = '已断开，请重新连接'; element('channel').textContent = '通道：已断开'; void stopAudio(); refresh(); };
  ws.onerror = () => { status = '连接失败，请检查后端'; refresh(); };
};
element('form').onsubmit = event => {
  event.preventDefault(); const input = element('text') as HTMLTextAreaElement;
  if (!active()) { status = '请先连接或恢复对话'; refresh(); return; }
  if (input.value.trim()) { send({ type: 'text.submit', text: input.value.trim() }); input.value = ''; }
};
element('audio').onclick = () => void toggleAudio();
element('resume').onclick = () => { exiting = false; if (state === 'exit_pending') send({ type: 'exit.confirm', confirm: false }); send({ type: 'resume' }); refresh(); };
element('interrupt').onclick = () => send({ type: 'interrupt' });
element('exit').onclick = () => { if (connected) send({ type: 'exit.request' }); else void exitDialog(); };
element('prev').onclick = () => { pager.move(-1); refresh(); };
element('next').onclick = () => { pager.move(1); refresh(); };
element('latest').onclick = () => { pager.latest(); refresh(); };

// Serialize and coalesce updates to avoid overlapping SDK calls or per-token BLE writes.
const timer = setInterval(async () => {
  if (!dirty || drawing || disposed) return;
  dirty = false; drawing = true;
  const text = `${channel} | ${status.slice(0, 18)} | ${audio ? 'MIC' : 'OFF'}\n${pager.label}\n${pager.current}`;
  element('preview').textContent = text; element('page').textContent = `记录 ${pager.index + 1}/${pager.entries.length} · ${pager.label}`;
  try {
    if (bridge && !exiting && text !== last) {
      if (!await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'conversation', content: text }))) throw Error('Display update failed');
      last = text;
    }
  } catch { element('bridge').textContent = 'SDK 更新失败；请重新打开模拟器'; }
  finally { drawing = false; }
}, 300);

void (async () => {
  const candidate = await waitForEvenAppBridge();
  if (disposed) return;
  const result = await candidate.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 1,
    textObject: [new TextContainerProperty({ containerID: 1, containerName: 'conversation', xPosition: 8, yPosition: 4,
      width: 560, height: 280, paddingLength: 4, borderWidth: 0, isEventCapture: 1, content: 'Even Agent\n请在伴随页面连接后端。' })] }));
  if (result !== 0) { console.error('[even-agent] startup rejected', result); throw Error('Startup page rejected'); }
  bridge = candidate; element('bridge').textContent = 'Even SDK 已连接 · 576 × 288 显示'; dirty = true;
  console.info('[even-agent] ready');
  candidate.onEvenHubEvent(event => {
    const system = event.sysEvent?.eventType;
    if (system === OsEventTypeList.FOREGROUND_EXIT_EVENT) { void stopAudio(); send({ type: 'pause' }); return; }
    if (system === OsEventTypeList.SYSTEM_EXIT_EVENT || system === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      disposed = true; clearInterval(timer); void stopAudio(); socket?.close(); return;
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
})().catch(() => { element('bridge').textContent = 'Even SDK 初始化失败；请在官方模拟器中打开'; });
window.addEventListener('pagehide', () => { disposed = true; clearInterval(timer); void stopAudio(); socket?.close(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { void stopAudio(); send({ type: 'pause' }); } });
if (import.meta.env.DEV) {
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
