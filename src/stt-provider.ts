import { LiveTranscriber } from './live-transcriber.js';
import { SonioxTranscriber } from './soniox-transcriber.js';

export interface StreamingTranscriber {
  result: Promise<string>;
  push(pcm: Buffer): void;
  finish(): void;
  cancel(): void;
}

type Environment = Record<string, string | undefined>;
export type SttProviderName = 'soniox' | 'openai';

export function createSttProvider(env: Environment = process.env) {
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
  return {
    name,
    model,
    configured: !!key,
    create(delta: (text: string) => void): StreamingTranscriber {
      if (!key) throw new Error(`Speech requires ${name === 'soniox' ? 'SONIOX_API_KEY' : 'OPENAI_API_KEY'}`);
      return name === 'soniox'
        ? new SonioxTranscriber(key, model, delta)
        : new LiveTranscriber(key, model, delta);
    }
  };
}
