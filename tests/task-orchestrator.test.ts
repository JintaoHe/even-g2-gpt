import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConditionalTaskOrchestrator, createTaskState, type TaskPlan, type TaskToolRegistry } from '../src/task-orchestrator.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const accept = () => {};
const plan = (calendarBusy = false): TaskPlan => ({ id: 'task-outdoor-plan', version: 1, goal: 'If free, plan a family park visit', nodes: [
  { id: 'calendar', tool: 'calendar.query', dependsOn: [], condition: null, input: { range: 'afternoon' } },
  { id: 'location', tool: 'location.once', dependsOn: ['calendar'], condition: { nodeId: 'calendar', field: 'hasEvents', equals: false }, input: {} },
  ...['weather', 'air', 'pollen', 'parks'].map(id => ({ id, tool: `${id}.read`, dependsOn: ['location'], condition: null, input: {} })),
  { id: 'synthesis', tool: 'assistant.synthesize', dependsOn: ['weather', 'air', 'pollen', 'parks'], condition: null, input: {} },
  { id: 'preview', tool: 'calendar.preview', dependsOn: ['synthesis'], condition: null, input: {} },
  { id: 'commit', tool: 'calendar.commit', dependsOn: ['preview'], condition: null, input: {} }
] as TaskPlan['nodes'] });

test('conditional task runs independent evidence in parallel, redacts GPS and gates the write', async () => {
  let active = 0, peak = 0, commits = 0;
  const evidence = (name: string) => ({ risk: 'read' as const, timeoutMs: 1_000, maxAttempts: 2, validateInput: accept,
    execute: async () => { active++; peak = Math.max(peak, active); await delay(20); active--; return { available: true, summary: name }; } });
  const registry: TaskToolRegistry = {
    'calendar.query': { risk: 'read', timeoutMs: 1_000, maxAttempts: 2, validateInput: accept, execute: async () => ({ hasEvents: false }) },
    'location.once': { risk: 'sensitive_read', timeoutMs: 1_000, maxAttempts: 3, validateInput: accept, execute: async () => ({ latitude: 41.59, longitude: -93.62 }) },
    'weather.read': evidence('sunny'), 'air.read': evidence('good'), 'pollen.read': evidence('tree high'), 'parks.read': evidence('two parks'),
    'assistant.synthesize': { risk: 'read', timeoutMs: 1_000, maxAttempts: 1, validateInput: accept, execute: async ({ dependencyOutputs }) => {
      assert.equal(Object.keys(dependencyOutputs).length, 4); return { recommendation: 'caution' };
    } },
    'calendar.preview': { risk: 'preview', timeoutMs: 1_000, maxAttempts: 1, validateInput: accept, execute: async () => ({ title: 'Family park visit', time: '17:00' }) },
    'calendar.commit': { risk: 'write', timeoutMs: 1_000, maxAttempts: 1, validateInput: accept, execute: async () => { commits++; return { saved: true }; } }
  };
  const orchestrator = new ConditionalTaskOrchestrator(registry, 4);
  const task = plan(); const state = await orchestrator.execute(task);
  assert.equal(state.status, 'waiting_confirmation'); assert.equal(state.nodes.commit.status, 'waiting_confirmation');
  assert.equal(commits, 0); assert.ok(peak >= 3, 'weather/AQI/pollen/places should overlap');
  const snapshot = orchestrator.snapshot(task, state);
  assert.equal(snapshot.nodes.location.output, undefined); assert.equal(state.nodes.location.output?.latitude, 41.59);
  const authorization = orchestrator.authorize(task, state, 'commit');
  const forged = { ...authorization, proof: '0'.repeat(64) };
  await orchestrator.execute(task, state, [forged]); assert.equal(state.status, 'waiting_confirmation'); assert.equal(commits, 0);
  await orchestrator.execute(task, state, [authorization]);
  assert.equal(state.status, 'completed'); assert.equal(commits, 1);
  await orchestrator.execute(task, state, [authorization]); assert.equal(commits, 1, 'completed writes cannot replay');
});

test('a false Calendar guard skips location and every conditional descendant', async () => {
  let externalCalls = 0;
  const never = { risk: 'read' as const, timeoutMs: 100, maxAttempts: 1, validateInput: accept, execute: async () => { externalCalls++; return {}; } };
  const registry: TaskToolRegistry = {
    'calendar.query': { risk: 'read', timeoutMs: 100, maxAttempts: 1, validateInput: accept, execute: async () => ({ hasEvents: true }) },
    'location.once': { ...never, risk: 'sensitive_read' }, 'weather.read': never, 'air.read': never, 'pollen.read': never, 'parks.read': never,
    'assistant.synthesize': never,
    'calendar.preview': { ...never, risk: 'preview' },
    'calendar.commit': { ...never, risk: 'write' }
  };
  const orchestrator = new ConditionalTaskOrchestrator(registry);
  const task = plan(true), state = await orchestrator.execute(task);
  assert.equal(state.status, 'completed'); assert.equal(externalCalls, 0);
  for (const id of task.nodes.slice(1).map(node => node.id)) assert.equal(state.nodes[id].status, 'skipped');
});

