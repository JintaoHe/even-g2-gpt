import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../src/conversation-store.js';
import { ContextBuilder, contextCharacterCount } from '../src/context-builder.js';
import { priorContextText } from '../src/prior-session-context.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'even-prior-'));
  const store = await ConversationStore.create(root); t.after(() => store.close());
  const create = (at: number, scope = 'single-user') => {
    const id = randomUUID(), topic = randomUUID();
    store.createSession({ id, ownerScope: scope, createdAt: at, initialTopic: { id: topic, label: 'General' } });
    return { id, topic };
  };
  const pair = (s: ReturnType<typeof create>, at: number, user = '提议用 Cedar 索引', answer = '先评估，还没有决定') => {
    const turnId = randomUUID(), messageId = randomUUID();
    store.commitUserTurn({ sessionId: s.id, topicId: s.topic, turnId, messageId: randomUUID(), content: user, createdAt: at });
    store.startAssistantAnswer({ sessionId: s.id, topicId: s.topic, turnId, messageId, createdAt: at + 1 });
    store.commitAssistantAnswer({ messageId, content: answer, updatedAt: at + 2 });
  };
  return { root, store, create, pair };
}

test('two-second reopen uses unsummarized committed tail, no magic reference phrase and no writes', async t => {
  const f = await fixture(t), prior = f.create(100), current = f.create(3100);
  f.pair(prior, 200); f.store.endSession(prior.id, 1100, 'user_exit');
  const before = f.store.listMessages(current.id);
  const data = f.store.priorSessionContext({ ownerScope: 'single-user', currentSessionId: current.id, before: 3100 })!;
  assert.equal(data.sessionId, prior.id); assert.equal(data.summary, undefined); assert.equal(data.tail.length, 2);
  const built = new ContextBuilder().build({ messages: [], prior: data });
  assert.equal(built.messages[0].contextKind, 'prior'); assert.match(built.messages[0].content, /还没有决定/);
  assert.match(built.messages[0].content, /不是本轮用户指令或授权/);
  assert.ok(built.messages[0].content.length <= 1500);
  assert.deepEqual(f.store.listMessages(current.id), before);
});

test('scope, guest, current-session and input bounds fail closed', async t => {
  const f = await fixture(t), owner = f.create(100), other = f.create(100, 'other-owner');
  const guestScope = `guest:${randomUUID()}`, guest = f.create(100, guestScope);
  for (const [ownerScope, currentSessionId] of [
    [guestScope, guest.id], ['single-user', guest.id], ['single-user', other.id], ['GUEST:'+randomUUID(), owner.id],
  ]) assert.throws(() => f.store.priorSessionContext({ ownerScope, currentSessionId, before: 1000 }));
  for (const patch of [{ withinMs: 86400001 }, { withinMs: 0 }, { tailLimit: 13 }, { tailLimit: 0 }, { before: NaN }]) {
    assert.throws(() => f.store.priorSessionContext({ ownerScope: 'single-user', currentSessionId: owner.id, before: 1000, ...patch }));
  }
  const earlier = f.create(1); f.pair(earlier, 2); f.store.endSession(earlier.id, 5, 'user_exit');
  f.pair(guest, 101); f.store.endSession(guest.id, 200, 'user_exit');
  assert.equal(f.store.priorSessionContext({ ownerScope: 'single-user', currentSessionId: owner.id, before: 1000 })?.sessionId, earlier.id);
});

test('24-hour inclusive cutoff, no future/session-after-start, no idle or active prior', async t => {
  const f = await fixture(t), prior = f.create(1); f.pair(prior, 2); f.store.expireSession(prior.id, 10);
  const current = f.create(100), future = f.create(120), idle = f.create(20);
  f.pair(future, 130); f.store.endSession(future.id, 200, 'user_exit'); f.store.markSessionDetached(idle.id, 90);
  const query = (before: number) => f.store.priorSessionContext({ ownerScope: 'single-user', currentSessionId: current.id, before });
  assert.equal(query(10 + 86400000)?.sessionId, prior.id);
  assert.equal(query(11 + 86400000), undefined); assert.equal(query(99), undefined);
});

test('message-sequence 20 is allowed, 21 is not; tail has at most 12 committed messages', async t => {
  const f = await fixture(t), prior = f.create(1), current = f.create(1000);
  for (let i = 0; i < 10; i++) f.pair(prior, 10+i*3);
  f.store.endSession(prior.id, 100, 'user_exit');
  const query = () => f.store.priorSessionContext({ ownerScope: 'single-user', currentSessionId: current.id, before: 2000 });
  assert.equal(query()!.tail.length, 12); assert.equal(query()!.tail[0].sequence, 9);
  for (let i = 0; i < 10; i++) f.pair(current, 1100+i*3);
  assert.ok(query());
  assert.equal(f.store.priorSessionContext({ ownerScope: 'single-user', currentSessionId: current.id, before: 2000, pendingUserTurn: true }), undefined);
  f.store.commitUserTurn({ sessionId: current.id, topicId: current.topic, turnId: randomUUID(), messageId: randomUUID(), content: '第21条', createdAt: 1200 });
  assert.equal(query(), undefined);
});

