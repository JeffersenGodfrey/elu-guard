import { EventEmitter } from 'node:events';
import { AimdLimiter, AimdLimiterOptions, LimitRejectedError, LimiterAbortedError, ShuttingDownError } from '../limiter/aimd-limiter';
import { CircuitBreaker, CircuitBreakerOptions, CircuitOpenError, CircuitState, Admission } from '../breaker/circuit-breaker';
import { ConcurrencyLimitError, GuardAbortedError, GuardTimeoutError } from '../../errors';

export interface EluGuardOptions {
  limiter?: AimdLimiterOptions;
  breaker?: CircuitBreakerOptions;
  /**
   * Default deadline for every execute() call, in ms. Overridable per call.
   * Pass 0/undefined for no deadline.
   */
  timeoutMs?: number;
  /**
   * Decides whether a rejection counts as a downstream failure for the
   * breaker. The library deliberately makes no attempt to guess this for
   * arbitrary application errors - the consumer owns that decision.
   * Return `true` to count it, `false` to leave the breaker unaffected.
   */
  isFailure?: (error: unknown) => boolean;
  /** Extract a server-supplied Retry-After delay in milliseconds from a failure. */
  retryAfterMs?: (error: unknown) => number | undefined;
  /**
   * Default for counting guard timeouts as breaker failures. Default `true`.
   * A per-call `countTimeoutAsFailure` wins over this.
   */
  countTimeoutAsFailure?: boolean;
}

export interface ExecuteOptions<T> {
  timeoutMs?: number;
  signal?: AbortSignal;
  fallback?: (error: unknown) => T | Promise<T>;
  countTimeoutAsFailure?: boolean;
}

export interface ExecutionContext {
  signal: AbortSignal;
}

export interface EluGuardStats {
  limit: number;
  inFlight: number;
  queueLength: number;
  elu: number;
  circuitState: CircuitState;
  /** Half-open probes currently reserved and not yet handed back. */
  probes: number;
}

export interface EluGuardEvents {
  stateChange: (state: CircuitState) => void;
  limitChange: (limit: number, elu: number) => void;
}

function isAbortLike(error: unknown): boolean {
  if (error instanceof GuardAbortedError) return true;
  if (error instanceof GuardTimeoutError) return false;
  if (error instanceof Error) return error.name === 'AbortError';
  return false;
}

/**
 * `AbortSignal.reason` is a DOMException for a bare abort(), and whether that
 * is `instanceof Error` depends on the environment (it is not inside jest's
 * test environment). Carry it as `cause` so the thrown error class stays
 * predictable everywhere.
 */
function abortCause(callerSignal?: AbortSignal): { cause?: unknown } {
  const reason = callerSignal?.reason;
  return reason === undefined ? {} : { cause: reason };
}
export class EluGuard extends EventEmitter {
  readonly limiter: AimdLimiter;
  readonly breaker: CircuitBreaker;
  private readonly defaultTimeoutMs?: number;
  private readonly isFailure?: (error: unknown) => boolean;
  private readonly retryAfterMs?: (error: unknown) => number | undefined;
  private readonly defaultCountTimeoutAsFailure: boolean;
  private closed = false;

  constructor(options: EluGuardOptions = {}) {
    super();
    this.limiter = new AimdLimiter(options.limiter);
    this.breaker = new CircuitBreaker(options.breaker);
    this.defaultTimeoutMs = options.timeoutMs;
    this.isFailure = options.isFailure;
    this.retryAfterMs = options.retryAfterMs;
    this.defaultCountTimeoutAsFailure = options.countTimeoutAsFailure ?? true;

    this.breaker.onStateChange((state) => this.emit('stateChange', state));
    this.limiter.onLimitChange((limit, elu) => this.emit('limitChange', limit, elu));
  }

