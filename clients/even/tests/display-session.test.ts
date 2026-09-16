import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisplaySession } from '../src/display-session.ts';

test('explicit reopen recreates a closed page, including repeated test sessions', async () => {
  const session = new DisplaySession(); let creates = 0;
  const create = async () => { creates++; return true; };
  assert.equal(await session.restore(create), true);
  await session.restore(create); assert.equal(creates, 1);
  for (let i = 0; i < 3; i++) {
    session.close(); assert.equal(session.open, false);
    assert.equal(await session.restore(create), true); assert.equal(session.open, true);
  }
  assert.equal(creates, 4);
});

test('failed startup is retryable; concurrent restores create once', async () => {
  const session = new DisplaySession();
  assert.equal(await session.restore(async () => false), false);
  await assert.rejects(session.restore(async () => { throw Error('bridge unavailable'); }));
  let creates = 0;
  await Promise.all([session.restore(async () => { creates++; return true; }), session.restore(async () => { creates++; return true; })]);
  assert.equal(creates, 1); assert.equal(session.open, true);
});

test('late startup acknowledgement cannot reopen a subsequently exited page', async () => {
  const session = new DisplaySession(); let finish!: (ok: boolean) => void;
  const pending = session.restore(() => new Promise<boolean>(resolve => { finish = resolve; }));
  await Promise.resolve(); session.close(); finish(true);
  assert.equal(await pending, false); assert.equal(session.open, false);
  assert.equal(await session.restore(async () => true), true);
});
