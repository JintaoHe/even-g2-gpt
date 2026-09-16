/** Tracks cancellable work so shutdown waits for actual child completion. */
export class WorkSupervisor {
  private closing = false;
  private work = new Map<AbortController, Promise<unknown>>();
  run<T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Service stopping'));
    if (this.work.size >= 4) return Promise.reject(new Error('CLI concurrency limit'));
    const controller = new AbortController();
    const result = Promise.resolve().then(() => fn(AbortSignal.any([signal, controller.signal])));
    this.work.set(controller, result);
    void result.finally(() => this.work.delete(controller)).catch(() => {});
    return result;
  }
  async close() {
    this.closing = true;
    for (const controller of this.work.keys()) controller.abort();
    await Promise.allSettled(this.work.values());
  }
}
