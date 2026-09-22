// Development-only UI. The release build excludes web/ entirely.
export function calendarPanel(root, send) {
  const heading = document.createElement('h2'); heading.textContent = 'Google Calendar · 真实事件测试';
  const note = document.createElement('p'); note.textContent = '也可直接在对话中查询或修改日程。范围仅为 Even Assistant 专用日历，不是你的全部日历。这里是独立手动测试入口；预览不会写入 Google，确认后才提交。';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const health = document.createElement('p'); health.setAttribute('role', 'status'); health.textContent = 'Google 读取状态：尚未检查';
  const probe = document.createElement('button'); probe.textContent = '检查 Google Calendar 连接';
  probe.onclick = () => send({ type: 'calendar.health', probe: true });
  const refresh = document.createElement('button'); refresh.textContent = '刷新本地事件记录';
  refresh.onclick = () => send({ type: 'calendar.list' });
  const editor = document.createElement('textarea'); editor.rows = 9; editor.setAttribute('aria-label', '日历事件 JSON');
  editor.value = JSON.stringify({ title: '', start: '', end: '', timezone: 'America/Chicago', allDay: false, location: '', notes: '' }, null, 2);
  const selection = document.createElement('p'); selection.textContent = '当前：新建日程';
  let selected;
  const create = document.createElement('button'); create.textContent = '预览新建';
  const update = document.createElement('button'); update.textContent = '预览修改所选事件';
  const cancel = document.createElement('button'); cancel.textContent = '预览取消所选事件';
  update.disabled = cancel.disabled = true;
  function prepare(kind) {
    try {
      send({ type: 'calendar.preview', kind, ...(kind !== 'create' ? { eventId: selected } : {}),
        ...(kind !== 'cancel' ? { event: JSON.parse(editor.value) } : {}) });
      status.textContent = '正在读取／核对日程…';
    } catch { status.textContent = 'JSON 格式错误，请检查填写内容。'; }
  }
  create.onclick = () => prepare('create'); update.onclick = () => prepare('update'); cancel.onclick = () => prepare('cancel');
  const list = document.createElement('div');
  root.append(heading, note, health, probe, status, refresh, selection, editor, create, update, cancel, list);
  root.hidden = true;
  return event => {
    if (event.type === 'access.changed' || event.type === 'transport.cleared') {
      selected = undefined; editor.value = ''; status.textContent = ''; health.textContent = '';
      selection.textContent = ''; list.replaceChildren(); root.hidden = true;
      update.disabled = cancel.disabled = true; return;
    }
    if (event.type === 'ready') { root.hidden = !event.capabilities?.calendar; if (!root.hidden) send({ type: 'calendar.list' }); }
    if (event.type === 'calendar.health') {
      const h = event.health;
      const label = { unknown: '尚未检查', reading: '读取中', retrying: '读取异常，自动重试一次', healthy: h.recovered ? '重试后恢复' : '正常', error: '读取失败' }[h.state] ?? '未知';
      health.textContent = `Google 读取状态：${label}${h.checkedAt ? ' · 检查时间 ' + h.checkedAt : ''}${h.attempts ? ' · 尝试 ' + h.attempts + '/2' : ''}${h.durationMs !== undefined ? ' · ' + h.durationMs + 'ms' : ''}${h.returnedCount !== undefined ? ' · 本页 ' + h.returnedCount + ' 条' : ''}${h.errorCode ? ' · 最近错误 ' + h.errorCode : ''}${h.httpStatus ? ' · HTTP ' + h.httpStatus : ''}`;
      probe.disabled = ['reading', 'retrying'].includes(h.state);
    }
    if (event.type === 'calendar.preview') {
      const phrase = window.prompt(event.preview);
      if (phrase !== null) send({ type: 'calendar.confirm', id: event.id, phrase });
      else send({ type: 'calendar.dismiss' });
    }
    if (event.type === 'calendar.working') status.textContent = '正在提交到 Google Calendar，请勿重复提交。';
    if (event.type === 'calendar.dismissed') status.textContent = '已放弃本次操作，没有提交。';
    if (event.type === 'calendar.error') status.textContent = `操作未完成：${event.code}。请重新预览；不要盲目重复创建。`;
    if (event.type === 'calendar.result') status.textContent = event.state === 'succeeded'
      ? 'Google Calendar 已保存操作；如有受邀人，已请求 Google 发送通知。Apple Calendar 同步可能稍有延迟。'
      : `操作状态：${event.state}（${event.error ?? ''}）。unknown 表示结果不确定，请先在 Google Calendar 核实，不要重新创建。conflict 表示日程已变化，请重新预览。`;
    if (event.type === 'calendar.list') {
      list.replaceChildren();
      for (const item of event.events) {
        const row = document.createElement('p'); row.textContent = `${item.event.title} · ${item.event.start} → ${item.event.end}${item.cancelled ? ' · 已取消' : ''} `;
        const pick = document.createElement('button'); pick.textContent = '选择编辑'; pick.disabled = item.cancelled;
        pick.onclick = () => { selected = item.id; selection.textContent = `所选：${item.event.title}（确认前会读取 Google 最新版）`;
          editor.value = JSON.stringify(item.event, null, 2); update.disabled = cancel.disabled = false; };
        row.append(pick); list.append(row);
      }
      const ledger = document.createElement('pre'); ledger.style.whiteSpace = 'pre-wrap';
      ledger.textContent = event.operations.map(op => `${op.kind} · ${op.state} · ${op.id}${op.error ? ' · ' + op.error : ''}`).join('\n'); list.append(ledger);
    }
  };
}
