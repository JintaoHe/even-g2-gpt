import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lockedDevicePrincipal, requestsGuestMode, requireGuestAccess, requireGuestResume,
  type GuestCapability } from '../src/guest-access.js';

test('accessor-backed identity cannot change mode between validation and use', () => {
  let reads = 0;
  const principal = { get mode() { reads++; return reads === 1 ? 'guest' : 'owner'; },
    ownerScope: `guest:${randomUUID()}`, sessionId: randomUUID() };
  assert.throws(() => requireGuestAccess(principal, 'email'), /GUEST_ACCESS_DENIED/);
  assert.equal(reads, 0);
});

test('guest command is whole-utterance only, never negation, quotation or discussion', () => {
  for (const text of ['访客模式', ' 访客模式！ ', 'Guest Mode.', 'GUEST   MODE', '访客 模式', '访客模式，',
    '访客模式…', '访客模式~', 'guest-mode', 'ＧＵＥＳＴ　ＭＯＤＥ', '訪客模式', '进入访客模式',
    '开启访客模式', '切换到访客模式', 'enable guest mode', 'switch to guest-mode']) assert.equal(requestsGuestMode(text), true, text);
  for (const text of ['不要访客模式', '“访客模式”', 'guest mode 是什么意思？', 'not guest mode',
    '切换访客模式然后查我的邮件', '他刚说访客模式', '退出访客模式', 'guest mode off', '',
    '访客模式？', 'guest mode?', '进入访客模式吗', '"enable guest mode"', '不要开启访客模式', 'guest:mode']) {
    assert.equal(requestsGuestMode(text), false, text);
  }
});

test('a verified device lock produces guest identity regardless of nominal owner scope', () => {
  const lock = { guestScope: `guest:${randomUUID()}`, sessionId: randomUUID() };
  const principal = lockedDevicePrincipal(lock, 'single-user');
  assert.deepEqual(principal, { mode: 'guest', ownerScope: lock.guestScope, sessionId: lock.sessionId });
  assert.deepEqual(lockedDevicePrincipal(JSON.parse(JSON.stringify(lock)), 'other-owner'), principal);
  assert.throws(() => lockedDevicePrincipal({ ...lock, guestScope: 'single-user' }, 'single-user'), /GUEST_ACCESS_DENIED/);
  assert.throws(() => lockedDevicePrincipal({ ...lock, sessionId: '' }, 'single-user'), /GUEST_ACCESS_DENIED/);
  assert.throws(() => lockedDevicePrincipal(undefined, lock.guestScope), /GUEST_ACCESS_DENIED/);
});

test('guest capability policy fails closed for every private tool and download path', () => {
  const principal = lockedDevicePrincipal({ guestScope: `guest:${randomUUID()}`, sessionId: randomUUID() }, 'single-user');
  for (const capability of ['conversation', 'routes', 'search', 'draft_create'] as GuestCapability[]) {
    assert.doesNotThrow(() => requireGuestAccess(principal, capability));
  }
  for (const capability of ['prior_context', 'history_search', 'long_term_memory', 'calendar', 'email', 'cli',
    'jobs_list', 'calendar_list', 'artifact', 'unknown'] as GuestCapability[]) {
    assert.throws(() => requireGuestAccess(principal, capability), /GUEST_ACCESS_DENIED/, capability);
  }
});

test('scope plus session isolate two guests on the same device and prevent owner snapshot reuse', () => {
  const scope = `guest:${randomUUID()}`, sessionId = randomUUID();
  const principal = lockedDevicePrincipal({ guestScope: scope, sessionId }, 'single-user');
  assert.doesNotThrow(() => requireGuestResume(principal, { ownerScope: scope, sessionId }));
  for (const resource of [{ ownerScope: 'single-user', sessionId },
    { ownerScope: `guest:${randomUUID()}`, sessionId }, { ownerScope: scope, sessionId: randomUUID() }]) {
    assert.throws(() => requireGuestResume(principal, resource), /GUEST_ACCESS_DENIED/);
    assert.throws(() => requireGuestAccess(principal, 'draft_read', resource), /GUEST_ACCESS_DENIED/);
  }
  assert.throws(() => requireGuestResume(lockedDevicePrincipal(undefined, 'single-user'),
    { ownerScope: scope, sessionId }), /GUEST_ACCESS_DENIED/);
});

