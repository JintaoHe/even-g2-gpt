import { renderCitations } from './citations.js';
import { createProgress } from './progress.js';
import { calendarPanel } from './calendar.js';
import { BrowserSessionClient, isLoopbackHost } from './session-client.js';
const $ = id => document.getElementById(id);
const progress = createProgress(text => { $('progress').textContent = text; });
let session, state = 'closed', connected = false, context, media, source, worklet, micEpoch = 0, hasReady = false;
let speechAvailable = true;
let emailAvailable = false;
let guestMode = false, guestEnabled = false;
let accessRevision = 0;
let cliSearchEnabled = false;
let downloadToken = '', jobTimer;
let forceColdStart = false;
const answers = new Map();
const labels = { listening: '等待说话 / 继续追问', thinking: '判断意图中（可继续说）', answering: '回答中（可插话）', paused: '已暂停', exit_pending: '已停止收音，等待退出确认', closed: '已结束' };
const active = () => connected && ['listening', 'thinking', 'answering'].includes(state);
function send(value) { return session?.send(value) ?? false; }
const calendarEvent = calendarPanel($('googleCalendar'), send);
function notice(text) { $('notice').textContent = text; }
function storageReport(e) {
  const bytes = value => Number.isFinite(value) ? `${(value / 1024 / 1024).toFixed(2)} MB` : '未知';
  const actions = { inspect: 'SQLite 状态', seed_expired: '已写入三年前测试记录',
    cleanup_preview: '三年清理预览', cleanup_apply: '三年测试记录清理结果' };
  const lines = [actions[e.action] ?? 'SQLite 测试结果'];
  if (e.sqlite) lines.push(`Schema v${e.sqlite.schema_version} · ${e.sqlite.journal_mode} · 外键${e.sqlite.foreign_keys ? '开启' : '关闭'}`);
  if (e.storage) lines.push(`会话 ${e.storage.sessions} · 消息 ${e.storage.messages} · 数据库 ${bytes(e.storage.database_bytes)}`,
    `可用磁盘 ${bytes(e.storage.available_disk_bytes)} · 警告 ${e.storage.warnings?.length ? e.storage.warnings.join('、') : '无'}`);
  if (e.current_session) lines.push(`当前会话 ${e.current_session.status} · 最新序号 ${e.current_session.latest_sequence}`);
  if (e.retention) lines.push(`测试范围：可清理 ${e.retention.test_eligible_sessions} 个会话／${e.retention.test_eligible_messages} 条消息`,
    `本次删除 ${e.retention.deleted_sessions} 个会话／${e.retention.deleted_messages} 条消息`);
  lines.push('安全边界：未读取或显示对话正文。');
  $('storageReport').textContent = lines.join('\n');
}
function controls() {
  for (const id of ['voice', 'resume']) $(id).disabled = !connected || ['closed', 'exit_pending'].includes(state);
  if (!speechAvailable) $('voice').disabled = true;
  for (const id of ['submit', 'pause', 'interrupt', 'retry', 'send']) $(id).disabled = !active();
  $('applyRouteMode').disabled = !connected || ['closed', 'exit_pending'].includes(state);
  $('exit').disabled = !connected || ['closed', 'exit_pending'].includes(state);
  $('connect').disabled = connected;
  $('exportMd').disabled = !connected || guestMode;
  $('exportCalendar').disabled = !connected || guestMode;
  $('guestEnter').disabled = !connected || !guestEnabled || guestMode;
  $('guestUnlock').disabled = !connected || !guestEnabled || !guestMode;
}
function renderJobs(jobs) {
  $('jobs').replaceChildren();
  const names = { queued: '排队中', running: '导出中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '服务中断，需重新提交' };
  for (const job of jobs) {
    const row = document.createElement('div'); row.textContent = `${job.calendar ? 'MD＋ICS' : 'MD'} · ${job.title ?? '谈话笔记'} · ${job.created} · ${names[job.state] ?? job.state} `;
    if (job.calendar) { const details = document.createElement('pre'); details.style.whiteSpace = 'pre-wrap'; details.textContent = calendarDescription(job.calendar); row.append(details); }
    if (job.state === 'completed') {
      for (const calendar of job.calendar ? [false, true] : [false]) {
      const button = document.createElement('button'); button.textContent = calendar ? '下载 ICS' : '下载 MD';
      button.onclick = async () => {
        const revision = accessRevision;
        try {
          const response = await fetch(`/artifacts/${encodeURIComponent(job.id)}${calendar ? '/calendar' : ''}`, { headers: { Authorization: `Bearer ${downloadToken}` } });
          if (!response.ok) throw new Error('Download failed');
          const blob = await response.blob();
          if (revision !== accessRevision || guestMode || !connected) return;
          const url = URL.createObjectURL(blob), link = document.createElement('a');
          link.href = url; link.download = calendar ? (job.filename ?? '日程.md').replace(/\.md$/, '.ics') : job.filename ?? '谈话笔记.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch { notice('下载失败，请重新连接后重试。'); }
      }; row.append(button);
      }
      if (emailAvailable) {
        const mail = document.createElement('button');
        const names = { sending: '邮件发送中', accepted: '邮件已提交', failed: '邮件发送失败', unknown: '发送结果待核实' };
        mail.textContent = job.superseded ? '已有新版／草稿已失效' : names[job.mail_state] ?? '预览并确认发送'; mail.disabled = !!job.mail_state || job.superseded;
        mail.onclick = () => send({ type: 'jobs.email.prepare', id: job.id });
        row.append(mail);
        if (job.mail_received) { const received = document.createElement('span'); received.textContent = ' 已确认收到'; row.append(received); }
        else if (job.mail_state && job.mail_state !== 'sending') {
          const received = document.createElement('button'); received.textContent = '我已收到';
          received.onclick = () => send({ type: 'jobs.email.received', id: job.id }); row.append(received);
          if (!job.superseded && job.mail_attempts === 1) {
            const retry = document.createElement('button'); retry.textContent = '没收到／预览重发';
            retry.onclick = () => send({ type: 'jobs.email.prepare', id: job.id, retry: true }); row.append(retry);
          } else if (job.mail_attempts >= 2) { const help = document.createElement('span'); help.textContent = ' 已用完重发次数；请检查垃圾邮件或直接下载附件。'; row.append(help); }
        }
      }
    } else if (['queued', 'running'].includes(job.state)) {
      const button = document.createElement('button'); button.textContent = '取消任务';
      button.onclick = () => send({ type: 'jobs.cancel', id: job.id }); row.append(button);
    }
    $('jobs').append(row);
  }
}
$('exportMd').onclick = () => send({ type: 'jobs.export' });
$('guestEnter').onclick = () => send({ type: 'guest.enter' });
$('guestUnlock').onclick = () => send({ type: 'guest.unlock.begin' });
function calendarDescription(e) {
  return `${e.title}\n${e.start} → ${e.end}\n${e.allDay ? '全天（不包含结束日期）' : e.timezone}${e.location ? '\n地点：' + e.location : ''}${e.notes ? '\n备注：' + e.notes : ''}\n不会自动添加到日历；收到附件后请确认导入。`;
}
$('calendarZone').value = Intl.DateTimeFormat().resolvedOptions().timeZone;
$('calendarAllDay').onchange = () => { $('calendarZone').disabled = $('calendarAllDay').checked; };
$('calendarForm').onsubmit = event => {
  event.preventDefault();
  const calendar = { title: $('calendarTitle').value.trim(), start: $('calendarStart').value.trim(), end: $('calendarEnd').value.trim(),
    allDay: $('calendarAllDay').checked, timezone: $('calendarAllDay').checked ? '' : $('calendarZone').value.trim(), location: $('calendarLocation').value.trim(), notes: $('calendarNotes').value.trim() };
  if (connected && window.confirm('请核对日程；这里只保存导出任务，不会发送邮件。\n\n' + calendarDescription(calendar))) send({ type: 'jobs.export', calendar });
};
function stopMic() {
  micEpoch++;
  if (worklet) { worklet.port.onmessage = null; worklet.disconnect(); worklet = undefined; }
  source?.disconnect(); source = undefined;
  media?.getTracks().forEach(track => track.stop()); media = undefined;
  if (context) { void context.close(); context = undefined; }
  $('mic').textContent = '麦克风关闭';
}
function message(role, text = '') {
  const box = document.createElement('div'); box.className = 'message';
  const label = document.createElement('label'); label.textContent = role;
  const body = document.createElement('span'); body.textContent = text;
  box.append(label, body); $('history').append(box); box.scrollIntoView({ block: 'nearest' });
  return { label, body };
}
const restoredMessages = new Set();
function restoreSnapshot(snapshot, replace) {
  if (!Array.isArray(snapshot?.messages)) return;
  if (replace) { $('history').replaceChildren(); restoredMessages.clear(); }
  for (const item of [...snapshot.messages].sort((a, b) => a.sequence - b.sequence)) {
    if (!item?.id || restoredMessages.has(item.id) || !['user', 'assistant'].includes(item.role)) continue;
    const entry = message(item.role === 'user' ? '你' : item.status === 'interrupted' ? 'Even · 已打断' : 'Even', item.content ?? '');
    entry.body.closest('.message').dataset.messageId = item.id; restoredMessages.add(item.id);
  }
}
function handleServerEvent(e) {
    if (e.type === 'access.changed' || e.type === 'transport.cleared') {
      accessRevision++;
      stopMic(); clearInterval(jobTimer); connected = false; state = 'closed'; hasReady = false;
      downloadToken = ''; answers.clear(); restoredMessages.clear();
      $('history').replaceChildren(); $('jobs').replaceChildren();
      for (const id of ['transcript', 'progress', 'storageReport', 'connectionMeta']) $(id).textContent = '';
      $('token').value = ''; $('text').value = ''; $('calendarForm').reset();
      if ($('exitDialog').open) $('exitDialog').close();
      calendarEvent(e); progress.event({ type: 'state', state: 'closed' });
      const text = e.mode === 'guest' ? '访客模式已锁定，正在连接。' : e.mode === 'reauthorize'
        ? '访客模式已结束，请重新输入主人凭证连接。' : '连接已断开，旧画面已清除。';
      $('accessMode').textContent = text; notice(text); controls(); return;
    }
    if (e.type === 'guest.unlock.challenge') {
      const token = $('token').value.trim(); $('token').value = '';
      if (token) send({ type: 'guest.unlock.confirm', challenge: e.challenge, owner_token: token.trim() });
      else notice('请在密码框重新输入主人凭证，再点主人重新授权。');
      return;
    }
    calendarEvent(e);
    progress.event(e);
    if (e.type === 'route.status' && e.status === 'failed') console.warn('Route request failed', {
      stage: e.stage, providerStatus: e.provider_status, providerReason: e.provider_reason
    });
    if (e.type === 'ready') {
      guestMode = e.access_mode === 'guest'; guestEnabled = e.guest_mode_enabled === true;
      if (guestMode) downloadToken = '';
      $('accessMode').textContent = guestMode ? '访客模式 · 无主人邮件、日历和历史权限' : '主人模式';
      if (e.resumed) restoreSnapshot(e.snapshot, !hasReady);
      else if (hasReady) { $('history').replaceChildren(); restoredMessages.clear(); }
      hasReady = true;
      $('recoveryWindow').textContent = Number.isInteger(e.resume_window_minutes)
        ? `会话恢复窗口：${e.resume_window_minutes} 分钟` : '会话恢复窗口：服务器未提供';
      emailAvailable = e.capabilities?.email === true;
      clearInterval(jobTimer);
      if (!guestMode) { send({ type: 'jobs.list' }); jobTimer = setInterval(() => send({ type: 'jobs.list' }), 3000); }
      connected = true; $('token').value = ''; notice('已连接。点击开启麦克风，或发送文字。');
      speechAvailable = e.capabilities?.speech !== false;
      const provider = e.capabilities?.provider;
      const stt = e.capabilities?.speechProvider === 'soniox' ? 'Soniox' : e.capabilities?.speechProvider === 'openai' ? 'OpenAI' : 'STT';
      cliSearchEnabled = provider === 'codex-cli' && e.capabilities.webSearch;
      $('channel').textContent = provider === 'codex-cli' ? '当前测试：Codex CLI 版本（ChatGPT 账号通道）' : provider === 'api' ? '当前测试：OpenAI API 调用版本' : '测试通道：服务器未提供，无法确认';
      $('channelDetails').textContent = provider === 'codex-cli'
        ? `对话与搜索：Codex CLI · 整条回答返回 · 搜索${e.capabilities.webSearch ? '开启' : '关闭'} · 搜索开启时回答推理最低 low。${speechAvailable ? `语音转录：${stt} API。` : '仅支持文字输入。'}`
        : provider === 'api' ? `对话：OpenAI API · 流式回答 · 搜索${e.capabilities.webSearch ? '开启，受 API 搜索额度限制' : '关闭'}。${speechAvailable ? `语音转录：${stt} API。` : '仅支持文字输入。'}` : '请检查服务器版本。';
      $('models').textContent = e.models ? `通道：${e.capabilities?.provider ?? 'api'} · 意图：${e.models.intent} · 回答：${e.models.reply}` : '测试模型';
      if (e.capabilities?.provider === 'codex-cli') notice(`Codex CLI：整条回答返回，${e.capabilities.webSearch ? '原生联网搜索已开启（使用 Codex 账号额度）' : '联网搜索已关闭'}。${speechAvailable ? `语音转录走 ${stt} API。` : '未配置 STT API key，仅支持文字输入。'}`);
    }
    if (e.type === 'jobs.list') renderJobs(e.jobs);
    if (e.type === 'test.storage.report') storageReport(e);
    if (e.type === 'mail.confirmation_required') {
      if (e.calendar_confirmation) {
        const phrase = window.prompt(`${e.preview}\n\n请核对日期和主时区。要发送，请输入：${e.calendar_confirmation}`);
        if (phrase !== null) send({ type: 'jobs.email', id: e.id, confirmation: e.confirmation, calendar_confirmation: phrase });
        else send({ type: 'jobs.email.cancel' });
      } else if (window.confirm(`${e.preview}\n\n确认将这些附件发送到固定邮箱吗？`)) send({ type: 'jobs.email', id: e.id, confirmation: e.confirmation });
      else send({ type: 'jobs.email.cancel' });
    }
    if (e.type === 'job.created') { notice('MD 导出任务已保存，断开页面后仍会继续。'); send({ type: 'jobs.list' }); }
    if (e.type === 'state') {
      state = e.state; $('state').textContent = labels[state] ?? state;
      if (!active()) stopMic(); controls();
    }
    if (e.type === 'speech.started') { $('transcript').textContent = ''; notice('正在听…'); }
    if (e.type === 'speech.ended') notice('正在完成转录…');
    if (e.type === 'transcript.delta') $('transcript').textContent += e.text;
    if (e.type === 'transcript.final') $('transcript').textContent = e.text;
    if (e.type === 'turn.waiting') notice('这句话可能还没说完，请继续；也可以点“我说完了”。');
    if (e.type === 'turn.committed') {
      if (!e.message_id || !restoredMessages.has(e.message_id)) {
        const entry = message('你', e.text); if (e.message_id) { restoredMessages.add(e.message_id); entry.body.closest('.message').dataset.messageId = e.message_id; }
      }
      notice('');
    }
    if (e.type === 'answer.start') {
      if (e.message_id && restoredMessages.has(e.message_id)) return;
      const answer = message('Even'); answers.set(e.id, answer);
      if (e.message_id) { restoredMessages.add(e.message_id); answer.body.closest('.message').dataset.messageId = e.message_id; }
      if (['low', 'medium', 'high'].includes(e.reasoningEffort)) {
        const mode = document.createElement('small');
        const scenes = { casual: '聊天', explain: '解释', research: '研究', brainstorm: '头脑风暴', decision_support: '决策支持',
          planning: '规划', deep_reasoning: '深度思考', compose: '创作', coaching: '辅导' };
        const workflowNames = { search: '联网', navigation: '路线', calendar: '日历', document: '文档', email: '邮件',
          memory: '记忆', list: '清单', conditional_task: '条件任务' };
        const cognitiveMode = e.cognitiveMode ?? e.assistantMode;
        const scene = scenes[cognitiveMode] ? ` · 认知：${scenes[cognitiveMode]}` : '';
        const capabilities = [...new Set((e.workflows ?? []).map(workflow => workflowNames[workflow.kind]).filter(Boolean))];
        const flow = capabilities.length ? ` · 能力：${capabilities.join('+')}` : '';
        mode.textContent = `${scene}${flow} · 推理：${cliSearchEnabled && e.reasoningEffort === 'none' ? 'low（CLI 搜索最低档）' : e.reasoningEffort}`;
        answer.label.after(mode);
      }
    }
    if (e.type === 'answer.delta') { const answer = answers.get(e.id); if (answer) answer.body.textContent += e.text; }
    if (e.type === 'search.status') {
      const answer = answers.get(e.id);
      if (answer) answer.label.textContent = e.status === 'quota_exhausted' ? 'Even · 搜索额度已用完，仍可聊天'
        : e.status === 'quota_unavailable' ? 'Even · 无法核实搜索额度，暂不联网'
        : e.status === 'failed' ? 'Even · 搜索未成功，整理回答中'
        : e.status === 'completed' ? 'Even · 搜索完成，整理回答中' : 'Even · 正在联网搜索（可打断）';
    }
    if (e.type === 'answer.citations') {
      const answer = answers.get(e.id);
      if (answer) { renderCitations(answer.body, e.text, e.citations); answer.label.textContent = e.citations.length ? 'Even · 已附来源' : 'Even'; }
    }
    if (e.type === 'answer.cancelled') { const answer = answers.get(e.id); if (answer) answer.label.textContent = 'Even · 已打断'; answers.delete(e.id); }
    if (e.type === 'answer.done') { const answer = answers.get(e.id); if (answer && /中|打断/.test(answer.label.textContent)) answer.label.textContent = 'Even · 回答完成'; answers.delete(e.id); }
    if (e.type === 'exit.confirmation_required') { stopMic(); if (!$('exitDialog').open) $('exitDialog').showModal(); }
    if (e.type === 'error') notice(`错误：${e.code}。请检查服务配置；暂停后可恢复或重新连接。`);
    if (e.type === 'notice') notice(e.text);
}

function handleConnectionStatus(status) {
  connected = status.state === 'connected';
  if (status.state === 'recovering') { stopMic(); $('state').textContent = status.reason === 'credential_expired'
    ? '恢复凭证已过期，正在建立新会话' : `正在重连${status.attempt ? `（第 ${status.attempt} 次）` : ''}`; }
  else if (status.state === 'connecting') $('state').textContent = '正在连接';
  else if (status.state === 'disconnected') { stopMic(); $('state').textContent = status.reason === 'credential_expired'
    ? '恢复凭证已过期，请重新输入应用 token' : status.reason === 'token_required'
      ? '请输入应用 token 以建立会话' : '连接已断开'; }
  if (status.connectionId && status.sessionId) $('connectionMeta').textContent = `${status.reason === 'resumed' ? '会话已恢复' : '新会话'} · 连接 ${status.connectionId.slice(0, 8)} · 会话 ${status.sessionId.slice(0, 8)}`;
  controls();
}

const conversationUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/conversation`;
session = new BrowserSessionClient({ url: conversationUrl, onEvent: handleServerEvent, onStatus: handleConnectionStatus });
$('connect').onclick = () => {
  const token = $('token').value.trim();
  if (!session.credential() && !session.deviceCredential() && token.length < 32) { notice('请填写本机 .env 中的 G2_CLIENT_TOKEN。'); return; }
  if (token) downloadToken = token;
  if (!session.connect(token)) { notice(connected ? '已经连接。' : '无法连接；请检查 token 或恢复凭证。'); return; }
  $('token').value = '';
};
$('voice').onclick = async () => {
  stopMic(); const epoch = micEpoch;
  try {
    const audio = new AudioContext({ sampleRate: 16000 }); context = audio;
    if (audio.sampleRate !== 16000) throw new Error('16kHz unsupported');
    await audio.resume();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    if (epoch !== micEpoch) { stream.getTracks().forEach(t => t.stop()); return; }
    media = stream;
    await audio.audioWorklet.addModule('/mic.js');
    if (epoch !== micEpoch) return;
    if (!connected || ['closed', 'exit_pending'].includes(state)) { stopMic(); return; }
    if (state === 'paused') send({ type: 'resume' });
    source = audio.createMediaStreamSource(stream); worklet = new AudioWorkletNode(audio, 'pcm16');
    worklet.port.onmessage = ({ data }) => {
      if (!active()) return;
      if (data?.type === 'flushed') { send({ type: 'turn.submit' }); return; }
      if ((session.socket?.bufferedAmount ?? 0) > 64000) { stopMic(); send({ type: 'pause' }); notice('音频发送积压，已暂停。'); return; }
      session.sendBinary(data);
    };
    source.connect(worklet); worklet.connect(audio.destination); // Processor outputs silence, never microphone feedback.
    stream.getAudioTracks()[0].onended = () => { if (media === stream) { stopMic(); send({ type: 'pause' }); } };
    $('mic').textContent = '● 麦克风开启 · 持续监听'; notice('直接说话即可，不需要每句按发送。');
  } catch { if (epoch === micEpoch) { stopMic(); send({ type: 'pause' }); notice('麦克风启动失败。请允许麦克风权限，并使用支持 AudioWorklet 的浏览器。'); } }
};
$('submit').onclick = () => { if (worklet) worklet.port.postMessage({ type: 'flush' }); else send({ type: 'turn.submit' }); };
$('pause').onclick = () => { stopMic(); send({ type: 'pause' }); };
$('resume').onclick = () => send({ type: 'resume' });
$('applyRouteMode').onclick = () => send({ type: 'route.mode', mode: $('routeMode').value });
$('interrupt').onclick = () => send({ type: 'interrupt' });
$('retry').onclick = () => send({ type: 'answer.retry' });
$('exit').onclick = () => { stopMic(); send({ type: 'exit.request' }); };
$('textForm').onsubmit = event => {
  event.preventDefault(); const text = $('text').value.trim(); if (!text || !active()) return;
  send({ type: 'text.submit', text }); $('text').value = '';
};
function exitChoice(confirm) { session.confirmExit(confirm); $('exitDialog').close(); }
$('confirmExit').onclick = () => exitChoice(true);
$('cancelExit').onclick = () => exitChoice(false);
$('exitDialog').oncancel = event => { event.preventDefault(); exitChoice(false); };
document.addEventListener('visibilitychange', () => { if (document.hidden) stopMic(); });
window.addEventListener('online', () => session.networkAvailable());
window.addEventListener('pagehide', () => {
  if (forceColdStart) return;
  stopMic(); session.dispose();
});

if (isLoopbackHost(location.hostname)) {
  $('devControls').hidden = false;
  $('resumeSession').onclick = () => { if (!session.simulateResume()) notice('需要先连接，才能模拟 session resume。'); };
  $('forceColdStart').onclick = () => {
    if (!session.canSimulateColdStart()) return notice('需要先连接并保存恢复凭证，才能模拟冷启动。');
    forceColdStart = true;
    notice('正在清空页面内存并模拟冷启动…');
    location.reload();
  };
  $('dropSocket').onclick = () => { if (!session.simulateDrop()) notice('当前没有可断开的连接。'); };
  $('retryConnection').onclick = () => { if (!session.networkAvailable()) notice('当前已连接，或没有可恢复的会话。'); };
  $('repeatSubmit').onclick = () => { if (!session.repeatLastSubmission()) notice('还没有可重复提交的文字消息。'); };
  $('expireSession').onclick = () => { if (!session.simulateExpiry()) notice('需要先用 token 连接本地测试服务器。'); };
  $('inspectStorage').onclick = () => { if (!session.storageTest('test.storage.inspect')) notice('需要先连接本地测试服务器。'); };
  $('seedExpiredRecord').onclick = () => { if (!session.storageTest('test.storage.seed_expired')) notice('需要先连接本地测试服务器。'); };
  $('previewRetention').onclick = () => { if (!session.storageTest('test.storage.cleanup_preview')) notice('需要先连接本地测试服务器。'); };
  $('applyRetention').onclick = () => {
    if (window.confirm('只清理 simulator 生成的三年前测试记录；真实会话不会删除。继续吗？')
      && !session.storageTest('test.storage.cleanup_apply')) notice('需要先连接本地测试服务器。');
  };
}
session.resumeIfAvailable();
