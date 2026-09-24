import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function fixture() {
  const nodes = new Map<string, any>();
  function node() { return { value: '', textContent: '', children: [] as any[], hidden: false, open: false, disabled: false,
    dataset: {}, style: {}, append(...items: any[]) { this.children.push(...items); },
    replaceChildren() { this.children = []; this.textContent = ''; }, setAttribute() {}, scrollIntoView() {},
    closest() { return this; }, after() {}, reset() { this.value = ''; }, close() { this.open = false; } }; }
  const element = (id: string) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const context: any = { document: { getElementById: element, createElement: node, addEventListener() {} },
    window: { addEventListener() {} }, location: { protocol: 'http:', host: 'localhost', hostname: 'localhost' },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, URL, Intl, console,
    renderCitations() {}, isLoopbackHost: () => false,
    BrowserSessionClient: class { resumeIfAvailable() { return false; } send() { return true; } },
  };
  const load = (file: string) => readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replaceAll('export function ', 'function ');
  runInNewContext(`${load('progress.js')}\n${load('calendar.js')}\n${load('app.js')}
    globalThis.stops=0; stopMic=()=>{globalThis.stops++}; globalThis.receive=handleServerEvent;`, context);
  const ready = (boundary: string | undefined, session = 'session-A') => context.receive({ type: 'ready', resumed: true,
    session_id: session, ...(boundary === undefined ? {} : { memory_boundary: boundary }), snapshot: { messages: [] }, capabilities: {} });
  const answer = (id: number) => { context.receive({ type: 'answer.start', id }); context.receive({ type: 'answer.delta', id, text: 'synthetic visible text' }); };
  ready('A'); answer(1); return { context, element, ready, answer };
}
test('actual web handler replaces old view and displays reset prompt after offline boundary change', () => {
  const { context: c, element, ready } = fixture(); assert.ok(element('history').children.length);
  element('text').value = 'old text'; ready('B');
  assert.equal(element('history').children.length, 0); assert.equal(element('text').value, ''); assert.equal(c.stops, 1);
  assert.match(element('notice').textContent, /上下文已更新/);
});
test('actual web handler retains old view on unchanged boundary', () => {
  const { context: c, element, ready } = fixture(); ready('A');
  assert.ok(element('history').children.length); assert.equal(c.stops, 0);
});
test('actual web handler does not clear new messages again after online reset', () => {
  const { context: c, element, ready, answer } = fixture();
  c.receive({ type: 'notice', code: 'MEMORY_CONTEXT_RESET', memory_boundary: 'B', text: '上下文已更新' });
  answer(2); ready('B'); assert.ok(element('history').children.length); assert.equal(c.stops, 1);
});
test('actual web handler preserves missing-field compatibility and does not compare different sessions', () => {
  const { context: c, element, ready } = fixture(); ready(undefined); ready('B', 'session-B');
  assert.ok(element('history').children.length); assert.equal(c.stops, 0);
});
