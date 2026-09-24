import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ReadingHistory } from '../src/reading-history.ts';

function fixture() {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(s => ts.isFunctionDeclaration(s)
    && ['resetMemoryView', 'handleServerEvent'].includes(s.name?.text ?? '')).map(s => s.getText(ast)).join('\n');
  const nodes = new Map<string, any>();
  const reading = new ReadingHistory();
  const context: any = {
    hasReady: false, memorySessionId: undefined, memoryBoundary: undefined,
    memoryResetText: '本次对话的上下文已更新，请重新提出需要继续的问题。',
    accessMode: 'owner', answerId: undefined, last: '', status: '', connected: false, speech: false,
    locationAvailable: false, channel: '', state: 'listening', developmentSessionControls: undefined,
    stopAudio: () => { context.stops++; }, locationController: { stop: () => { context.locations++; } },
    stops: 0, locations: 0, resets: 0, replacements: [] as boolean[],
    element: (id: string) => { if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', disabled: false }); return nodes.get(id); },
    reading,
    pager: { reset: (text: string) => { context.resets++; reading.reset(text); },
      restoreSnapshot: (m: any[], replace: boolean) => { context.replacements.push(replace); reading.restoreSnapshot(m, replace); },
      notice: (text: string) => reading.notice(text), event: (event: any) => reading.event(event) },
    connection: { status: { reason: 'reconnecting' }, send() {} }, refresh() {},
  };
  runInNewContext(ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    + '\nglobalThis.receive=handleServerEvent;', context);
  const ready = (boundary: string | undefined, session = 'session-A') => context.receive({ type: 'ready', resumed: true,
    session_id: session, ...(boundary === undefined ? {} : { memory_boundary: boundary }), snapshot: { messages: [] }, capabilities: {} });
  ready('A'); context.replacements.length = 0;
  return { context, ready };
}

test('actual Even handler replaces pager, stops audio/location and shows prompt on boundary change', () => {
  const { context: c, ready } = fixture(); ready('B');
  assert.deepEqual(c.replacements, [true]); assert.equal(c.resets, 1); assert.equal(c.stops, 1); assert.equal(c.locations, 1);
  assert.equal(c.reading.entries.at(-1).raw, c.memoryResetText); assert.equal(c.status, c.memoryResetText);
});
test('actual Even handler merges on the same boundary', () => {
  const { context: c, ready } = fixture(); ready('A'); assert.deepEqual(c.replacements, [false]); assert.equal(c.resets, 0);
});
test('actual Even handler remembers online reset version and does not reset twice', () => {
  const { context: c, ready } = fixture();
  c.receive({ type: 'notice', code: 'MEMORY_CONTEXT_RESET', memory_boundary: 'B', text: c.memoryResetText }); ready('B');
  assert.equal(c.resets, 1); assert.equal(c.stops, 1); assert.deepEqual(c.replacements, [false]);
});
test('actual Even handler preserves legacy merge and does not compare versions across sessions', () => {
  const { context: c, ready } = fixture(); ready(undefined); ready('B', 'session-B');
  assert.equal(c.resets, 0); assert.deepEqual(c.replacements, [false, false]);
});
