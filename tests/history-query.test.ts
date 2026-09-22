import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { prepareHistoryQuery, prepareHistoryContext, HISTORY_QUERY_LIMITS } from '../src/history-query.js';

const owner = { mode: 'owner' as const, ownerScope: 'single-user' }, now = 2_000_000_000_000;
const search = (query: string) => prepareHistoryQuery(owner, { query }, now);

test('history query defaults and exact time/limit boundaries are bounded', () => {
  const result = search('咖啡采购');
  assert.equal(result.sinceMs, now - HISTORY_QUERY_LIMITS.windowMs);
  assert.equal(result.untilMs, now); assert.equal(result.limit, 10); assert.ok(Object.isFrozen(result));
  for (const sinceMs of [result.sinceMs, now]) assert.doesNotThrow(() => prepareHistoryQuery(owner, { query: 'x', sinceMs, limit: 1 }, now));
  for (const sinceMs of [result.sinceMs - 1, now + 1, NaN, -1, 1.5, null])
    assert.throws(() => prepareHistoryQuery(owner, { query: 'x', sinceMs: sinceMs as number }, now));
  for (const limit of [0, 11, 1.5, NaN, null]) assert.throws(() => prepareHistoryQuery(owner, { query: 'x', limit: limit as number }, now));
  assert.equal(prepareHistoryQuery(owner, { query: 'x' }, 0).sinceMs, 0);
});

test('Unicode code points choose short-query fallback; operators are literal phrases', () => {
  for (const query of ['生日', 'OR', '🚲🚲', '*', 'é']) assert.equal(search(query).kind, 'like');
  for (const query of ['100%', 'a_b', 'OR NOT', '"x"', '设备维修', '🚲🚲🚲']) {
    const prepared = search(query); assert.equal(prepared.kind, 'fts');
    assert.equal(prepared.parameter.slice(1, -1).replace(/""/g, '"'), query);
  }
  assert.equal(search('  电池采购  ').query, '电池采购');
  assert.doesNotThrow(() => search('🚲'.repeat(256)));
  assert.throws(() => search('🚲'.repeat(257)));
});

test('LIKE escaping matches only literal wildcard and escape characters in real SQLite', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE examples(content TEXT)');
    for (const value of ['100%', 'a_b', 'aXb', 'plain', 'C:\\', '生日', '🚲🚲']) db.prepare('INSERT INTO examples VALUES (?)').run(value);
    for (const [query, expected] of [['%', ['100%']], ['_', ['a_b']], ['\\', ['C:\\']], ['生日', ['生日']], ['🚲🚲', ['🚲🚲']]] as const) {
      const result = db.prepare("SELECT content FROM examples WHERE content LIKE ? ESCAPE '\\'").all(search(query).parameter);
      assert.deepEqual(result.map(row => (row as { content: string }).content), expected);
    }
  } finally { db.close(); }
});

test('empty, oversized, control, malformed Unicode and invalid runtime inputs are rejected', () => {
  for (const query of ['', '   ', '\n', 'abc\u0000def', 'a\nb', '\ud800', '\udfff', 'x'.repeat(257), ' '.repeat(1000000)])
    assert.throws(() => search(query), /HISTORY_QUERY_INVALID/);
  for (const input of [null, undefined, [], {}, { query: 2 }])
    assert.throws(() => prepareHistoryQuery(owner, input as any, now));
  for (const clock of [NaN, Infinity, -1, 1.5]) assert.throws(() => prepareHistoryQuery(owner, { query: 'abc' }, clock));
});

test('both preparation entry points deny guest and malformed identities', () => {
  for (const principal of [{ mode: 'guest', ownerScope: `guest:${randomUUID()}`, sessionId: randomUUID() },
    { mode: 'owner', ownerScope: `GUEST:${randomUUID()}` }, { mode: 'OWNER', ownerScope: 'single-user' }, {}, null]) {
    assert.throws(() => prepareHistoryQuery(principal as any, { query: '旅行' }, now), /GUEST_ACCESS_DENIED/);
    assert.throws(() => prepareHistoryContext(principal as any, { messageId: randomUUID() }), /GUEST_ACCESS_DENIED/);
  }
});

test('neighbour request has exact bounds, does not itself grant access to a message', () => {
  const messageId = randomUUID(), result = prepareHistoryContext(owner, { messageId });
  assert.deepEqual(result, { ownerScope: 'single-user', messageId, before: 3, after: 3 });
  assert.ok(Object.isFrozen(result));
  assert.equal(prepareHistoryContext(owner, { messageId, before: 0, after: 0 }).before, 0);
  for (const value of [-1, 4, 1.5, NaN, null]) {
    assert.throws(() => prepareHistoryContext(owner, { messageId, before: value as number }));
    assert.throws(() => prepareHistoryContext(owner, { messageId, after: value as number }));
  }
  for (const id of ['', 'not-a-uuid', messageId + '\n', '00000000-0000-0000-0000-000000000000'])
    assert.throws(() => prepareHistoryContext(owner, { messageId: id }));
});
