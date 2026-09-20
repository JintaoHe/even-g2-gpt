import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runSoakMonitor, sanitizeSoakSample, sqliteBytes, summarizeSoak } from '../src/soak-monitor.js';

const runtime = {
  process: { uptime_seconds: 10, rss_bytes: 100, heap_used_bytes: 50, cpu_user_micros: 10, cpu_system_micros: 5 },
  connections: { authenticated: 1, unauthenticated: 0, total: 1 },
  turns: { started: 2, completed: 1, failed: 0, cancelled: 0, in_flight: 1,
    first_visible: { count: 1, p50_ms: 20, p95_ms: 20, max_ms: 20 },
    complete: { count: 1, p50_ms: 40, p95_ms: 40, max_ms: 40 } },
  providers: { openai: { attempts: 2, successes: 1, failures: 1, cancelled: 0, error_rate: 0.5,
    latency: { count: 2, p50_ms: 10, p95_ms: 30, max_ms: 30 } }, soniox: {}, google: {} },
  costs: { period: '2026-09', providerUsd: { openai: 1, soniox: 2, google: 3 }, totalUsd: 6,
    limitsUsd: { openai: 50, soniox: 20, google: 10, total: 80 }, googleUnits: { weather: 4 } },
};
const storage = { database_bytes: 70, sessions: 3, messages: 9, warnings: [] };

test('soak sample strips unknown text and summary detects bounded growth', () => {
  const sample = sanitizeSoakSample({ ...runtime, private: 'conversation body' }, { ...storage, content: 'secret' }, 80,
    '2026-09-20T00:00:00.000Z');
  const later = sanitizeSoakSample({ ...runtime,
    process: { ...runtime.process, uptime_seconds: 20, rss_bytes: 150, cpu_user_micros: 30 },
    costs: { ...runtime.costs, totalUsd: 6.25 } }, { ...storage, messages: 12 }, 100, '2026-09-20T00:01:00.000Z');
  const summary = summarizeSoak([sample, later], sample.at, later.at);
  assert.equal(summary.resources.rss_max_bytes, 150); assert.equal(summary.resources.sqlite_end_bytes, 100);
  assert.equal(summary.storage.messages_end, 12); assert.equal(summary.cost.delta_usd, 0.25);
  assert.deepEqual(summary.providers?.soak_delta.openai, { attempts: 0, failures: 0, cancelled: 0, error_rate: 0 });
  assert.doesNotMatch(JSON.stringify([sample, summary]), /conversation body|secret/);
});

test('soak monitor writes owner-private metadata reports and counts all SQLite sidecars', async () => {
  const root = await mkdtemp(join(tmpdir(), 'even-soak-')), output = join(root, 'soak');
  await writeFile(join(root, 'assistant-memory.sqlite'), '1234'); await writeFile(join(root, 'assistant-memory.sqlite-wal'), '12');
  await writeFile(join(root, 'ignore.txt'), 'private words');
  assert.equal(await sqliteBytes(root), 6);
  let calls = 0;
  const fetcher: typeof fetch = async input => {
    calls++;
    return new Response(JSON.stringify(String(input).includes('/runtime') ? runtime : storage), { status: 200 });
  };
  const result = await runSoakMonitor({ durationMs: 1, intervalMs: 1, outputDirectory: output, dataDirectory: root,
    fetcher, sleep: async () => {} });
  assert.ok(calls >= 2); assert.equal(result.summary.successful_samples, 1);
  const report = await readFile(result.reportPath, 'utf8'), summary = await readFile(result.summaryPath, 'utf8');
  assert.match(report, /"sqlite_bytes":6/); assert.doesNotMatch(report + summary, /private words|api.key|token/i);
});
