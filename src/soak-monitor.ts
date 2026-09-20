import { appendFile, chmod, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Fetch = typeof fetch;
type ProviderName = 'openai' | 'soniox' | 'google';
type SoakSample = {
  at: string;
  status: 'ok' | 'unavailable';
  process?: { uptime_seconds: number; rss_bytes: number; heap_used_bytes: number; cpu_user_micros: number; cpu_system_micros: number };
  sqlite_bytes?: number;
  storage?: { database_bytes: number; sessions: number; messages: number; warnings: string[] };
  connections?: { authenticated: number; unauthenticated: number; total: number };
  turns?: Record<string, unknown>;
  providers?: Record<ProviderName, Record<string, unknown>>;
  costs?: Record<string, unknown>;
};

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const integer = (value: unknown) => Math.round(finite(value));
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : {};
const localUrl = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('Soak monitor endpoint must be loopback HTTP');
  }
  return url;
};
const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function json(fetcher: Fetch, url: URL) {
  const response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('HEALTH_UNAVAILABLE'); }
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 512 * 1024) throw new Error('HEALTH_INVALID');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('HEALTH_INVALID');
  return parsed as Record<string, any>;
}

export async function sqliteBytes(directory: string) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !/\.sqlite(?:-(?:wal|shm))?$/.test(entry.name)) continue;
    total += (await stat(join(directory, entry.name))).size;
  }
  return total;
}

function sanitizeProvider(value: unknown) {
  const input = object(value), latency = object(input.latency);
  return { attempts: integer(input.attempts), successes: integer(input.successes), failures: integer(input.failures),
    cancelled: integer(input.cancelled), error_rate: finite(input.error_rate),
    latency: { count: integer(latency.count), p50_ms: latency.p50_ms === null ? null : integer(latency.p50_ms),
      p95_ms: latency.p95_ms === null ? null : integer(latency.p95_ms), max_ms: latency.max_ms === null ? null : integer(latency.max_ms) } };
}

export function sanitizeSoakSample(runtimeValue: unknown, storageValue: unknown, databaseBytes: number,
  at = new Date().toISOString()): SoakSample {
  const runtime = object(runtimeValue), processInfo = object(runtime.process), connections = object(runtime.connections);
  const turns = object(runtime.turns), storage = object(storageValue), providers = object(runtime.providers), costs = object(runtime.costs);
  const providerUsd = object(costs.providerUsd), limitsUsd = object(costs.limitsUsd), googleUnits = object(costs.googleUnits);
  const safeTurns = (key: 'first_visible' | 'complete') => {
    const value = object(turns[key]);
    return { count: integer(value.count), p50_ms: value.p50_ms === null ? null : integer(value.p50_ms),
      p95_ms: value.p95_ms === null ? null : integer(value.p95_ms), max_ms: value.max_ms === null ? null : integer(value.max_ms) };
  };
  const safeGoogleUnits = Object.fromEntries(Object.entries(googleUnits)
    .filter(([key]) => /^[a-z0-9-]{1,64}$/.test(key)).map(([key, value]) => [key, integer(value)]));
  return {
    at, status: 'ok',
    process: { uptime_seconds: integer(processInfo.uptime_seconds), rss_bytes: integer(processInfo.rss_bytes),
      heap_used_bytes: integer(processInfo.heap_used_bytes), cpu_user_micros: integer(processInfo.cpu_user_micros),
      cpu_system_micros: integer(processInfo.cpu_system_micros) },
    sqlite_bytes: integer(databaseBytes),
    storage: { database_bytes: integer(storage.database_bytes), sessions: integer(storage.sessions), messages: integer(storage.messages),
      warnings: Array.isArray(storage.warnings) ? storage.warnings.filter((item: unknown) => typeof item === 'string' && /^[a-z0-9_]{1,64}$/.test(item)).slice(0, 20) : [] },
    connections: { authenticated: integer(connections.authenticated), unauthenticated: integer(connections.unauthenticated),
      total: integer(connections.total) },
    turns: { started: integer(turns.started), completed: integer(turns.completed), failed: integer(turns.failed),
      cancelled: integer(turns.cancelled), in_flight: integer(turns.in_flight),
      first_visible: safeTurns('first_visible'), complete: safeTurns('complete') },
    providers: { openai: sanitizeProvider(providers.openai), soniox: sanitizeProvider(providers.soniox),
      google: sanitizeProvider(providers.google) },
    costs: { period: typeof costs.period === 'string' && /^\d{4}-\d{2}$/.test(costs.period) ? costs.period : '',
      provider_usd: { openai: finite(providerUsd.openai), soniox: finite(providerUsd.soniox), google: finite(providerUsd.google) },
      total_usd: finite(costs.totalUsd), limits_usd: { openai: finite(limitsUsd.openai), soniox: finite(limitsUsd.soniox),
        google: finite(limitsUsd.google), total: finite(limitsUsd.total) }, google_units: safeGoogleUnits },
  };
}