  private classify(error: unknown, countTimeoutAsFailure: boolean): boolean {
    if (this.isFailure) {
      try {
        return this.isFailure(error);
      } catch {
        return true;
      }
    }
    if (error instanceof GuardTimeoutError) return countTimeoutAsFailure;
    if (isAbortLike(error)) return false;
    if (error instanceof LimiterAbortedError) return false;
    if (error instanceof LimitRejectedError) return false;
    if (error instanceof ShuttingDownError) return false;
    if (error instanceof CircuitOpenError) return false;
    return true;
  }

  async execute<T>(
    fn: (ctx: ExecutionContext) => Promise<T> | T,
    options: ExecuteOptions<T> = {},
  ): Promise<T> {
    if (this.closed) throw new ShuttingDownError('Guard is closed');
    const startedAt = Date.now();
    const admission: Admission = this.breaker.tryAcquire();
    if (admission.kind === 'reject') {
      const openErr = new CircuitOpenError();
      if (options.fallback) return options.fallback(openErr);
      throw openErr;
    }
    const releaseProbe = admission.kind === 'probe' ? admission.release : null;

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const callerSignal = options.signal;
    const controller = new AbortController();

    // Rejects as soon as the deadline fires or the caller aborts. Every await
    // below is raced against it, so execute() always settles on time even when
    // the task ignores the signal it was handed. Without this a deadline is
    // only a suggestion: an in-flight task that never settles would leave the
    // returned promise pending forever.
    let rejectFence: (err: unknown) => void = () => undefined;
    const fence = new Promise<never>((_resolve, reject) => {
      rejectFence = reject;
    });
    // The fence is only ever observed through Promise.race(); keep a late
    // rejection from surfacing as an unhandled rejection when the task wins.
    fence.catch(() => undefined);

    const onCallerAbort = () => {
      controller.abort(callerSignal?.reason);
      rejectFence(new GuardAbortedError('Operation aborted by the caller', abortCause(callerSignal)));
    };
    if (callerSignal) {
      if (callerSignal.aborted) onCallerAbort();
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      // Deliberately not unref()'d: the deadline is what unblocks the caller,
      // so the timer has to be able to fire before the process exits.
      timer = setTimeout(() => {
        timedOut = true;
        const timeoutErr = new GuardTimeoutError(`Operation timed out after ${timeoutMs}ms`);
        controller.abort(timeoutErr);
        rejectFence(timeoutErr);
      }, timeoutMs);
    }
    const clearAll = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    };