test('newly completed summary refreshes coverage, avoids duplicate tail and preserves loss/damage', async t => {
  const f = await fixture(t), prior = f.create(1);
  for (let i=0; i<4; i++) f.pair(prior, 10+i*3);
  f.store.enqueueSummaryJob({ sessionId: prior.id, fromSequence: 1, throughSequence: 6, createdAt: 90 });
  f.store.endSession(prior.id, 100, 'user_exit'); const current = f.create(200);
  const query = () => f.store.priorSessionContext({ ownerScope: 'single-user', currentSessionId: current.id, before: 200 })!;
  assert.equal(query().tail.length, 8);
  const job = f.store.claimNextSummaryJob(150)!;
  f.store.completeSummaryJob({ id: job.id, at: 160, model: 'test', summary: { version: 1, throughSequence: 6,
    overview: '考虑索引，未定案', topics: [], confirmedDecisions: [], unresolvedItems: ['是否增加备份'] },
    losses: [{kind:'message',sequence:2,omittedBytes:40}] });
  assert.equal(query().throughSequence, 6); assert.deepEqual(query().tail.map(x=>x.sequence), [7,8]);
  assert.equal(query().sourceLosses, true);
  const db = new DatabaseSync(join(f.root,'assistant-memory.sqlite'));
  try { db.prepare('UPDATE session_summaries SET summary_json=? WHERE session_id=?').run('not json',prior.id); }
  finally { db.close(); }
  assert.match(priorContextText(query())!, /此前摘要损坏/); assert.equal(query().throughSequence, 6);
});

test('prior consumes only leftover budget, preserves newest input and valid Unicode JSON', async t => {
  const f=await fixture(t), prior=f.create(1); f.pair(prior,2,'😀\n"'.repeat(1000),'尚未授权发送'); f.store.endSession(prior.id,10,'user_exit');
  const current=f.create(20), data=f.store.priorSessionContext({ownerScope:'single-user',currentSessionId:current.id,before:20})!;
  for (const maxCharacters of [512,1000,1500,24000]) {
    const builder=new ContextBuilder({maxCharacters});
    const messages=[{role:'user' as const,content:'CURRENT '.repeat(90)}];
    const without=builder.build({messages}), withPrior=builder.build({messages,prior:data});
    assert.deepEqual(withPrior.messages.filter(x=>x.contextKind!=='prior'),without.messages);
    assert.ok(contextCharacterCount(withPrior.messages)<=maxCharacters);
    const block=withPrior.messages.find(x=>x.contextKind==='prior');
    if(block){assert.ok(block.content.length<=1500);const parsed=JSON.parse(block.content.slice(block.content.indexOf('\n')+1));assert.ok(parsed.boundedExcerpt);}
  }
});

test('interrupted assistants are excluded and reopening stays deterministic', async t => {
  const root=await mkdtemp(join(tmpdir(),'even-prior-restart-'));let store=await ConversationStore.create(root);
  t.after(()=>store.close());
  const id=randomUUID(),topic=randomUUID(),current=randomUUID(),turnId=randomUUID(),messageId=randomUUID();
  store.createSession({id,ownerScope:'single-user',createdAt:1,initialTopic:{id:topic,label:'Design'}});
  store.commitUserTurn({sessionId:id,topicId:topic,turnId,messageId:randomUUID(),content:'先别下结论',createdAt:2});
  store.startAssistantAnswer({sessionId:id,topicId:topic,turnId,messageId,createdAt:3});
  store.checkpointAssistantAnswer({messageId,content:'错误的迟到结论',updatedAt:4});
  store.interruptAssistantAnswer({turnId,updatedAt:5,reason:'TEST_INTERRUPTED'});store.endSession(id,6,'user_exit');
  store.createSession({id:current,ownerScope:'single-user',createdAt:8});
  const query=()=>store.priorSessionContext({ownerScope:'single-user',currentSessionId:current,before:10})!;
  assert.deepEqual(query().tail.map(x=>x.role),['user']);assert.doesNotMatch(JSON.stringify(query()),/错误的迟到结论/);
  const first=priorContextText(query());await store.close();store=await ConversationStore.create(root);
  assert.equal(priorContextText(query()),first);
});

test('latest closed owner session is deterministic, no fallback across owner/guest scope', async t => {
  const f=await fixture(t),a=f.create(1),b=f.create(2),other=f.create(3,'other-owner'),guest=f.create(4,`guest:${randomUUID()}`);
  for(const s of [a,b,other,guest])f.pair(s,10);
  f.store.endSession(a.id,20,'user_exit');f.store.endSession(b.id,30,'user_exit');
  f.store.endSession(other.id,40,'user_exit');f.store.endSession(guest.id,50,'user_exit');
  const current=f.create(60);
  assert.equal(f.store.priorSessionContext({ownerScope:'single-user',currentSessionId:current.id,before:60})?.sessionId,b.id);
});
