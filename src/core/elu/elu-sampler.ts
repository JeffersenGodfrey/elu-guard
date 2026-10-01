import { performance } from 'node:perf_hooks';
import type { EventLoopUtilization } from 'node:perf_hooks';

export interface EluSamplerOptions {
  /** How often to sample ELU, in milliseconds. Default 1000ms. */
  intervalMs?: number;
}

export type EluListener = (elu: number) => void;

/**
 * Samples Node's Event Loop Utilization (ELU) on a fixed interval.
 *
 * ELU is the ratio of time the event loop spent active vs idle since the
 * last sample, in the range [0, 1]. Unlike CPU% or request latency, ELU is
 * a direct measure of how saturated Node's single event loop actually is,
 * so it doesn't get confused by "this route is naturally slower" the way
 * latency-based signals do.
 */
export class EluSampler {
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private lastElu: EventLoopUtilization;
  private readonly listeners = new Set<EluListener>();
  private _current = 0;

  constructor(options: EluSamplerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 1000;
    this.lastElu = performance.eventLoopUtilization();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const delta = performance.eventLoopUtilization(this.lastElu);
      this.lastElu = performance.eventLoopUtilization();
      this._current = delta.utilization;
      for (const listener of this.listeners) listener(this._current);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Most recently sampled ELU value, in [0, 1]. 0 before the first sample. */
  get current(): number {
    return this._current;
  }

  /** Subscribe to new samples. Returns an unsubscribe function. */
  onSample(listener: EluListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
