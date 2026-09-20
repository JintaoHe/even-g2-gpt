export type ClientAudioState = 'off' | 'starting' | 'streaming' | 'unavailable';

type AudioBridge = { audioControl(enabled: boolean): Promise<boolean> };
type AudioControllerOptions = {
  bridge: AudioBridge;
  retryDelay?: (attempt: number) => Promise<void>;
  onState?: (state: ClientAudioState, desired: boolean) => void;
  onUnavailable?: () => void;
  attempts?: number;
};

/** Keeps user intent independent from transient SDK/backend/device state. All
 * bridge operations are serialized; an epoch invalidates late open results. */
export class AudioController {
  private readonly bridge: AudioBridge;
  private readonly retryDelay: (attempt: number) => Promise<void>;
  private readonly onState?: (state: ClientAudioState, desired: boolean) => void;
  private readonly onUnavailable?: () => void;
  private readonly attempts: number;
  private queue: Promise<void> = Promise.resolve();
  private epoch = 0;
  private backendAvailable = false;
  private deviceAvailable = true;
  private visible = true;
  private disposed = false;
  private desiredValue = false;
  private stateValue: ClientAudioState = 'off';

  constructor(options: AudioControllerOptions) {
    this.bridge = options.bridge;
    this.retryDelay = options.retryDelay ?? (attempt => new Promise(resolve => setTimeout(resolve, 200 * attempt)));
    this.onState = options.onState;
    this.onUnavailable = options.onUnavailable;
    this.attempts = Math.min(3, Math.max(1, options.attempts ?? 3));
  }

  get desired() { return this.desiredValue; }
  get state() { return this.stateValue; }
  get streaming() { return this.stateValue === 'streaming'; }

  setDesired(desired: boolean) {
    if (this.disposed) return Promise.resolve();
    this.desiredValue = desired;
    this.epoch++;
    return this.enqueue(() => this.reconcile(this.epoch));
  }

  toggle() { return this.setDesired(!this.desiredValue); }

  setBackendAvailable(available: boolean) {
    if (this.disposed || this.backendAvailable === available) return Promise.resolve();
    this.backendAvailable = available;
    this.epoch++;
    return this.enqueue(() => this.reconcile(this.epoch));
  }

  setDeviceAvailable(available: boolean) {
    if (this.disposed || this.deviceAvailable === available) return Promise.resolve();
    this.deviceAvailable = available;
    this.epoch++;
    return this.enqueue(() => this.reconcile(this.epoch));
  }

  setVisible(visible: boolean) {
    if (this.disposed || this.visible === visible) return Promise.resolve();
    this.visible = visible;
    this.epoch++;
    return this.enqueue(() => this.reconcile(this.epoch));
  }

  private available() {
    return !this.disposed && this.desiredValue && this.backendAvailable && this.deviceAvailable && this.visible;
  }

  private publish(state: ClientAudioState) {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.onState?.(state, this.desiredValue);
  }

  private enqueue(operation: () => Promise<void>) {
    const job = this.queue.then(operation, operation);
    this.queue = job.catch(() => {});
    return job;
  }

  private async reconcile(epoch: number) {
    if (!this.available()) {
      if (this.stateValue !== 'off') await this.bridge.audioControl(false).catch(() => false);
      this.publish('off');
      return;
    }
    if (this.stateValue === 'streaming') return;
    this.publish('starting');
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      let opened = false;
      try { opened = await this.bridge.audioControl(true); } catch { opened = false; }
      if (epoch !== this.epoch || !this.available()) {
        if (opened) await this.bridge.audioControl(false).catch(() => false);
        this.publish('off');
        return;
      }
      if (opened) { this.publish('streaming'); return; }
      if (attempt < this.attempts) {
        await this.retryDelay(attempt);
        if (epoch !== this.epoch || !this.available()) { this.publish('off'); return; }
      }
    }
    this.publish('unavailable');
    this.onUnavailable?.();
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.desiredValue = false;
    this.epoch++;
    await this.enqueue(async () => {
      await this.bridge.audioControl(false).catch(() => false);
      this.publish('off');
    });
  }
}
