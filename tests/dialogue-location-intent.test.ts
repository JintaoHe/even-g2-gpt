import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAIDialogue } from '../src/dialogue-model.js';

test('location intent schema supports nearby/recompare, defaults to drive, and keeps transit disabled', async () => {
  const bodies: any[] = [];
  const outputs = [
    { decision: 'respond', location_action: 'nearby_search', route_destination: '附近超市', route_origin: null,
      route_mode: 'drive', route_mode_explicit: false },
    { decision: 'respond', location_action: 'recompare', route_destination: null, route_origin: null,
      route_mode: 'walk', route_mode_explicit: true },
    { action: 'ask', selected_indices: [], question: '你指 Target 门店、Target Mobile，还是 Target 停车场？' }
  ];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(outputs.shift()) }] }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const model = new OpenAIDialogue('fake', 'test', `http://127.0.0.1:${(server.address() as any).port}`,
      false, 1, 'America/Chicago', undefined, { locationRouting: true });
    const signal = new AbortController().signal;
    const nearby = await model.plan([], '帮我找附近超市', false, signal);
    const walk = await model.plan([{ role: 'assistant', content: '两个候选地点' }], '那走路呢', false, signal);
    const clarification = await model.clarifyRoute!('Target', [
      { name: 'Target', primaryType: 'department_store' },
      { name: 'Target Mobile', primaryType: 'cell_phone_store' },
      { name: 'Target Parking', primaryType: 'parking_lot' }
    ], [{ role: 'user', content: '去 Target' }], signal);
    assert.equal(nearby.locationAction, 'nearby_search'); assert.equal(nearby.routeMode, 'drive'); assert.equal(nearby.routeModeExplicit, false);
    assert.equal(walk.locationAction, 'recompare'); assert.equal(walk.routeMode, 'walk'); assert.equal(walk.routeModeExplicit, true);
    const schema = bodies[0].text.format.schema.properties;
    assert.deepEqual(schema.location_action.enum, ['none', 'route_eta', 'nearby_search', 'recompare', 'cancel']);
    assert.deepEqual(schema.route_mode.enum, ['drive', 'walk', 'bicycle']); assert.equal(schema.route_mode_explicit.type, 'boolean');
    assert.match(bodies[0].instructions, /Default to drive/); assert.match(bodies[0].instructions, /Transit is not supported/);
    assert.match(bodies[0].instructions, /Never default to the first candidate/);
    assert.match(bodies[0].instructions, /Places search entity, not a summary/);
    assert.match(bodies[0].instructions, /stable physical venue and locality/);
    assert.match(schema.route_destination.description, /never request instructions/);
    assert.deepEqual(clarification, { action: 'ask', selectedIndices: [], question: '你指 Target 门店、Target Mobile，还是 Target 停车场？' });
    assert.equal(bodies[2].store, false); assert.equal(bodies[2].tools, undefined);
    assert.match(bodies[2].instructions, /untrusted data/); assert.doesNotMatch(bodies[2].input, /latitude|longitude/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('temporary-place resolver uses one quota-bound web search and returns only a public venue query', async () => {
  let body: any;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
    res.end(JSON.stringify({ status: 'completed', output: [
      { type: 'web_search_call', id: 'search-1', status: 'completed' },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ action: 'resolved',
        destination: 'DMACC Ankeny Campus, Ankeny, Iowa', question: null }) }] }
    ] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const model = new OpenAIDialogue('fake', 'test', `http://127.0.0.1:${(server.address() as any).port}`,
      true, 10, 'America/Chicago', undefined, { sessionSearchCalls: 50 });
    const updates: any[] = [];
    const result = await model.resolveRoute!('Hot Rods for Heroes car show, Ankeny', [
      { role: 'assistant', content: '活动位于 DMACC Ankeny Campus。' }
    ], new AbortController().signal, event => updates.push(event));
    assert.deepEqual(result, { action: 'resolved', destination: 'DMACC Ankeny Campus, Ankeny, Iowa' });
    assert.equal(body.max_tool_calls, 1); assert.equal(body.tool_choice, 'required');
    assert.deepEqual(body.tools, [{ type: 'web_search', search_context_size: 'low' }]);
    assert.equal(body.store, false); assert.doesNotMatch(body.input, /latitude|longitude/);
    assert.deepEqual(updates.map(value => value.status), ['searching', 'completed']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('public event discovery and hotel research cannot be misrouted to Calendar or current-location Maps', async () => {
  const bodies: any[] = [];
  const outputs = [
    { decision: 'respond', calendar_action: 'query', location_action: 'nearby_search',
      route_destination: 'weekend events', route_origin: null, route_mode: 'walk', route_mode_explicit: false },
    { decision: 'respond', calendar_action: 'none', location_action: 'nearby_search',
      route_destination: 'hotel near Navy Pier', route_origin: null, route_mode: 'drive', route_mode_explicit: false },
    { decision: 'respond', calendar_action: 'none', location_action: 'route_eta',
      route_destination: 'Des Moines Water Works Park', route_origin: null, route_mode: 'drive', route_mode_explicit: true },
    { decision: 'respond', calendar_action: 'query', location_action: 'none',
      route_destination: null, route_origin: null, route_mode: 'drive', route_mode_explicit: false }
  ];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; bodies.push(JSON.parse(raw));
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: JSON.stringify(outputs.shift()) }
    ] }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const model = new OpenAIDialogue('fake', 'test', `http://127.0.0.1:${(server.address() as any).port}`,
      false, 1, 'America/Chicago', undefined, { calendarRouting: true, locationRouting: true });
    const events = await model.plan([{ role: 'user', content: 'Chicago 行程取消了，我留在 Des Moines。' }],
      '帮我看看这周末 Des Moines downtown 有什么户外活动', false, new AbortController().signal);
    const hotel = await model.plan([{ role: 'assistant', content: '活动在 Navy Pier。' }],
      '在这个 event 旁边推荐一家酒店', false, new AbortController().signal);
    const route = await model.plan([{ role: 'assistant', content: '推荐 Des Moines Oktoberfest。' }],
      '从当前位置开车去刚才推荐的活动要多久', false, new AbortController().signal);
    const calendar = await model.plan([{ role: 'assistant', content: 'Des Moines 这周末有三个 public events。' }],
      '帮我看一下我的 calendar 明天有几个 event', false, new AbortController().signal);
    assert.equal(events.locationAction, 'none'); assert.equal(events.calendarAction, 'none');
    assert.equal(hotel.locationAction, 'none');
    assert.equal(route.locationAction, 'route_eta'); assert.equal(route.routeMode, 'drive');
    assert.equal(calendar.calendarAction, 'query');
    assert.match(bodies[0].instructions, /Public activity discovery/);
    assert.match(bodies[0].instructions, /Public\/community activity discovery/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('trip itinerary planning cannot be mistaken for Calendar, while explicit Calendar requests remain routed', async () => {
  const bodies: any[] = [];
  const outputs = [
    { decision: 'respond', reasoning_effort: 'medium', cognitive_mode: 'planning', topic_action: 'continue', topic_target: null,
      topic_label: 'Charlotte trip', calendar_action: 'query' },
    { decision: 'respond', reasoning_effort: 'low', cognitive_mode: 'planning', topic_action: 'continue', topic_target: null,
      topic_label: 'conference calendar', calendar_action: 'create' },
    { decision: 'respond', reasoning_effort: 'low', cognitive_mode: 'explain', topic_action: 'continue', topic_target: null,
      topic_label: 'tomorrow calendar', calendar_action: 'query' }
  ];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; bodies.push(JSON.parse(raw));
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: JSON.stringify(outputs.shift()) }
    ] }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const model = new OpenAIDialogue('fake', 'test', `http://127.0.0.1:${(server.address() as any).port}`,
      false, 1, 'America/Chicago', undefined, { calendarRouting: true, adaptiveReasoning: true });
    const signal = new AbortController().signal;
    const itinerary = await model.plan([], 'conference 在 Spectrum Center，朋友住 Wheatgrass，我该怎么安排住宿和拜访行程？', false, signal);
    const create = await model.plan([], '帮我把周五下午三点的 conference 加到 calendar', false, signal);
    const query = await model.plan([], '帮我看一下我明天的安排', false, signal);
    assert.equal(itinerary.calendarAction, 'none'); assert.equal(itinerary.assistantMode, 'planning');
    assert.equal(create.calendarAction, 'create'); assert.equal(create.cognitiveMode, 'planning');
    assert.equal(query.calendarAction, 'query'); assert.equal(query.cognitiveMode, 'explain');
    assert.match(bodies[0].instructions, /Trip\/itinerary planning is NOT a Calendar operation/);
    assert.match(bodies[0].instructions, /business implementation and go-to-market planning/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
