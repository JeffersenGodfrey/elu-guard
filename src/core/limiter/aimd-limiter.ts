import { EluSampler, EluSamplerOptions } from '../elu/elu-sampler';

export interface AimdLimiterOptions {
  /** Floor for the concurrency limit. Default 5. */
  minConcurrency?: number;
  /** Ceiling for the concurrency limit. Default 500. */
  maxConcurrency?: number;
  /** Starting limit. Defaults to minConcurrency for a conservative warm-up. */
  initialConcurrency?: number;
  /** Target ELU: above this, the limit decreases. Default 0.8. */
  targetElu?: number;
  /** Gap below targetElu at which the limit is allowed to increase again.
   *  Default 0.2, so with the default targetElu of 0.8, the limiter backs
   *  off above 0.8 and only grows again once ELU drops to 0.6 or below.
   *  This hysteresis band is what stops the limit from oscillating every
   *  sample when ELU hovers right at the threshold. */
  hysteresis?: number;
  /** Multiplicative decrease factor applied when ELU is above target. Default 0.8. */
  decreaseFactor?: number;
  /** Multiplicative decrease factor applied after a classified downstream failure. Default 0.8. */
  failureDecreaseFactor?: number;
  /** Reduce the limit when an admitted operation exceeds this latency, in ms. */
  latencyThresholdMs?: number;
  /** Multiplicative decrease factor applied when latency exceeds the threshold. Default 0.8. */
  latencyDecreaseFactor?: number;
  /** Fixed additive increase step. 0 (default) means sqrt(currentLimit), which
   *  recovers faster at low limits and slower as the limit grows. */
  increaseStep?: number;
  /** How often to resample ELU and re-adjust, in ms. Default 1000. */
  sampleIntervalMs?: number;
  /** How long a queued caller waits for a slot before being rejected, in ms. Default 5000. */
  queueTimeoutMs?: number;
  /** Max callers allowed to wait in the queue before new callers are rejected immediately. Default 1000. */
  maxQueueLength?: number;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class LimitRejectedError extends Error {
  constructor(message = 'Concurrency limit reached') {
    super(message);
    this.name = 'LimitRejectedError';
  }
}

export class ShuttingDownError extends Error {
  constructor(message = 'Guard is shutting down') {
    super(message);
    this.name = 'ShuttingDownError';
  }
}

/**
 * Thrown by acquire() when the caller's AbortSignal fires (before the call
 * starts or while it is queued). Distinct from ShuttingDownError on purpose:
 * "the caller gave up" is not "the guard is going away", and callers that use
 * the limiter directly can tell the two apart without string-matching.
 */
export class LimiterAbortedError extends Error {
  constructor(message = 'Aborted while waiting for a slot', options?: { cause?: unknown }) {
    super(message);
    this.name = 'LimiterAbortedError';
    if (options && options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export type LimitChangeListener = (limit: number, elu: number) => void;
type ResolvedOptions = Required<AimdLimiterOptions>;

/**
 * Self-tuning concurrency limiter.
 *
 * Instead of a fixed number you pick and forget to revisit, the limit is
 * adjusted every sampleIntervalMs using an AIMD control loop (the same
 * family of algorithm TCP congestion control uses):
 *   - ELU below (targetElu - hysteresis) -> increase the limit (recover capacity)
 *   - ELU at/above targetElu             -> decrease the limit multiplicatively (back off fast)
 *   - in between                          -> hold steady
 *
 * Callers acquire() a slot before doing work and release() it after. When
 * no slot is free, callers queue up to maxQueueLength and are resolved in
 * FIFO order as slots free up, or rejected if they wait past queueTimeoutMs.
 */
export class AimdLimiter {
  private readonly opts: ResolvedOptions;
  private readonly sampler: EluSampler;
  private readonly unsubscribe: () => void;
  private limit: number;
  private inFlight = 0;
  private readonly queue: Waiter[] = [];
  private stopped = false;
  private pausedUntil = 0;
  private pauseTimer: NodeJS.Timeout | null = null;
  private readonly limitListeners = new Set<LimitChangeListener>();

  constructor(options: AimdLimiterOptions = {}, samplerOptions: EluSamplerOptions = {}) {
    const maxConcurrency = options.maxConcurrency ?? 500;
    const minConcurrency = Math.min(options.minConcurrency ?? 5, maxConcurrency);
    this.opts = {
      minConcurrency,
      maxConcurrency,
      initialConcurrency: options.initialConcurrency ?? minConcurrency,
      targetElu: options.targetElu ?? 0.8,
      hysteresis: options.hysteresis ?? 0.2,
      decreaseFactor: options.decreaseFactor ?? 0.8,
      failureDecreaseFactor: options.failureDecreaseFactor ?? 0.8,
      latencyThresholdMs: options.latencyThresholdMs ?? 0,
      latencyDecreaseFactor: options.latencyDecreaseFactor ?? options.failureDecreaseFactor ?? 0.8,
      increaseStep: options.increaseStep ?? 0,
      sampleIntervalMs: options.sampleIntervalMs ?? 1000,
      queueTimeoutMs: options.queueTimeoutMs ?? 5000,
      maxQueueLength: options.maxQueueLength ?? 1000,
    };
    this.limit = Math.min(this.opts.initialConcurrency, this.opts.maxConcurrency);
    this.sampler = new EluSampler({ intervalMs: this.opts.sampleIntervalMs, ...samplerOptions });
    this.unsubscribe = this.sampler.onSample((elu) => this.adjust(elu));
    this.sampler.start();
  }

  /**
   * Feeds one ELU sample into the AIMD control loop and re-evaluates the
   * limit. Called automatically on every sampler tick; exposed publicly so
   * it can also be driven manually (useful for tests, or for wiring in a
   * different saturation signal).
   */
  adjust(elu: number): void {
    const previousLimit = this.limit;
    const low = Math.max(0, this.opts.targetElu - this.opts.hysteresis);
    if (elu >= this.opts.targetElu) {
      this.limit = Math.max(this.opts.minConcurrency, Math.floor(this.limit * this.opts.decreaseFactor));
    } else if (elu <= low) {
      const step = this.opts.increaseStep > 0 ? this.opts.increaseStep : Math.max(1, Math.floor(Math.sqrt(this.limit)));
      this.limit = Math.min(this.opts.maxConcurrency, this.limit + step);
    }
    if (this.limit !== previousLimit) {
      for (const listener of this.limitListeners) listener(this.limit, elu);
    }
    this.drainQueue();
  }

  /**
   * Feeds a classified downstream failure into the controller. Remote I/O can
   * fail while this process remains locally idle, so ELU alone cannot react to
   * pool exhaustion, rate limits, or dependency overload responses.
   */
  recordFailure(): void {
    this.backoff(this.opts.failureDecreaseFactor);
  }

  /** Feeds observed execution latency into the controller when configured. */
  recordLatency(durationMs: number): void {
    if (this.opts.latencyThresholdMs > 0 && durationMs > this.opts.latencyThresholdMs) {
      this.backoff(this.opts.latencyDecreaseFactor);
    }
  }

  /** Temporarily stops admitting new work, typically after Retry-After. */
  pause(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + durationMs);
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      this.pausedUntil = 0;
      this.drainQueue();
    }, Math.max(1, this.pausedUntil - Date.now()));
  }