const maximum = (samples: SoakSample[], read: (sample: SoakSample) => number | undefined) => {
  const values = samples.map(read).filter((value): value is number => value !== undefined);
  return values.length ? Math.max(...values) : null;
};

export function summarizeSoak(samples: SoakSample[], startedAt: string, endedAt: string) {
  const healthy = samples.filter(sample => sample.status === 'ok'), first = healthy[0], last = healthy.at(-1);
  let restarts = 0;
  for (let index = 1; index < healthy.length; index++) {
    if ((healthy[index].process?.uptime_seconds ?? 0) < (healthy[index - 1].process?.uptime_seconds ?? 0)) restarts++;
  }
  const startCpu = (first?.process?.cpu_user_micros ?? 0) + (first?.process?.cpu_system_micros ?? 0);
  const endCpu = (last?.process?.cpu_user_micros ?? 0) + (last?.process?.cpu_system_micros ?? 0);
  const elapsedMicros = Math.max(1, Date.parse(endedAt) - Date.parse(startedAt)) * 1_000;
  const firstCost = finite(object(first?.costs).total_usd), lastCost = finite(object(last?.costs).total_usd);
  const providerDelta = (name: ProviderName) => {
    if (!first || !last || restarts) return null;
    const before = object(first.providers?.[name]), after = object(last.providers?.[name]);
    const attempts = Math.max(0, integer(after.attempts) - integer(before.attempts));
    const failures = Math.max(0, integer(after.failures) - integer(before.failures));
    const cancelled = Math.max(0, integer(after.cancelled) - integer(before.cancelled));
    const decided = Math.max(0, attempts - cancelled);
    return { attempts, failures, cancelled, error_rate: decided ? failures / decided : 0 };
  };
  return {
    version: 1, started_at: startedAt, ended_at: endedAt, samples: samples.length,
    successful_samples: healthy.length, failed_samples: samples.length - healthy.length, detected_process_restarts: restarts,
    resources: { rss_start_bytes: first?.process?.rss_bytes ?? null, rss_end_bytes: last?.process?.rss_bytes ?? null,
      rss_max_bytes: maximum(healthy, sample => sample.process?.rss_bytes),
      heap_max_bytes: maximum(healthy, sample => sample.process?.heap_used_bytes),
      sqlite_start_bytes: first?.sqlite_bytes ?? null, sqlite_end_bytes: last?.sqlite_bytes ?? null,
      sqlite_max_bytes: maximum(healthy, sample => sample.sqlite_bytes),
      cpu_average_percent: restarts || !first || !last ? null : Math.max(0, (endCpu - startCpu) / elapsedMicros * 100),
      socket_max: maximum(healthy, sample => sample.connections?.total) },
    storage: { sessions_start: first?.storage?.sessions ?? null, sessions_end: last?.storage?.sessions ?? null,
      messages_start: first?.storage?.messages ?? null, messages_end: last?.storage?.messages ?? null,
      warnings_at_end: last?.storage?.warnings ?? [] },
    turns: last?.turns ?? null,
    providers: last?.providers ? {
      latest_cumulative: last.providers,
      soak_delta: { openai: providerDelta('openai'), soniox: providerDelta('soniox'), google: providerDelta('google') },
      latency_note: 'Latency distributions are bounded cumulative process metrics; a detected restart invalidates one-run deltas.',
    } : null,
    cost: { start_usd: first ? firstCost : null, end_usd: last ? lastCost : null,
      delta_usd: first && last ? Math.max(0, lastCost - firstCost) : null, latest: last?.costs ?? null },
  };
}