test('runtime principal validation never treats malformed identities as owners', () => {
  const scope = `guest:${randomUUID()}`;
  for (const principal of [null, undefined, [], {}, { mode: 'owner' },
    ...['GUEST', 'Guest ', undefined, 'visitor', 'owner'].map(mode => ({ mode, ownerScope: scope })),
    { mode: 'owner', ownerScope: 'single-user', sessionId: randomUUID() },
    Object.create({ mode: 'owner', ownerScope: 'single-user' })]) {
    for (const capability of ['calendar', 'email', 'draft_create', 'conversation']) {
      assert.throws(() => requireGuestAccess(principal, capability), /GUEST_ACCESS_DENIED/);
    }
  }
  assert.throws(() => requireGuestAccess({ mode: 'owner', ownerScope: 'single-user' }, 'unknown'), /GUEST_ACCESS_DENIED/);
});

test('owner scope validation rejects guest lookalikes and malformed lock values fail closed', () => {
  const id = randomUUID();
  for (const scope of [`guest:${id}`, `GUEST:${id}`, `Guest:${id}`, ` guest:${id}`, `guest :${id}`,
    `ｇｕｅｓｔ:${id}`, 'single-user\n', '', ' ', 1, null]) {
    assert.throws(() => lockedDevicePrincipal(undefined, scope), /GUEST_ACCESS_DENIED/);
    assert.throws(() => requireGuestAccess({ mode: 'owner', ownerScope: scope }, 'email'), /GUEST_ACCESS_DENIED/);
  }
  for (const lock of [null, false, 0, '', [], {}, { guestScope: `GUEST:${id}`, sessionId: id },
    { guestScope: `guest:${id}`, sessionId: `${id}\n` }]) {
    assert.throws(() => lockedDevicePrincipal(lock, 'single-user'), /GUEST_ACCESS_DENIED/);
  }
});

test('draft reads and resumes require valid resource metadata; creation is a separate capability', () => {
  const lock = { guestScope: `guest:${randomUUID()}`, sessionId: randomUUID() };
  const principal = lockedDevicePrincipal(lock, 'single-user');
  assert.doesNotThrow(() => requireGuestAccess(principal, 'draft_create'));
  assert.doesNotThrow(() => requireGuestAccess(principal, 'draft_read', { ownerScope: lock.guestScope, sessionId: lock.sessionId }));
  for (const resource of [undefined, null, {}, { ownerScope: lock.guestScope },
    { ownerScope: lock.guestScope, sessionId: 'invalid' }]) {
    assert.throws(() => requireGuestAccess(principal, 'draft_read', resource), /GUEST_ACCESS_DENIED/);
    assert.throws(() => requireGuestResume(principal, resource), /GUEST_ACCESS_DENIED/);
  }
  const owner = lockedDevicePrincipal(undefined, 'single-user');
  assert.throws(() => requireGuestAccess(owner, 'artifact'), /GUEST_ACCESS_DENIED/);
  assert.throws(() => requireGuestAccess(principal, 'draft'), /GUEST_ACCESS_DENIED/);
});

test('command parsing rejects non-text and bounds oversized inputs', () => {
  for (const input of [undefined, null, 1, {}, ['访客模式']]) assert.throws(() => requestsGuestMode(input), /INVALID_GUEST_COMMAND/);
  assert.equal(requestsGuestMode(' '.repeat(1024 * 1024)), false);
  assert.equal(requestsGuestMode('访客模式' + ' '.repeat(1024 * 1024)), false);
});
