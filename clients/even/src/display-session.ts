// The companion WebView can survive a glasses-page exit (notably in the simulator).
// Only an explicit open may recreate the page; exit never restarts the microphone.
export class DisplaySession {
  open = false;
  private generation = 0;
  private pending?: Promise<boolean>;
  close() { this.open = false; this.generation++; this.pending = undefined; }
  async restore(create: () => Promise<boolean>): Promise<boolean> {
    if (this.open) return true;
    if (this.pending) return this.pending;
    const generation = this.generation;
    const attempt = Promise.resolve().then(create).then(ok => {
      if (generation !== this.generation) return false;
      this.open = ok; return ok;
    }).finally(() => { if (generation === this.generation) this.pending = undefined; });
    this.pending = attempt;
    return attempt;
  }
}
