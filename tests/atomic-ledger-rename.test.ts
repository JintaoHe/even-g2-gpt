import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceLedgerFile } from '../src/atomic-ledger-rename.js';

test('ledger replacement retries transient sharing errors with a bounded delay', async () => {
  let calls = 0; const delays: number[] = [];
  await replaceLedgerFile('source', 'target', async (source, target) => {
    assert.equal(source, 'source'); assert.equal(target, 'target');
    if (++calls < 4) throw Object.assign(new Error(), { code: calls === 2 ? 'EBUSY' : 'EPERM' });
  }, async ms => { delays.push(ms); });
  assert.equal(calls, 4); assert.deepEqual(delays, [50, 100, 200]);
});

test('ledger replacement stops on permanent errors and after four transient attempts', async () => {
  for (const code of ['EACCES', 'ENOSPC', 'EPERM']) {
    let calls = 0;
    await assert.rejects(replaceLedgerFile('source', 'target', async () => {
      calls++; throw Object.assign(new Error(), { code });
    }, async () => {}), (error: any) => error.code === code);
    assert.equal(calls, code === 'EPERM' ? 4 : 1);
  }
});
