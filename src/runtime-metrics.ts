import type { CostSnapshot } from './cost-ledger.js';
import type { Event } from './conversation.js';

export type ProviderMetricName = 'openai' | 'soniox' | 'google';
export type ProviderMetricOutcome = 'success' | 'failure' | 'cancelled';
export type ProviderMetricObserver = (provider: ProviderMetricName, outcome: ProviderMetricOutcome,
  durationMs: number) => void;

type Distribution = { count: number; p50_ms: number | null; p95_ms: number | null; max_ms: number | null };
type ProviderBucket = { successes: number; failures: number; cancelled: number; durations: number[] };
type PendingTurn = { startedAt: number; firstVisibleAt?: number };

const SAMPLE_LIMIT = 2_048;
const boundedDuration = (value: number) => Number.isFinite(value) && value >= 0
  ? Math.min(Math.round(value), 24 * 60 * 60 * 1_000) : 0;
const retain = (values: number[], value: number) => {
  values.push(boundedDuration(value));
  if (values.length > SAMPLE_LIMIT) values.splice(0, values.length - SAMPLE_LIMIT);
};
const percentile = (values: number[], fraction: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};
const distribution = (values: number[]): Distribution => ({
  count: values.length,
  p50_ms: percentile(values, 0.5),
  p95_ms: percentile(values, 0.95),
  max_ms: values.length ? Math.max(...values) : null,
});

/**
 * Metadata-only runtime telemetry. It never receives message text, coordinates,
 * provider payloads, credentials or provider error prose.
 */
export class RuntimeMetrics {
  private readonly startedAt = Date.now();
  private readonly providers: Record<ProviderMetricName, ProviderBucket> = {
    openai: { successes: 0, failures: 0, cancelled: 0, durations: [] },
    soniox: { successes: 0, failures: 0, cancelled: 0, durations: [] },
    google: { successes: 0, failures: 0, cancelled: 0, durations: [] },
  };
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly firstVisible: number[] = [];
  private readonly completed: number[] = [];
  private turnsStarted = 0;
  private turnsCompleted = 0;
  private turnsFailed = 0;
  private turnsCancelled = 0;

  constructor(private readonly now: () => number = Date.now) {}

  readonly observeProvider: ProviderMetricObserver = (provider, outcome, durationMs) => {
    const bucket = this.providers[provider];
    if (outcome === 'success') bucket.successes++;
    else if (outcome === 'failure') bucket.failures++;
    else bucket.cancelled++;
    retain(bucket.durations, durationMs);
  };

  beginTurn(sessionId: string) {
    if (!sessionId || this.pendingTurns.has(sessionId)) return;
    this.pendingTurns.set(sessionId, { startedAt: this.now() });
    this.turnsStarted++;
  }

  observeConversationEvent(sessionId: string, event: Event) {
    const pending = this.pendingTurns.get(sessionId);
    if (!pending) return;
    const now = this.now();
    if (!pending.firstVisibleAt && ((event.type === 'answer.delta' && String(event.text ?? '').length > 0)
      || event.type === 'answer.citations')) {
      pending.firstVisibleAt = now;
      retain(this.firstVisible, now - pending.startedAt);
    }
    if (event.type === 'answer.done') {
      retain(this.completed, now - pending.startedAt);
      this.turnsCompleted++;
      this.pendingTurns.delete(sessionId);
    } else if (event.type === 'answer.cancelled') {
      this.turnsCancelled++;
      this.pendingTurns.delete(sessionId);
    } else if (event.type === 'error' && ['MODEL_FAILED', 'SAVE_FAILED'].includes(String(event.code))) {
      this.turnsFailed++;
      this.pendingTurns.delete(sessionId);
    } else if (event.type === 'turn.waiting') {
      this.pendingTurns.delete(sessionId);
    } else if (event.type === 'exit.confirmation_required' || (event.type === 'state'
      && ['paused', 'closed'].includes(String(event.state)))) {
      this.pendingTurns.delete(sessionId);
    }
  }

  async snapshot(input: {
    connections: { authenticated: number; unauthenticated: number; total: number };
    costs?: () => Promise<CostSnapshot>;
  }) {
    const memory = process.memoryUsage(), cpu = process.cpuUsage();
    const providers = Object.fromEntries((Object.entries(this.providers) as [ProviderMetricName, ProviderBucket][])
      .map(([name, bucket]) => {
        const decided = bucket.successes + bucket.failures;
        return [name, {
          attempts: decided + bucket.cancelled,
          successes: bucket.successes,
          failures: bucket.failures,
          cancelled: bucket.cancelled,
          error_rate: decided ? bucket.failures / decided : 0,
          latency: distribution(bucket.durations),
        }];
      }));
    return {
      status: 'ok',
      generated_at: new Date(this.now()).toISOString(),
      process: {
        uptime_seconds: Math.max(0, Math.round((this.now() - this.startedAt) / 1_000)),
        rss_bytes: memory.rss,
        heap_used_bytes: memory.heapUsed,
        heap_total_bytes: memory.heapTotal,
        external_bytes: memory.external,
        cpu_user_micros: cpu.user,
        cpu_system_micros: cpu.system,
      },
      connections: { ...input.connections },
      turns: {
        started: this.turnsStarted,
        completed: this.turnsCompleted,
        failed: this.turnsFailed,
        cancelled: this.turnsCancelled,
        in_flight: this.pendingTurns.size,
        first_visible: distribution(this.firstVisible),
        complete: distribution(this.completed),
      },
      providers,
      ...(input.costs ? { costs: await input.costs() } : {}),
    };
  }
}
