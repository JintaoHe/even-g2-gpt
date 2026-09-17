import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('progress reports real phases, elapsed time, and clears on cancellation, failures and disconnect', async () => {
  const code = (await readFile(new URL('../web/progress.js', import.meta.url), 'utf8')).replace('export function', 'function');
  const context: any = {}; runInNewContext(code + '\nthis.create = createProgress;', context);
  let now = 0, text = '', tick: (() => void) | undefined, timers = 0;
  const progress = context.create((value: string) => { text = value; }, {
    now: () => now, every: (fn: () => void) => { tick = fn; timers++; return 1; }, cancel: () => { tick = undefined; timers--; }
  });
  progress.event({ type: 'state', state: 'thinking' }); assert.match(text, /正在理解/);
  now = 8000; tick!(); assert.match(text, /8 秒/); assert.doesNotMatch(text, /查资料/);
  progress.event({ type: 'answer.start', id: 1 }); assert.match(text, /正在思考/); assert.equal(timers, 1);
  progress.event({ type: 'artifact.status', status: 'generating', id: 1 }); assert.match(text, /生成并保存文件/);
  progress.event({ type: 'artifact.status', status: 'sending', id: 1 }); assert.match(text, /提交邮件/);
  progress.event({ type: 'search.status', status: 'searching', id: 1 }); assert.match(text, /正在查资料/);
  progress.event({ type: 'search.status', status: 'completed', id: 1 }); assert.match(text, /整理回答/);
  progress.event({ type: 'answer.cancelled', id: 1 }); assert.equal(text, ''); assert.equal(timers, 0);
  progress.event({ type: 'state', state: 'thinking' });
  progress.event({ type: 'answer.start', id: 2 });
  progress.event({ type: 'search.status', status: 'searching', id: 1 }); assert.doesNotMatch(text, /查资料/);
  progress.event({ type: 'answer.done', id: 1 }); assert.notEqual(text, '');
  progress.event({ type: 'answer.done', id: 2 }); assert.equal(text, ''); assert.equal(timers, 0);
  for (const ending of [{ type: 'error' }, { type: 'state', state: 'paused' }, { type: 'state', state: 'exit_pending' }, { type: 'state', state: 'closed' }, { type: 'speech.started' }]) {
    progress.event({ type: 'answer.start', id: 3 }); progress.event(ending); assert.equal(text, ''); assert.equal(timers, 0);
  }
  progress.event({ type: 'answer.start', id: 4 }); progress.clear(); assert.equal(text, ''); assert.equal(timers, 0);
});
