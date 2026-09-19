// UI feedback only: no model calls, fake percentages or synthetic search transitions.
export function createProgress(render, clock = { now: () => Date.now(), every: fn => setInterval(fn, 1000), cancel: id => clearInterval(id) }) {
  let phase = '', started = 0, answerId, timer;
  const paint = () => render(phase ? `${phase} · 已等待 ${Math.max(0, Math.floor((clock.now() - started) / 1000))} 秒 · 可打断` : '');
  const clear = () => {
    if (timer !== undefined) clock.cancel(timer);
    timer = undefined; phase = ''; answerId = undefined; paint();
  };
  const begin = (text, id) => {
    if (!phase) { started = clock.now(); timer = clock.every(paint); }
    phase = text; answerId = id; paint();
  };
  return { clear, event(e) {
    if (e.type === 'state') {
      if (e.state === 'thinking') { clear(); begin('正在理解…', undefined); }
      else if (e.state !== 'answering') clear();
      return;
    }
    if (e.type === 'error' || e.type === 'ready' || e.type === 'speech.started') { clear(); return; }
    if (e.type === 'answer.start') { begin('正在思考…', e.id); return; }
    if (answerId === undefined || e.id !== answerId) return;
    if (e.type === 'answer.done' || e.type === 'answer.cancelled') { clear(); return; }
    if (e.type === 'answer.delta') { phase = '正在输出回答…'; paint(); }
    if (e.type === 'artifact.status') { phase = e.status === 'sending' ? '正在提交邮件…' : '正在生成并保存文件…'; paint(); }
    if (e.type === 'calendar.status') { phase = e.status === 'saving' ? '正在保存到 Google 日历…' : e.status === 'querying' ? '正在查询／核对日历…' : '正在理解日历请求…'; paint(); }
    if (e.type === 'task.status') {
      phase = e.status === 'planning' ? '正在规划任务…'
        : e.status === 'calendar' ? '正在核对日历…'
        : e.status === 'locating' ? '正在获取当前位置…'
        : e.status === 'environment' ? '正在查询天气、空气和花粉…'
        : e.status === 'places' ? '正在比较地点、路线和评分…'
        : e.status === 'deciding' ? '正在综合条件并形成建议…'
        : e.status === 'previewing' ? '正在生成日历预览…'
        : '正在保存到 Google 日历…';
      paint();
    }
    if (e.type === 'route.status') {
      phase = e.status === 'locating' ? '正在获取当前位置…'
        : e.status === 'searching' ? '正在查找附近地点…'
        : e.status === 'comparing' ? '正在重新比较路线…'
        : e.status === 'clarifying' ? '正在确认地点含义…'
        : e.status === 'resolving' ? '正在解析地点…'
        : e.status === 'failed' ? `路线失败 · ${e.stage === 'places' ? '地点查询' : e.stage === 'routes' ? '路线计算' : '未知阶段'}…`
        : '正在比较路线、路况和评分…';
      paint();
    }
    if (e.type === 'search.status') {
      if (['in_progress', 'searching'].includes(e.status)) phase = '正在查资料…';
      else if (e.status === 'completed') phase = '查找结束，正在整理回答…';
      else if (e.status === 'failed') phase = '搜索未成功，正在整理回答…';
      else if (['quota_exhausted', 'quota_unavailable'].includes(e.status)) phase = '联网不可用，正在思考…';
      paint();
    }
  } };
}