    let permit = false;
    try {
      try {
        // controller.signal, not callerSignal: a deadline that expires while
        // this call is still queued must also free the queued waiter.
        await this.limiter.acquire(controller.signal);
      } catch (err) {
        if (releaseProbe) releaseProbe();
        clearAll();
        if (timedOut) {
          const timeoutErr = new GuardTimeoutError(
            `Operation timed out after ${timeoutMs}ms`,
            { cause: err },
          );
          if (options.fallback) return options.fallback(timeoutErr);
          throw timeoutErr;
        }
        if (callerSignal?.aborted) {
          const abortedErr = new GuardAbortedError('Aborted while waiting for a slot', { cause: err });
          if (options.fallback) return options.fallback(abortedErr);
          throw abortedErr;
        }
        if (err instanceof LimiterAbortedError) {
          // The internal controller was aborted for a reason other than the
          // caller (a deadline already returned above); never a failure.
          const abortedErr = new GuardAbortedError('Aborted while waiting for a slot', { cause: err });
          if (options.fallback) return options.fallback(abortedErr);
          throw abortedErr;
        }
        if (err instanceof LimitRejectedError) {
          const mapped = new ConcurrencyLimitError(err.message, { cause: err });
          if (options.fallback) return options.fallback(mapped);
          throw mapped;
        }
        if (options.fallback && err instanceof ShuttingDownError) return options.fallback(err);
        throw err;
      }
      permit = true;

      try {
        if (controller.signal.aborted) {
          // The deadline or the abort landed while this call was queued; do
          // not start work that the caller has already stopped waiting for.
          if (timedOut) throw new GuardTimeoutError(`Operation timed out after ${timeoutMs}ms`);
          throw new GuardAbortedError('Aborted before the task started', abortCause(callerSignal));
        }
        const task = Promise.resolve().then(() => fn({ signal: controller.signal }));
        // If the deadline/abort wins the race the task is still running and its
        // eventual settlement is irrelevant; swallow it so it cannot turn into
        // an unhandled rejection.
        task.catch(() => undefined);
        const result = await Promise.race([task, fence]);
        clearAll();
        // Terminal paths release the permit *and* hand any half-open probe
        // reservation back explicitly. Doing it here (rather than relying on a
        // later state transition to zero the counter) is what makes "exactly
        // one release per acquisition" hold for every outcome.
        this.limiter.release();
        if (releaseProbe) releaseProbe();
        this.limiter.recordLatency(Date.now() - startedAt);
        this.breaker.recordSuccess();
        permit = false;
        return result;
      } catch (err) {
        const countTimeout = options.countTimeoutAsFailure ?? this.defaultCountTimeoutAsFailure;
        if (timedOut) {
          const timeoutErr =
            err instanceof GuardTimeoutError
              ? err
              : new GuardTimeoutError(`Operation timed out after ${timeoutMs}ms`, { cause: err });
          const failure = this.classify(timeoutErr, countTimeout);
          clearAll();
          this.limiter.release();
          if (releaseProbe) releaseProbe();
          this.limiter.recordLatency(Date.now() - startedAt);
          if (failure) {
            this.limiter.recordFailure();
            this.pauseAfterRetry(timeoutErr);
            this.breaker.recordFailure();
          }
          else this.breaker.recordSuccess();
          permit = false;
          if (options.fallback) return options.fallback(timeoutErr);
          throw timeoutErr;
        }
        const abortedByCaller = callerSignal?.aborted === true;
        if (abortedByCaller && !this.isFailure) {
          clearAll();
          // A cancelled call is not an outcome: record nothing, and hand a
          // half-open probe back so the next call can still probe.
          if (releaseProbe) releaseProbe();
          this.limiter.release();
          permit = false;
          const abortErr =
            err instanceof GuardAbortedError
              ? err
              : new GuardAbortedError('Operation aborted by the caller', { cause: err });
          if (options.fallback) return options.fallback(abortErr);
          throw abortErr;
        }
        const failure = this.classify(err, countTimeout);
        clearAll();
        this.limiter.release();
        if (releaseProbe) releaseProbe();
        this.limiter.recordLatency(Date.now() - startedAt);
        if (failure) {
          this.limiter.recordFailure();
          this.pauseAfterRetry(err);
          this.breaker.recordFailure();
        }
        else this.breaker.recordSuccess();
        permit = false;
        if (failure && options.fallback) return options.fallback(err);
        throw err;
      }
    } finally {
      if (permit) this.limiter.release();
      clearAll();
    }
  }

  private pauseAfterRetry(error: unknown): void {
    if (!this.retryAfterMs) return;
    try {
      const delay = this.retryAfterMs(error);
      if (delay !== undefined) this.limiter.pause(delay);
    } catch {
      // Retry-After extraction is advisory and must never mask the original error.
    }
  }

  stats(): EluGuardStats {
    return {
      limit: this.limiter.currentLimit,
      inFlight: this.limiter.currentInFlight,
      queueLength: this.limiter.queueLength,
      elu: this.limiter.currentElu,
      circuitState: this.breaker.currentState,
      probes: this.breaker.inFlightProbes,
    };
  }

  /**
   * Stops the internal ELU sampler and rejects any queued callers so
   * nothing is left waiting forever.
   */
  async stop(): Promise<void> {
    this.closed = true;
    this.limiter.stop();
  }

  async close(): Promise<void> {
    return this.stop();
  }
}
