import { renderCitations } from './citations.js';
import { createProgress } from './progress.js';
const $ = id => document.getElementById(id);
const progress = createProgress(text => { $('progress').textContent = text; });
let socket, state = 'closed', connected = false, context, media, source, worklet, micEpoch = 0;
let speechAvailable = true;
let emailAvailable = false;
let cliSearchEnabled = false;
let downloadToken = '', jobTimer;
const answers = new Map();
const labels = { listening: '等待说话 / 继续追问', thinking: '判断意图中（可继续说）', answering: '回答中（可插话）', paused: '已暂停', exit_pending: '已停止收音，等待退出确认', closed: '已结束' };
const active = () => connected && ['listening', 'thinking', 'answering'].includes(state);
function send(value) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
function notice(text) { $('notice').textContent = text; }
function controls() {
  for (const id of ['voice', 'resume']) $(id).disabled = !connected || ['closed', 'exit_pending'].includes(state);
  if (!speechAvailable) $('voice').disabled = true;
  for (const id of ['submit', 'pause', 'interrupt', 'retry', 'send']) $(id).disabled = !active();
  $('exit').disabled = !connected || ['closed', 'exit_pending'].includes(state);
  $('connect').disabled = connected;
  $('exportMd').disabled = !connected;
  $('exportCalendar').disabled = !connected;
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
        try {
          const response = await fetch(`/artifacts/${encodeURIComponent(job.id)}${calendar ? '/calendar' : ''}`, { headers: { Authorization: `Bearer ${downloadToken}` } });
          if (!response.ok) throw new Error('Download failed');
          const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
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
$('connect').onclick = () => {
  if (socket && socket.readyState < WebSocket.CLOSING) return;
  const token = $('token').value.trim();
  if (token.length < 32) { notice('请填写本机 .env 中的 G2_CLIENT_TOKEN。'); return; }
  socket = new WebSocket(`ws://${location.host}/ws/conversation`);
  socket.onopen = () => send({ type: 'hello', token });
  socket.onmessage = ({ data }) => {
    const e = JSON.parse(data);
    progress.event(e);
    if (e.type === 'ready') {
      emailAvailable = e.capabilities?.email === true;
      downloadToken = token; clearInterval(jobTimer);
      send({ type: 'jobs.list' }); jobTimer = setInterval(() => send({ type: 'jobs.list' }), 3000);
      connected = true; $('token').value = ''; notice('已连接。点击开启麦克风，或发送文字。');
      speechAvailable = e.capabilities?.speech !== false;
      const provider = e.capabilities?.provider;
      cliSearchEnabled = provider === 'codex-cli' && e.capabilities.webSearch;
      $('channel').textContent = provider === 'codex-cli' ? '当前测试：Codex CLI 版本（ChatGPT 账号通道）' : provider === 'api' ? '当前测试：OpenAI API 调用版本' : '测试通道：服务器未提供，无法确认';
      $('channelDetails').textContent = provider === 'codex-cli'
        ? `对话与搜索：Codex CLI · 整条回答返回 · 搜索${e.capabilities.webSearch ? '开启' : '关闭'} · 搜索开启时回答推理最低 low。${speechAvailable ? '语音转录：OpenAI API，仍产生 API 用量。' : '仅支持文字输入。'}`
        : provider === 'api' ? `对话：OpenAI API · 流式回答 · 搜索${e.capabilities.webSearch ? '开启，受 API 搜索额度限制' : '关闭'}。${speechAvailable ? '语音转录：OpenAI API。' : '仅支持文字输入。'}` : '请检查服务器版本。';
      $('models').textContent = e.models ? `通道：${e.capabilities?.provider ?? 'api'} · 意图：${e.models.intent} · 回答：${e.models.reply}` : '测试模型';
      if (e.capabilities?.provider === 'codex-cli') notice(`Codex CLI：整条回答返回，${e.capabilities.webSearch ? '原生联网搜索已开启（使用 Codex 账号额度）' : '联网搜索已关闭'}。${speechAvailable ? '语音转录仍走 OpenAI API。' : '未配置 API key，仅支持文字输入。'}`);
    }
    if (e.type === 'jobs.list') renderJobs(e.jobs);
    if (e.type === 'mail.confirmation_required') {
      if (window.confirm(`${e.preview}\n\n确认将这些附件发送到固定邮箱吗？`)) send({ type: 'jobs.email', id: e.id, confirmation: e.confirmation });
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
    if (e.type === 'turn.committed') { message('你', e.text); notice(''); }
    if (e.type === 'answer.start') {
      const answer = message('Even'); answers.set(e.id, answer);
      if (['none', 'low', 'medium'].includes(e.reasoningEffort)) {
        const mode = document.createElement('small');
        mode.textContent = ` · 推理：${cliSearchEnabled && e.reasoningEffort === 'none' ? 'low（CLI 搜索最低档）' : e.reasoningEffort}`;
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
  };
  socket.onclose = () => { clearInterval(jobTimer); downloadToken = ''; progress.clear(); connected = false; state = 'closed'; stopMic(); $('channel').textContent = '测试通道：已断开，重新连接后确认'; $('channelDetails').textContent = ''; $('state').textContent = '连接已结束（重新连接将开启新会话）'; $('exitDialog').close(); controls(); };
  socket.onerror = () => { progress.clear(); stopMic(); notice('连接失败，请确认本地服务正在运行。'); };
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
      if (socket.bufferedAmount > 64000) { stopMic(); send({ type: 'pause' }); notice('音频发送积压，已暂停。'); return; }
      socket.send(data);
    };
    source.connect(worklet); worklet.connect(audio.destination); // Processor outputs silence, never microphone feedback.
    stream.getAudioTracks()[0].onended = () => { if (media === stream) { stopMic(); send({ type: 'pause' }); } };
    $('mic').textContent = '● 麦克风开启 · 持续监听'; notice('直接说话即可，不需要每句按发送。');
  } catch { if (epoch === micEpoch) { stopMic(); send({ type: 'pause' }); notice('麦克风启动失败。请允许麦克风权限，并使用支持 AudioWorklet 的浏览器。'); } }
};
$('submit').onclick = () => { if (worklet) worklet.port.postMessage({ type: 'flush' }); else send({ type: 'turn.submit' }); };
$('pause').onclick = () => { stopMic(); send({ type: 'pause' }); };
$('resume').onclick = () => send({ type: 'resume' });
$('interrupt').onclick = () => send({ type: 'interrupt' });
$('retry').onclick = () => send({ type: 'answer.retry' });
$('exit').onclick = () => { stopMic(); send({ type: 'exit.request' }); };
$('textForm').onsubmit = event => {
  event.preventDefault(); const text = $('text').value.trim(); if (!text || !active()) return;
  send({ type: 'text.submit', text }); $('text').value = '';
};
function exitChoice(confirm) { send({ type: 'exit.confirm', confirm }); $('exitDialog').close(); }
$('confirmExit').onclick = () => exitChoice(true);
$('cancelExit').onclick = () => exitChoice(false);
$('exitDialog').oncancel = event => { event.preventDefault(); exitChoice(false); };
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopMic(); if (active()) send({ type: 'pause' }); } });
window.addEventListener('pagehide', () => { stopMic(); socket?.close(); });
