export type QueueAdmission = "queued" | "replaced" | "full" | "closed";

export interface QueueStats {
  active: number;
  pending: number;
  accepting: boolean;
}

/**
 * A bounded in-memory queue that keeps only the latest pending job per PR.
 * A new synchronize delivery replaces an older pending delivery for the same PR.
 */
export class LatestJobQueue {
  private readonly concurrency: number;
  private readonly maxPending: number;
  private active = 0;
  private accepting = true;
  private pendingOrder: string[] = [];
  private pending = new Map<string, () => Promise<void>>();
  private idleWaiters: Array<() => void> = [];

  constructor(concurrency: number, maxPending: number) {
    this.concurrency = concurrency;
    this.maxPending = maxPending;
  }

  enqueue(key: string, task: () => Promise<void>): QueueAdmission {
    if (!this.accepting) return "closed";

    if (this.pending.has(key)) {
      this.pending.set(key, task);
      return "replaced";
    }
    if (this.pending.size >= this.maxPending) return "full";

    this.pending.set(key, task);
    this.pendingOrder.push(key);
    this.drain();
    return "queued";
  }

  stats(): QueueStats {
    return {
      active: this.active,
      pending: this.pending.size,
      accepting: this.accepting,
    };
  }

  async close(): Promise<void> {
    this.accepting = false;
    await this.onIdle();
  }

  onIdle(): Promise<void> {
    if (this.active === 0 && this.pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pendingOrder.length > 0) {
      const key = this.pendingOrder.shift()!;
      const task = this.pending.get(key);
      if (!task) continue;
      this.pending.delete(key);
      this.active++;
      void task()
        .catch(() => undefined)
        .finally(() => {
          this.active--;
          this.drain();
          this.resolveIdle();
        });
    }
    this.resolveIdle();
  }

  private resolveIdle(): void {
    if (this.active !== 0 || this.pending.size !== 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}
