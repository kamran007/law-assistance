/**
 * Global minimum-interval limiter: every `acquire()` resolves at least `minIntervalMs` after the
 * previous one. Callers are served in FIFO order. One instance must be shared by all requests to the
 * same host (TRD §6.1: 1 request/second globally). The scrape queue also runs with concurrency 1.
 */
export class IntervalLimiter {
  private nextSlot = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  acquire(): Promise<void> {
    const turn = this.tail.then(async () => {
      const wait = this.nextSlot - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextSlot = this.now() + this.minIntervalMs;
    });
    this.tail = turn.catch(() => undefined);
    return turn;
  }
}