  private backoff(factor: number): void {
    const previousLimit = this.limit;
    this.limit = Math.min(
      this.opts.maxConcurrency,
      Math.max(this.opts.minConcurrency, Math.floor(this.limit * factor)),
    );
    if (this.limit !== previousLimit) {
      for (const listener of this.limitListeners) listener(this.limit, this.sampler.current);
    }
    this.drainQueue();
  }

  /** Subscribe to limit changes. Returns an unsubscribe function. */
  onLimitChange(listener: LimitChangeListener): () => void {
    this.limitListeners.add(listener);
    return () => this.limitListeners.delete(listener);
  }

  private drainQueue(): void {
    if (Date.now() < this.pausedUntil) return;
    while (this.inFlight < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      clearTimeout(waiter.timer);
      this.inFlight++;
      waiter.resolve();
    }
  }

  get currentLimit(): number {
    return this.limit;
  }

  get currentInFlight(): number {
    return this.inFlight;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get currentElu(): number {
    return this.sampler.current;
  }

  /** Waits for a free slot. Resolves immediately if under the limit. */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.stopped) {
      throw new ShuttingDownError();
    }
    if (signal?.aborted) {
      throw new LimiterAbortedError(undefined, { cause: signal.reason });
    }
    if (Date.now() < this.pausedUntil) {
      throw new LimitRejectedError('Limiter temporarily paused after downstream rate limiting');
    }
    if (this.inFlight < this.limit) {
      this.inFlight++;
      return;
    }
    if (this.queue.length >= this.opts.maxQueueLength) {
      throw new LimitRejectedError();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (err: Error) => {
          cleanup();
          reject(err);
        },
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) this.queue.splice(idx, 1);
          cleanup();
          reject(new LimitRejectedError('Timed out waiting in queue for a free slot'));
        }, this.opts.queueTimeoutMs),
      };
      const cleanup = () => {
        clearTimeout(waiter.timer);
        if (waiter.onAbort && waiter.signal) {
          waiter.signal.removeEventListener('abort', waiter.onAbort);
        }
      };
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) this.queue.splice(idx, 1);
          cleanup();
          reject(new LimiterAbortedError(undefined, { cause: signal?.reason }));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  /** Frees a slot previously obtained via acquire(). */
  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.drainQueue();
  }

  /**
   * Stops the sampler and rejects every currently queued waiter with a
   * ShuttingDownError so nothing is left hanging forever. Does not force
   * in-flight work to abort - callers that already acquired a slot are
   * expected to finish and call release() themselves.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    this.unsubscribe();
    this.sampler.stop();
    while (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      clearTimeout(waiter.timer);
      waiter.reject(new ShuttingDownError());
    }
  }
}
