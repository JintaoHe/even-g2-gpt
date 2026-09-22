import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('actual browser lab clears private UI and stops private polling on guest transition', () => {
  const nodes = new Map<string, any>(), sent: any[] = [];
  function node() { return { value: '', textContent: '', children: [] as any[], hidden: false, open: false, disabled: false,
    dataset: {}, style: {}, append(...items: any[]) { this.children.push(...items); },
    replaceChildren() { this.children = []; this.textContent = ''; }, setAttribute() {}, scrollIntoView() {},
    closest() { return this; }, after() {}, reset() { this.value = ''; }, close() { this.open = false; } }; }
  const element = (id: string) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const context: any = { document: { getElementById: element, createElement: node, addEventListener() {} },
    window: { addEventListener() {} }, location: { protocol: 'http:', host: 'localhost', hostname: 'localhost' },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, URL, Intl, console,
    renderCitations() {}, isLoopbackHost: () => false,
    BrowserSessionClient: class { constructor(_options: any) {} resumeIfAvailable() { return false; }
      send(value: any) { sent.push(value); return true; } },
  };
  const load = (file: string) => readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replaceAll('export function ', 'function ');
  runInNewContext(`${load('progress.js')}\n${load('calendar.js')}\n${load('app.js')}\nglobalThis.receive = handleServerEvent;`, context);
  const ready = (guest: boolean) => context.receive({ type: 'ready', resumed: false, access_mode: guest ? 'guest' : 'owner',
    guest_mode_enabled: true, capabilities: { provider: 'api', email: !guest, calendar: !guest }, snapshot: { messages: [] } });
  ready(false);
  context.receive({ type: 'answer.start', id: 1 }); context.receive({ type: 'answer.delta', id: 1, text: 'OWNER_BODY' });
  context.receive({ type: 'jobs.list', jobs: [{ id: 'private-file', title: 'OWNER_TITLE', state: 'completed' }] });
  context.receive({ type: 'calendar.list', events: [{ id: 'event', event: { title: 'PRIVATE_CALENDAR', start: 'tomorrow', end: 'later' } }], operations: [] });
  assert.ok(element('history').children.length); assert.ok(element('jobs').children.length);
  element('token').value = 'private-token'; element('text').value = 'private-unsent';
  context.receive({ type: 'access.changed', mode: 'guest' });
  assert.equal(element('history').children.length, 0); assert.equal(element('jobs').children.length, 0);
  assert.equal(element('token').value, ''); assert.equal(element('text').value, '');
  assert.equal(element('googleCalendar').hidden, true);
  assert.equal(element('googleCalendar').children.at(-1).children.length, 0);
  const count = sent.length; ready(true);
  assert.equal(sent.length, count); assert.match(element('accessMode').textContent, /访客/);
  assert.equal(element('guestEnter').disabled, true);
});