test('untrusted plans cannot add tools, cycles, free-form conditions or unpreviewed writes', () => {
  const registry: TaskToolRegistry = {
    read: { risk: 'read', timeoutMs: 100, maxAttempts: 2, validateInput: accept, execute: async () => ({ ok: true }) },
    preview: { risk: 'preview', timeoutMs: 100, maxAttempts: 1, validateInput: accept, execute: async () => ({ ok: true }) },
    write: { risk: 'write', timeoutMs: 100, maxAttempts: 1, validateInput: accept, execute: async () => ({ ok: true }) }
  };
  const orchestrator = new ConditionalTaskOrchestrator(registry);
  const base = { id: 'task-safe', version: 1, goal: 'test', nodes: [{ id: 'one', tool: 'read', dependsOn: [], condition: null, input: {} }] };
  assert.throws(() => orchestrator.validate({ ...base, nodes: [{ ...base.nodes[0], tool: 'shell' }] }), /TASK_NODE_INVALID/);
  assert.throws(() => orchestrator.validate({ ...base, nodes: [
    { id: 'one', tool: 'read', dependsOn: ['two'], condition: null, input: {} },
    { id: 'two', tool: 'read', dependsOn: ['one'], condition: null, input: {} }
  ] }), /TASK_DEPENDENCY_CYCLE/);
  assert.throws(() => orchestrator.validate({ ...base, nodes: [{ ...base.nodes[0], condition: { expression: 'process.exit()' } }] }), /TASK_CONDITION_INVALID/);
  assert.throws(() => orchestrator.validate({ ...base, nodes: [{ id: 'write', tool: 'write', dependsOn: [], condition: null, input: {} }] }), /TASK_WRITE_WITHOUT_PREVIEW/);
});

test('read failures retry within policy, while uncertain writes run once and fail closed', async () => {
  let reads = 0, writes = 0;
  const registry: TaskToolRegistry = {
    read: { risk: 'read', timeoutMs: 100, maxAttempts: 3, validateInput: accept, execute: async () => { if (++reads < 3) throw new Error('private'); return { ok: true }; } },
    preview: { risk: 'preview', timeoutMs: 100, maxAttempts: 1, validateInput: accept, execute: async () => ({ summary: 'safe preview' }) },
    write: { risk: 'write', timeoutMs: 100, maxAttempts: 1, validateInput: accept, execute: async () => { writes++; throw new Error('ambiguous network result'); } }
  };
  const task: TaskPlan = { id: 'task-retries', version: 1, goal: 'retry policy', nodes: [
    { id: 'read', tool: 'read', dependsOn: [], condition: null, input: {} },
    { id: 'preview', tool: 'preview', dependsOn: ['read'], condition: null, input: {} },
    { id: 'write', tool: 'write', dependsOn: ['preview'], condition: null, input: {} }
  ] };
  const orchestrator = new ConditionalTaskOrchestrator(registry), state = createTaskState(task);
  await orchestrator.execute(task, state); assert.equal(reads, 3); assert.equal(state.status, 'waiting_confirmation');
  const authorization = orchestrator.authorize(task, state, 'write');
  await orchestrator.execute(task, state, [authorization]);
  assert.equal(state.status, 'failed'); assert.equal(writes, 1); assert.equal(state.nodes.write.error, 'WRITE_RESULT_UNKNOWN');
});

test('cancelling an active read aborts it and prevents every downstream node', async () => {
  let aborted = false, downstream = 0;
  const registry: TaskToolRegistry = {
    slow: { risk: 'read', timeoutMs: 1_000, maxAttempts: 1, validateInput: accept, execute: async (_context, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        signal.addEventListener('abort', () => { clearTimeout(timer); aborted = true; reject(new Error('aborted')); }, { once: true });
      });
      return { ok: true };
    } },
    next: { risk: 'read', timeoutMs: 100, maxAttempts: 1, validateInput: accept, execute: async () => { downstream++; return {}; } }
  };
  const task: TaskPlan = { id: 'task-cancel', version: 1, goal: 'cancel safely', nodes: [
    { id: 'slow', tool: 'slow', dependsOn: [], condition: null, input: {} },
    { id: 'next', tool: 'next', dependsOn: ['slow'], condition: null, input: {} }
  ] };
  const orchestrator = new ConditionalTaskOrchestrator(registry), state = createTaskState(task);
  const running = orchestrator.execute(task, state); await delay(5); orchestrator.cancel(state); await running;
  assert.equal(state.status, 'cancelled'); assert.equal(aborted, true); assert.equal(downstream, 0);
});
