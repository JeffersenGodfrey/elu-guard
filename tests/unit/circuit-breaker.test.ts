import { CircuitBreaker } from '../../src/core/breaker/circuit-breaker';

describe('CircuitBreaker', () => {
  test('rejects invalid numeric configuration', () => {
    expect(() => new CircuitBreaker({ failureThreshold: -1 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ halfOpenMaxCalls: 0 })).toThrow(RangeError);
  });
  test('starts closed', () => {
    const cb = new CircuitBreaker();
    expect(cb.currentState).toBe('closed');
    expect(cb.canPass()).toBe(true);
  });

  test('stays closed below the failure threshold', () => {
    const cb = new CircuitBreaker({ failureThreshold: 0.5, minimumRequests: 4 });
    cb.recordSuccess();
    cb.recordSuccess();
    cb.recordSuccess();
    cb.recordFailure();
    expect(cb.currentState).toBe('closed');
  });

  test('opens once the failure ratio hits the threshold with enough samples', () => {
    const cb = new CircuitBreaker({ failureThreshold: 0.5, minimumRequests: 4 });
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe('open');
    expect(cb.canPass()).toBe(false);
  });

  test('does not evaluate the threshold before minimumRequests is reached', () => {
    const cb = new CircuitBreaker({ failureThreshold: 0.5, minimumRequests: 10 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe('closed');
  });

  test('transitions open -> half-open after resetTimeoutMs elapses', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 0.5, minimumRequests: 2, resetTimeoutMs: 40 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe('open');
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.currentState).toBe('half-open');
  });

  test('a successful half-open probe closes the circuit', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 0.5, minimumRequests: 2, resetTimeoutMs: 20 });
    cb.recordFailure();
    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 30));
    expect(cb.currentState).toBe('half-open');
    cb.recordSuccess();
    expect(cb.currentState).toBe('closed');
  });

  test('a failed half-open probe re-opens the circuit', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 0.5, minimumRequests: 2, resetTimeoutMs: 20 });
    cb.recordFailure();
    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 30));
    expect(cb.currentState).toBe('half-open');
    cb.recordFailure();
    expect(cb.currentState).toBe('open');
  });

  test('half-open only admits halfOpenMaxCalls concurrent probes', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 0.5, minimumRequests: 2, resetTimeoutMs: 20, halfOpenMaxCalls: 1 });
    cb.recordFailure();
    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 30));
    const first = cb.tryAcquire();
    expect(first.kind).toBe('probe');
    expect(cb.tryAcquire().kind).toBe('reject');
    if (first.kind === 'probe') first.release();
    const retry = cb.tryAcquire();
    expect(retry.kind).toBe('probe');
    if (retry.kind === 'probe') retry.release();
  });

  test('releasing a probe after a rejected limiter acquire frees the slot', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 0.5, minimumRequests: 2, resetTimeoutMs: 20, halfOpenMaxCalls: 1 });
    cb.recordFailure();
    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 30));
    expect(cb.currentState).toBe('half-open');
    const probe = cb.tryAcquire();
    expect(probe.kind).toBe('probe');
    expect(cb.tryAcquire().kind).toBe('reject');
    if (probe.kind === 'probe') probe.release();
    for (let i = 0; i < 3; i++) {
      const next = cb.tryAcquire();
      expect(next.kind).toBe('probe');
      if (next.kind === 'probe') next.release();
    }
    expect(cb.currentState).toBe('half-open');
  });

  test('emits a state-change event on every transition', () => {
    const cb = new CircuitBreaker({ failureThreshold: 0.5, minimumRequests: 2 });
    const seen: string[] = [];
    cb.onStateChange((s) => seen.push(s));
    cb.recordFailure();
    cb.recordFailure();
    expect(seen).toEqual(['open']);
  });

  test('outcomes outside the rolling window are pruned and do not count toward the threshold', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 0.5, minimumRequests: 2, windowMs: 40 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe('open');
    // wait for a fresh breaker instance scenario: pruning is exercised by
    // checking the window logic directly via successive closed-state calls.
    const cb2 = new CircuitBreaker({ failureThreshold: 0.5, minimumRequests: 2, windowMs: 30 });
    cb2.recordFailure();
    await new Promise((r) => setTimeout(r, 40));
    cb2.recordFailure(); // the first failure should have aged out of the window by now
    expect(cb2.currentState).toBe('closed');
  });
});