export async function runSoakMonitor(options: {
  durationMs: number; intervalMs: number; outputDirectory: string; dataDirectory: string;
  runtimeUrl?: string; storageUrl?: string; fetcher?: Fetch; sleep?: (ms: number) => Promise<unknown>;
}) {
  if (!Number.isFinite(options.durationMs) || options.durationMs < 1 || !Number.isFinite(options.intervalMs) || options.intervalMs < 1) {
    throw new Error('Invalid soak duration or interval');
  }
  const fetcher = options.fetcher ?? fetch, sleep = options.sleep ?? delay;
  const runtimeUrl = localUrl(options.runtimeUrl ?? 'http://127.0.0.1:3001/internal/health/runtime');
  const storageUrl = localUrl(options.storageUrl ?? 'http://127.0.0.1:3001/internal/health/storage');
  await mkdir(options.outputDirectory, { recursive: true, mode: 0o700 });
  try { await chmod(options.outputDirectory, 0o700); } catch { /* Windows does not enforce POSIX modes. */ }
  const started = new Date(), stamp = started.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  const reportPath = join(options.outputDirectory, `soak-${stamp}.jsonl`);
  const summaryPath = join(options.outputDirectory, `soak-${stamp}-summary.json`);
  const samples: SoakSample[] = [];
  const deadline = Date.now() + options.durationMs;
  do {
    let sample: SoakSample;
    try {
      const [runtime, storage, databases] = await Promise.all([
        json(fetcher, runtimeUrl), json(fetcher, storageUrl), sqliteBytes(options.dataDirectory),
      ]);
      sample = sanitizeSoakSample(runtime, storage, databases);
    } catch { sample = { at: new Date().toISOString(), status: 'unavailable' }; }
    samples.push(sample);
    await appendFile(reportPath, `${JSON.stringify(sample)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (Date.now() >= deadline) break;
    await sleep(Math.min(options.intervalMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  try { await chmod(reportPath, 0o600); } catch { /* Windows does not enforce POSIX modes. */ }
  const summary = summarizeSoak(samples, started.toISOString(), new Date().toISOString());
  const temporary = `${summaryPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, summaryPath);
  try { await chmod(summaryPath, 0o600); } catch { /* Windows does not enforce POSIX modes. */ }
  if (!summary.successful_samples) throw new Error('SOAK_NO_SUCCESSFUL_SAMPLES');
  return { reportPath, summaryPath, summary };
}

function commandLine(argv: string[], env: NodeJS.ProcessEnv) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Use --duration-hours, --interval-seconds and --output-dir');
    values.set(key, value);
  }
  const hours = Number(values.get('--duration-hours') ?? '12'), intervalSeconds = Number(values.get('--interval-seconds') ?? '60');
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new Error('duration-hours must be an integer from 1 to 24');
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 3_600) throw new Error('interval-seconds must be 10–3600');
  const dataDirectory = resolve(env.EVEN_DATA_DIR ?? '.local');
  const outputDirectory = resolve(values.get('--output-dir') ?? join(dataDirectory, 'soak'));
  const inside = relative(dataDirectory, outputDirectory);
  if (inside.startsWith('..') || resolve(dataDirectory, inside) !== outputDirectory) throw new Error('output-dir must stay inside EVEN_DATA_DIR');
  return { durationMs: hours * 60 * 60_000, intervalMs: intervalSeconds * 1_000, dataDirectory, outputDirectory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runSoakMonitor(commandLine(process.argv.slice(2), process.env));
    console.log(JSON.stringify({ event: 'soak_complete', report: basename(result.reportPath),
      summary: basename(result.summaryPath), successful_samples: result.summary.successful_samples,
      failed_samples: result.summary.failed_samples }));
  } catch {
    console.error(JSON.stringify({ event: 'soak_failed', code: 'SOAK_MONITOR_FAILED' }));
    process.exitCode = 1;
  }
}
