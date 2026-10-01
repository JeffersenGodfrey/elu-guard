export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  minimumRequests?: number;
  windowMs?: number;
  resetTimeoutMs?: number;
  halfOpenMaxCalls?: number;
}

export class CircuitOpenError extends Error {
  constructor(message = 'Circuit is open') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

interface Outcome {
  success: boolean;
  timestamp: number;
}

type ResolvedOptions = Required<CircuitBreakerOptions>;

export type Admission =
  | { kind: 'allow' }
  | { kind: 'probe'; release: () => void }
  | { kind: 'reject' };

export class CircuitBreaker {
  private readonly opts: ResolvedOptions;
  private state: CircuitState = 'closed';
  private outcomes: Outcome[] = [];
  private openedAt = 0;
  private halfOpenInFlight = 0;
  private readonly listeners = new Set<(state: CircuitState) => void>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.opts = {
      failureThreshold: options.failureThreshold ?? 0.5,
      minimumRequests: options.minimumRequests ?? 10,
      windowMs: options.windowMs ?? 10000,
      resetTimeoutMs: options.resetTimeoutMs ?? 5000,
      halfOpenMaxCalls: options.halfOpenMaxCalls ?? 3,
    };
  }

  get currentState(): CircuitState {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.opts.resetTimeoutMs) {
      this.transition('half-open');
    }
    return this.state;
  }

  onStateChange(listener: (state: CircuitState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Half-open probes currently reserved and not yet released. Exposed so that
   * leaks are observable from the outside (stats(), soak tests) instead of
   * only being inferable from a wedged circuit.
   */
  get inFlightProbes(): number {
    return this.halfOpenInFlight;
  }

  private transition(next: CircuitState): void {
    if (this.state === next) return;
    this.state = next;
    if (next === 'open') this.openedAt = Date.now();
    if (next === 'half-open') this.halfOpenInFlight = 0;
    if (next === 'closed') {
      this.outcomes = [];
      this.halfOpenInFlight = 0;
      while (this.pendingProbes.length > 0) {
        const release = this.pendingProbes.pop();
        if (release) release();
      }
    }
    for (const listener of this.listeners) listener(next);
  }

  tryAcquire(): Admission {
    const state = this.currentState;
    if (state === 'closed') return { kind: 'allow' };
    if (state === 'half-open') {
      if (this.halfOpenInFlight < this.opts.halfOpenMaxCalls) {
        this.halfOpenInFlight++;
        let released = false;
        return {
          kind: 'probe',
          release: () => {
            if (released) return;
            released = true;
            this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
          },
        };
      }
      return { kind: 'reject' };
    }
    return { kind: 'reject' };
  }

  /** Backwards-compatible single-call check. Prefer tryAcquire() in new code. */
  canPass(): boolean {
    const admission = this.tryAcquire();
    if (admission.kind === 'probe') {
      this.pendingProbes.push(admission.release);
      return true;
    }
    return admission.kind === 'allow';
  }

  private pendingProbes: Array<() => void> = [];

  /** Release a probe reserved via canPass() when the limiter refuses the call. */
  releasePendingProbe(): void {
    const release = this.pendingProbes.pop();
    if (release) release();
  }

  private pruneWindow(): void {
    const cutoff = Date.now() - this.opts.windowMs;
    while (this.outcomes.length > 0 && this.outcomes[0].timestamp < cutoff) {
      this.outcomes.shift();
    }
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.transition('closed');
      return;
    }
    this.outcomes.push({ success: true, timestamp: Date.now() });
    this.pruneWindow();
  }

  recordFailure(): void {
    if (this.state === 'half-open') {
      this.transition('open');
      return;
    }
    this.outcomes.push({ success: false, timestamp: Date.now() });
    this.pruneWindow();
    if (this.outcomes.length >= this.opts.minimumRequests) {
      const failures = this.outcomes.filter((o) => !o.success).length;
      if (failures / this.outcomes.length >= this.opts.failureThreshold) {
        this.transition('open');
      }
    }
  }
}

