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
    if (e.type === 'search.status') {
      if (['in_progress', 'searching'].includes(e.status)) phase = '正在查资料…';
      else if (e.status === 'completed') phase = '查找结束，正在整理回答…';
      else if (e.status === 'failed') phase = '搜索未成功，正在整理回答…';
      else if (['quota_exhausted', 'quota_unavailable'].includes(e.status)) phase = '联网不可用，正在思考…';
      paint();
    }
  } };
}
