import { LiveTranscriber } from './live-transcriber.js';
import { SonioxTranscriber } from './soniox-transcriber.js';
import type { CostLedger, CostProvider, CostReservation } from './cost-ledger.js';
import type { ProviderMetricObserver } from './runtime-metrics.js';

export interface StreamingTranscriber {
  result: Promise<string>;
  push(pcm: Buffer): void;
  finish(): void;
  cancel(): void;
}

type Environment = Record<string, string | undefined>;
export type SttProviderName = 'soniox' | 'openai';

class MeteredTranscriber implements StreamingTranscriber {
  readonly result: Promise<string>;
  private inner?: StreamingTranscriber;
  private queued: Buffer[] = [];
  private bytes = 0;
  private finished = false;
  private cancelled = false;
  private ticket?: CostReservation;

  constructor(costs: CostLedger, provider: CostProvider, maximumUsd: number,
    private estimateCost: (bytes: number, text: string) => number, create: () => StreamingTranscriber,
    private observe?: ProviderMetricObserver) {
    const startedAt = Date.now();
    this.result = (async () => {
      this.ticket = await costs.reserve(provider, maximumUsd);
      if (this.cancelled) { await this.ticket.settle(0); throw new Error('Cancelled'); }
      this.inner = create();
      for (const chunk of this.queued) this.inner.push(chunk);
      this.queued = [];
      if (this.finished) this.inner.finish();
      try {
        const text = await this.inner.result;
        await this.ticket.settle(this.estimate(text));
        this.observe?.(provider, 'success', Date.now() - startedAt);
        return text;
      } catch (error) {
        await this.ticket.settle(this.estimate(''));
        this.observe?.(provider, this.cancelled || (error as Error)?.name === 'AbortError' ? 'cancelled' : 'failure', Date.now() - startedAt);
        throw error;
      }
    })();
  }
  private estimate(text: string) {
    return Math.min(this.ticket?.reservedUsd ?? Number.POSITIVE_INFINITY, this.estimateCost(this.bytes, text));
  }
  push(pcm: Buffer) {
    if (this.finished || this.cancelled) return;
    this.bytes += pcm.length;
    if (this.bytes > 65 * 32_000) { this.cancel(); return; }
    if (this.inner) this.inner.push(pcm); else this.queued.push(Buffer.from(pcm));
  }
  finish() { if (this.finished || this.cancelled) return; this.finished = true; this.inner?.finish(); }
  cancel() { if (this.cancelled) return; this.cancelled = true; this.queued = []; this.inner?.cancel(); }
}

export function createSttProvider(env: Environment = process.env, costs?: CostLedger, observe?: ProviderMetricObserver) {
  const requested = env.STT_PROVIDER?.trim().toLowerCase();
  if (requested && requested !== 'soniox' && requested !== 'openai') {
    throw new Error('STT_PROVIDER must be soniox or openai');
  }
  // Presence of a Soniox key intentionally changes the default for this
  // project. STT_PROVIDER=openai remains an explicit rollback switch.
  const name: SttProviderName = requested as SttProviderName || (env.SONIOX_API_KEY?.trim() ? 'soniox' : 'openai');
  const key = name === 'soniox' ? env.SONIOX_API_KEY?.trim() : env.OPENAI_API_KEY?.trim();
  const model = name === 'soniox'
    ? env.SONIOX_TRANSCRIBE_MODEL?.trim() || 'stt-rt-v5'
    : env.OPENAI_TRANSCRIBE_MODEL?.trim() || 'gpt-live-transcribe';
  const openaiPerMinute = Number(env.OPENAI_TRANSCRIBE_USD_PER_MINUTE ?? 0.017);
  if (!Number.isFinite(openaiPerMinute) || openaiPerMinute <= 0) throw new Error('OPENAI_TRANSCRIBE_USD_PER_MINUTE must be positive');
  return {
    name,
    model,
    configured: !!key,
    create(delta: (text: string) => void): StreamingTranscriber {
      if (!key) throw new Error(`Speech requires ${name === 'soniox' ? 'SONIOX_API_KEY' : 'OPENAI_API_KEY'}`);
      return name === 'soniox'
        ? costs ? new MeteredTranscriber(costs, 'soniox', 0.02, (bytes, text) => {
          const seconds = bytes / 32_000;
          const audio = (seconds / 3600 * 30_000) * 2 / 1_000_000;
          const output = (text.length * 0.3) * 4 / 1_000_000;
          return audio + output + 0.0002; // Small allowance for context-term input.
        }, () => new SonioxTranscriber(key, model, delta), observe)
          : new SonioxTranscriber(key, model, delta)
        : costs ? new MeteredTranscriber(costs, 'openai', 0.02,
          bytes => bytes / 32_000 / 60 * openaiPerMinute, () => new LiveTranscriber(key, model, delta), observe)
          : new LiveTranscriber(key, model, delta);
    }
  };
}
