import { EluGuard } from '../../src/core/guard/guard';
import { CircuitOpenError } from '../../src/core/breaker/circuit-breaker';
import { ShuttingDownError } from '../../src/core/limiter/aimd-limiter';
import { ConcurrencyLimitError, GuardAbortedError, GuardTimeoutError } from '../../src/errors';

describe('EluGuard', () => {
  test('runs a function successfully and records success on the breaker', async () => {
    const guard = new EluGuard({ limiter: { initialConcurrency: 5, maxConcurrency: 5 } });
    const result = await guard.execute(async () => 42);
    expect(result).toBe(42);
    expect(guard.stats().circuitState).toBe('closed');
    await guard.stop();
  });

  test('propagates the underlying error and records a failure', async () => {
    const guard = new EluGuard({ limiter: { initialConcurrency: 5, maxConcurrency: 5 } });
    await expect(
      guard.execute(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await guard.stop();
  });

  test('opens the breaker after repeated failures and then fails fast', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 5, maxConcurrency: 5 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2 },
    });
    const failing = () => Promise.reject(new Error('boom'));

    await expect(guard.execute(failing)).rejects.toThrow('boom');
    await expect(guard.execute(failing)).rejects.toThrow('boom');
    await expect(guard.execute(async () => 1)).rejects.toBeInstanceOf(CircuitOpenError);
    await guard.stop();
  });

  test('releases the limiter slot even when the function throws', async () => {
    const guard = new EluGuard({ limiter: { initialConcurrency: 1, maxConcurrency: 1 } });
    await expect(
      guard.execute(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(guard.stats().inFlight).toBe(0);
    await guard.stop();
  });

  test('emits stateChange when the breaker trips', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 5, maxConcurrency: 5 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2 },
    });
    const states: string[] = [];
    guard.on('stateChange', (s) => states.push(s));

    const failing = () => Promise.reject(new Error('boom'));
    await expect(guard.execute(failing)).rejects.toThrow();
    await expect(guard.execute(failing)).rejects.toThrow();

    expect(states).toEqual(['open']);
    await guard.stop();
  });

  test('emits limitChange when the AIMD controller adjusts the limit', async () => {
    const guard = new EluGuard({ limiter: { initialConcurrency: 16, maxConcurrency: 100 } });
    const changes: number[] = [];
    guard.on('limitChange', (limit) => changes.push(limit));

    guard.limiter.adjust(0.1); // force a low-ELU sample manually

    expect(changes).toEqual([20]); // sqrt(16) = 4 -> 16 + 4
    await guard.stop();
  });

  test('stop() causes queued execute() calls to reject instead of hanging', async () => {
    const guard = new EluGuard({ limiter: { initialConcurrency: 1, maxConcurrency: 1, queueTimeoutMs: 60000 } });

    const first = guard.execute(() => new Promise((resolve) => setTimeout(() => resolve(1), 200)));
    const queued = guard.execute(async () => 2); // will queue behind `first`

    await guard.stop();

    await expect(queued).rejects.toBeInstanceOf(ShuttingDownError);
    await first; // let the in-flight one finish naturally
  });

  test('caller abort while queued does not count as a breaker failure', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 1, maxConcurrency: 1, queueTimeoutMs: 5000 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2 },
    });
    const release = () => guard.limiter.release();
    await guard.limiter.acquire();
    const controller = new AbortController();
    const queued = guard.execute(() => Promise.resolve(1), { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toThrow();
    release();
    expect(guard.stats().circuitState).toBe('closed');
    expect(guard.stats().inFlight).toBe(0);
    await guard.stop();
  });

  test('isFailure returning false keeps the breaker closed', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 5, maxConcurrency: 5 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2 },
      isFailure: () => false,
    });
    await expect(guard.execute(async () => { throw new Error('not a dependency failure'); })).rejects.toThrow();
    await expect(guard.execute(async () => { throw new Error('not a dependency failure'); })).rejects.toThrow();
    expect(guard.stats().circuitState).toBe('closed');
    await guard.stop();
  });

  test('latency feedback reduces the limiter after a slow successful call', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 10, maxConcurrency: 10, latencyThresholdMs: 5, latencyDecreaseFactor: 0.5 },
    });
    await guard.execute(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(guard.stats().limit).toBe(5);
    await guard.stop();
  });

  test('Retry-After feedback pauses new admissions without opening the breaker', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 2, maxConcurrency: 2, maxQueueLength: 0 },
      breaker: { minimumRequests: 100 },
      retryAfterMs: () => 20,
    });
    await expect(guard.execute(() => Promise.reject(new Error('429')))).rejects.toThrow('429');
    await expect(guard.execute(async () => 'blocked')).rejects.toBeInstanceOf(ConcurrencyLimitError);
    expect(guard.stats().circuitState).toBe('closed');
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(guard.execute(async () => 'ok')).resolves.toBe('ok');
    await guard.stop();
  });

  test('timeout aborts the operation and surfaces GuardTimeoutError', async () => {
    const guard = new EluGuard({ limiter: { initialConcurrency: 2, maxConcurrency: 2 } });
    await expect(
      guard.execute(
        ({ signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason ?? new GuardAbortedError()));
        }),
        { timeoutMs: 30 },
      ),
    ).rejects.toBeInstanceOf(GuardTimeoutError);
    expect(guard.stats().inFlight).toBe(0);
    await guard.stop();
  });

  test('limiter rejection maps to ConcurrencyLimitError and supports fallback', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 1, maxConcurrency: 1, maxQueueLength: 0, queueTimeoutMs: 1000 },
    });
    const first = guard.execute(() => new Promise<string>((resolve) => setTimeout(() => resolve('a'), 100)));
    await expect(guard.execute(async () => 'b')).rejects.toBeInstanceOf(ConcurrencyLimitError);
    const fb = await guard.execute(async () => 'b', { fallback: () => 'cached' });
    expect(fb).toBe('cached');
    await first;
    await guard.stop();
  });

  test('open circuit uses fallback instead of throwing', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 5, maxConcurrency: 5 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2 },
    });
    const failing = () => Promise.reject(new Error('boom'));
    await expect(guard.execute(failing)).rejects.toThrow('boom');
    await expect(guard.execute(failing)).rejects.toThrow('boom');
    const fb = await guard.execute(async () => 'live', { fallback: () => 'cached' });
    expect(fb).toBe('cached');
    await guard.stop();
  });

  test('half-open probe released when the limiter refuses the call', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 1, maxConcurrency: 1, maxQueueLength: 0, queueTimeoutMs: 1000 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2, resetTimeoutMs: 20, halfOpenMaxCalls: 1 },
    });
    const failing = () => Promise.reject(new Error('boom'));
    await expect(guard.execute(failing)).rejects.toThrow('boom');
    await expect(guard.execute(failing)).rejects.toThrow('boom');
    expect(guard.stats().circuitState).toBe('open');
    await new Promise((r) => setTimeout(r, 40));
    expect(guard.stats().circuitState).toBe('half-open');
    await guard.limiter.acquire();
    await expect(guard.execute(async () => 'probe')).rejects.toBeInstanceOf(ConcurrencyLimitError);
    guard.limiter.release();
    // Slot freed: another probe must be admittable, proving no probe leak.
    const ok = await guard.execute(async () => 'probe-ok');
    expect(ok).toBe('probe-ok');
    await guard.stop();
  });

  test('timeout settles execute() even when the task ignores the signal', async () => {
    const guard = new EluGuard({ limiter: { initialConcurrency: 2, maxConcurrency: 2 } });
    await expect(
      guard.execute(() => new Promise(() => undefined), { timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(GuardTimeoutError);
    expect(guard.stats().inFlight).toBe(0);
    await guard.stop();
  });

  test('timeout while queued rejects with GuardTimeoutError and frees the waiter', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 1, maxConcurrency: 1, queueTimeoutMs: 60000 },
    });
    const first = guard.execute(() => new Promise<string>((r) => setTimeout(() => r('a'), 150)));
    await expect(guard.execute(async () => 'b', { timeoutMs: 30 })).rejects.toBeInstanceOf(GuardTimeoutError);
    expect(guard.stats().queueLength).toBe(0);
    await first;
    expect(guard.stats().inFlight).toBe(0);
    await guard.stop();
  });

  test('caller abort settles execute() even when the task ignores the signal', async () => {
    const guard = new EluGuard({ limiter: { initialConcurrency: 2, maxConcurrency: 2 } });
    const controller = new AbortController();
    const reason = new GuardAbortedError('caller went away');
    const pending = guard.execute(() => new Promise(() => undefined), { signal: controller.signal });
    controller.abort(reason);
    const err = (await pending.then(
      () => null,
      (e) => e,
    )) as GuardAbortedError;
    expect(err).toBeInstanceOf(GuardAbortedError);
    expect((err as { cause?: unknown }).cause).toBe(reason);
    expect(guard.stats().inFlight).toBe(0);
    expect(guard.stats().circuitState).toBe('closed');
    await guard.stop();
  });

  test('an abandoned task that later rejects leaks no permit and no unhandled rejection', async () => {
    const guard = new EluGuard({ limiter: { initialConcurrency: 1, maxConcurrency: 1 } });
    let rejectLate: ((err: Error) => void) | undefined;
    const call = guard.execute(
      () => new Promise((_resolve, reject) => {
        rejectLate = reject;
      }),
      { timeoutMs: 20 },
    );
    await expect(call).rejects.toBeInstanceOf(GuardTimeoutError);
    expect(guard.stats().inFlight).toBe(0);

    (rejectLate as unknown as (err: Error) => void)(new Error('late failure from the abandoned task'));
    await new Promise((r) => setTimeout(r, 10));

    expect(guard.stats().inFlight).toBe(0);
    await expect(guard.execute(async () => 'next')).resolves.toBe('next');
    await guard.stop();
  });

  test('caller abort during half-open hands the probe back instead of closing the circuit', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 1, maxConcurrency: 1 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2, resetTimeoutMs: 20, halfOpenMaxCalls: 1 },
    });
    const failing = () => Promise.reject(new Error('boom'));
    await expect(guard.execute(failing)).rejects.toThrow('boom');
    await expect(guard.execute(failing)).rejects.toThrow('boom');
    expect(guard.stats().circuitState).toBe('open');
    await new Promise((r) => setTimeout(r, 40));
    expect(guard.stats().circuitState).toBe('half-open');

    const controller = new AbortController();
    const pending = guard.execute(() => new Promise(() => undefined), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(GuardAbortedError);

    // The probe was returned, so the circuit is still half-open and a healthy
    // probe can still get through.
    expect(guard.stats().circuitState).toBe('half-open');
    await expect(guard.execute(async () => 'probe')).resolves.toBe('probe');
    expect(guard.stats().circuitState).toBe('closed');
    await guard.stop();
  });

  test('probe reservations are handed back on failed probes, aborts and successes', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 4, maxConcurrency: 4 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2, resetTimeoutMs: 20, halfOpenMaxCalls: 1 },
    });
    const failing = () => Promise.reject(new Error('boom'));
    await expect(guard.execute(failing)).rejects.toThrow('boom');
    await expect(guard.execute(failing)).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 40));
    expect(guard.stats().circuitState).toBe('half-open');

    // A failed probe must not permanently consume the half-open allowance.
    await expect(guard.execute(failing)).rejects.toThrow('boom');
    expect(guard.stats().probes).toBe(0);

    await new Promise((r) => setTimeout(r, 40));
    expect(guard.stats().circuitState).toBe('half-open');

    // A cancelled probe hands the reservation back too, so the next call can
    // still probe instead of being rejected forever.
    const controller = new AbortController();
    const pending = guard.execute(() => new Promise(() => undefined), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(GuardAbortedError);
    expect(guard.stats().probes).toBe(0);
    expect(guard.stats().circuitState).toBe('half-open');

    await expect(guard.execute(async () => 'healthy')).resolves.toBe('healthy');
    expect(guard.stats().probes).toBe(0);
    expect(guard.stats().circuitState).toBe('closed');
    await guard.stop();
  });

  test('guard-level countTimeoutAsFailure: false keeps deadlines out of the breaker', async () => {
    const guard = new EluGuard({
      limiter: { initialConcurrency: 3, maxConcurrency: 3 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2 },
      countTimeoutAsFailure: false,
    });

    await expect(guard.execute(() => new Promise(() => undefined), { timeoutMs: 20 })).rejects.toBeInstanceOf(
      GuardTimeoutError,
    );
    await expect(guard.execute(() => new Promise(() => undefined), { timeoutMs: 20 })).rejects.toBeInstanceOf(
      GuardTimeoutError,
    );

    expect(guard.stats().circuitState).toBe('closed');
    expect(guard.stats().inFlight).toBe(0);

    // A per-call override still wins over the guard-level default.
    await expect(
      guard.execute(() => new Promise(() => undefined), { timeoutMs: 20, countTimeoutAsFailure: true }),
    ).rejects.toBeInstanceOf(GuardTimeoutError);
    await expect(
      guard.execute(() => new Promise(() => undefined), { timeoutMs: 20, countTimeoutAsFailure: true }),
    ).rejects.toBeInstanceOf(GuardTimeoutError);
    expect(guard.stats().circuitState).toBe('open');

    await guard.stop();
  });
});
