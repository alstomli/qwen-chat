/** One route-entry budget, shared by validation, readiness, queueing and streaming. */
export const HOSTED_CHAT_TIMEOUT_MS = 240_000;
export class RequestDeadline {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly started = performance.now();
  private expires = Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  timedOut = false;
  private readonly cancel = () => this.controller.abort();
  constructor(private readonly incoming: AbortSignal, hosted: boolean) {
    incoming.addEventListener("abort", this.cancel, { once: true });
    if (incoming.aborted) this.cancel();
    if (hosted) this.limit(HOSTED_CHAT_TIMEOUT_MS);
  }
  /** Limits always refer to route entry and may only shorten the existing budget. */
  limit(milliseconds: number) {
    this.expires = Math.min(this.expires, this.started + milliseconds);
    clearTimeout(this.timer);
    const remaining = this.expires - performance.now();
    if (remaining <= 0) this.expire();
    else this.timer = setTimeout(() => this.expire(), remaining);
  }
  private expire() { this.timedOut = true; this.controller.abort(); }
  remainingSeconds() {
    const remaining = this.expires - performance.now();
    if (remaining <= 0) { this.expire(); throw this.signal.reason; }
    // The protocol has a one-second minimum. Its rounding never extends this
    // owner's exact outer deadline, which still aborts all upstream work.
    return Math.max(1, Math.floor(remaining / 1000));
  }
  async run<T>(operation: Promise<T>): Promise<T> {
    if (this.signal.aborted) { operation.catch(() => {}); throw this.signal.reason; }
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
    try { return await Promise.race([operation, aborted]); }
    finally { this.signal.removeEventListener("abort", onAbort); }
  }
  abort() { this.controller.abort(); }
  finish() { clearTimeout(this.timer); this.incoming.removeEventListener("abort", this.cancel); }
}
