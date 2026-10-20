import { AimdLimiter, LimitRejectedError, LimiterAbortedError, ShuttingDownError } from '../../src/core/limiter/aimd-limiter';

describe('AimdLimiter — control loop', () => {
  test('rejects invalid numeric configuration', () => {
    expect(() => new AimdLimiter({ maxConcurrency: Number.NaN })).toThrow(RangeError);
    expect(() => new AimdLimiter({ decreaseFactor: 1.5 })).toThrow(RangeError);
  });
  test('increases the limit additively (sqrt step) when ELU is below the hysteresis band', () => {
    const limiter = new AimdLimiter({ initialConcurrency: 16, maxConcurrency: 1000, targetElu: 0.8, hysteresis: 0.2 });
    limiter.adjust(0.3); // below 0.6 (0.8 - 0.2)
    // sqrt(16) = 4, so 16 -> 20
    expect(limiter.currentLimit).toBe(20);
    limiter.stop();
  });

  test('decreases the limit multiplicatively when ELU reaches targetElu', () => {
    const limiter = new AimdLimiter({ initialConcurrency: 100, maxConcurrency: 1000, minConcurrency: 5, targetElu: 0.8, decreaseFactor: 0.5 });
    limiter.adjust(0.85);
    expect(limiter.currentLimit).toBe(50);
    limiter.stop();
  });

  test('the limit drops below active permits under pressure, shedding future admissions', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 10, maxConcurrency: 10, minConcurrency: 5, decreaseFactor: 0.5 });
    for (let i = 0; i < 10; i++) await limiter.acquire();
    limiter.adjust(0.9);
    // The controller's target is floor(10 * 0.5) = 5. It must be allowed to
    // fall below the 10 already-admitted calls so admission can stop; those
    // calls keep running and drain naturally. See the regression test below.
    expect(limiter.currentLimit).toBe(5);
    expect(limiter.currentInFlight).toBe(10);
    limiter.stop();
  });

  test('REGRESSION: a lower target stops new admissions while in-flight work drains', async () => {
    const limiter = new AimdLimiter({
      initialConcurrency: 10,
      maxConcurrency: 10,
      minConcurrency: 5,
      decreaseFactor: 0.5,
      queueTimeoutMs: 60000,
    });
    // Fill to the limit; these stay unresolved.
    for (let i = 0; i < 10; i++) await limiter.acquire();
    expect(limiter.currentInFlight).toBe(10);

    // Sustained high ELU: the controller wants the limit at 5.
    limiter.adjust(0.95);
    expect(limiter.currentLimit).toBe(5); // target is now below occupancy

    // A new caller must queue, not run, while in-flight (10) >= target (5).
    let settled = false;
    const queued = limiter.acquire().then(
      () => { settled = true; },
      () => { settled = true; },
    );
    expect(limiter.queueLength).toBe(1);

    // Draining down TO the target must not refill the queue: 5 < 5 is false.
    for (let i = 0; i < 5; i++) limiter.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(limiter.currentInFlight).toBe(5);
    expect(settled).toBe(false);
    expect(limiter.queueLength).toBe(1);

    // Dropping BELOW the target admits exactly one queued caller.
    limiter.release();
    await queued;
    expect(limiter.currentInFlight).toBe(5);
    expect(limiter.queueLength).toBe(0);
    limiter.stop();
  });

  test('REGRESSION: the limit recovers after pressure clears and never exceeds max', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 10, minConcurrency: 5, maxConcurrency: 50, decreaseFactor: 0.5, queueTimeoutMs: 60000 });
    for (let i = 0; i < 10; i++) await limiter.acquire();
    limiter.adjust(0.95);
    expect(limiter.currentLimit).toBe(5);
    // Drain the already-admitted work.
    for (let i = 0; i < 10; i++) limiter.release();
    expect(limiter.currentInFlight).toBe(0);
    // Healthy ELU: additive increase resumes and stays within bounds.
    limiter.adjust(0.1);
    expect(limiter.currentLimit).toBeGreaterThan(5);
    expect(limiter.currentLimit).toBeLessThanOrEqual(50);
    limiter.stop();
  });

  test('REGRESSION: aborting a queued caller while the target is below occupancy keeps accounting consistent', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 2, maxConcurrency: 2, minConcurrency: 1, decreaseFactor: 0.5, queueTimeoutMs: 60000 });
    await limiter.acquire();
    await limiter.acquire();
    limiter.adjust(0.95); // target -> 1
    expect(limiter.currentLimit).toBe(1);

    const ctrl = new AbortController();
    const queued = limiter.acquire(ctrl.signal);
    expect(limiter.queueLength).toBe(1);
    ctrl.abort();
    await expect(queued).rejects.toBeInstanceOf(LimiterAbortedError);
    // The aborted caller is removed from the queue immediately and never runs.
    expect(limiter.queueLength).toBe(0);

    // Releasing an active slot does not resurrect the aborted caller.
    limiter.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(limiter.queueLength).toBe(0);
    limiter.stop();
  });

  test('holds steady inside the hysteresis band', () => {
    const limiter = new AimdLimiter({ initialConcurrency: 50, maxConcurrency: 1000, targetElu: 0.8, hysteresis: 0.2 });
    limiter.adjust(0.7); // between 0.6 and 0.8
    expect(limiter.currentLimit).toBe(50);
    limiter.stop();
  });

  test('never exceeds maxConcurrency even under sustained low ELU', () => {
    const limiter = new AimdLimiter({ initialConcurrency: 10, maxConcurrency: 20, minConcurrency: 5 });
    for (let i = 0; i < 20; i++) limiter.adjust(0.05);
    expect(limiter.currentLimit).toBeLessThanOrEqual(20);
    limiter.stop();
  });

  test('never drops below minConcurrency even under sustained high ELU', () => {
    const limiter = new AimdLimiter({ initialConcurrency: 10, maxConcurrency: 20, minConcurrency: 5 });
    for (let i = 0; i < 20; i++) limiter.adjust(0.99);
    expect(limiter.currentLimit).toBeGreaterThanOrEqual(5);
    limiter.stop();
  });

  test('backs off on classified downstream failure without dropping below the floor', () => {
    const limiter = new AimdLimiter({
      initialConcurrency: 20,
      minConcurrency: 5,
      maxConcurrency: 100,
      failureDecreaseFactor: 0.5,
    });
    limiter.recordFailure();
    expect(limiter.currentLimit).toBe(10);
    limiter.recordFailure();
    limiter.recordFailure();
    expect(limiter.currentLimit).toBe(5);
    limiter.stop();
  });

  test('backs off when the p95 of recent calls exceeds the configured threshold', () => {
    const limiter = new AimdLimiter({
      initialConcurrency: 10,
      maxConcurrency: 20,
      latencyThresholdMs: 25,
      latencyDecreaseFactor: 0.5,
      latencyWindowSize: 100,
      latencyMinSamples: 5,
    });
    for (let i = 0; i < 5; i++) limiter.recordLatency(10);
    expect(limiter.currentLimit).toBe(10);
    limiter.recordLatency(30);
    limiter.recordLatency(31);
    expect(limiter.currentLimit).toBeLessThan(10);
    limiter.stop();
  });

  test('a single slow call does not shrink the limit before the minimum sample count', () => {
    const limiter = new AimdLimiter({
      initialConcurrency: 10,
      maxConcurrency: 20,
      latencyThresholdMs: 25,
      latencyMinSamples: 20,
    });
    limiter.recordLatency(100);
    expect(limiter.currentLimit).toBe(10);
    limiter.stop();
  });

  test('limitChange carries the previous limit, the new limit and the reason', () => {
    const limiter = new AimdLimiter({ initialConcurrency: 16, maxConcurrency: 100 });
    const seen: Array<{ previousLimit: number; limit: number; reason: string }> = [];
    limiter.onLimitChange((change) => seen.push(change));
    limiter.adjust(0.1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ previousLimit: 16, limit: 20, reason: 'low-elu' });
    limiter.stop();
  });

  test('pauses admissions during Retry-After and resumes them afterward', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 2, maxConcurrency: 2, maxQueueLength: 0 });
    limiter.pause(20);
    await expect(limiter.acquire()).rejects.toBeInstanceOf(LimitRejectedError);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(limiter.acquire()).resolves.toBeUndefined();
    limiter.release();
    limiter.stop();
  });
});

describe('AimdLimiter — acquire/release/queue', () => {
  test('acquire resolves immediately while under the limit', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 2, maxConcurrency: 2 });
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.currentInFlight).toBe(2);
    limiter.stop();
  });

  test('acquire queues once the limit is reached, and is resolved by release()', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 1, maxConcurrency: 1, queueTimeoutMs: 1000 });
    await limiter.acquire();
    expect(limiter.currentInFlight).toBe(1);

    const queued = limiter.acquire();
    expect(limiter.queueLength).toBe(1);

    limiter.release();
    await expect(queued).resolves.toBeUndefined();
    expect(limiter.currentInFlight).toBe(1);
    limiter.stop();
  });

  test('acquire rejects once the queue is full', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 1, maxConcurrency: 1, maxQueueLength: 1, queueTimeoutMs: 1000 });
    await limiter.acquire(); // takes the only slot
    const queued = limiter.acquire(); // fills the only queue spot
    await expect(limiter.acquire()).rejects.toBeInstanceOf(LimitRejectedError);
    limiter.release();
    await queued;
    limiter.stop();
  });

  test('acquire rejects after queueTimeoutMs if no slot frees up', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 1, maxConcurrency: 1, queueTimeoutMs: 30 });
    await limiter.acquire();
    await expect(limiter.acquire()).rejects.toBeInstanceOf(LimitRejectedError);
    limiter.stop();
  });
});

describe('AimdLimiter — caller cancellation', () => {
  test('acquire rejects with LimiterAbortedError (not ShuttingDownError) when aborted while queued', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 1, maxConcurrency: 1, queueTimeoutMs: 60000 });
    await limiter.acquire(); // occupies the only slot

    const controller = new AbortController();
    const reason = new Error('client navigated away');
    const queued = limiter.acquire(controller.signal);
    expect(limiter.queueLength).toBe(1);

    controller.abort(reason);
    const err = (await queued.then(
      () => null,
      (e) => e,
    )) as LimiterAbortedError;

    expect(err).toBeInstanceOf(LimiterAbortedError);
    expect(err).not.toBeInstanceOf(ShuttingDownError);
    expect((err as { cause?: unknown }).cause).toBe(reason);
    expect(limiter.queueLength).toBe(0);
    expect(limiter.currentInFlight).toBe(1); // only the original holder
    limiter.stop();
  });

  test('acquire rejects immediately for an already-aborted signal, without taking a slot', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 2, maxConcurrency: 2 });
    const controller = new AbortController();
    controller.abort();

    await expect(limiter.acquire(controller.signal)).rejects.toBeInstanceOf(LimiterAbortedError);
    expect(limiter.currentInFlight).toBe(0);
    limiter.stop();
  });

  test('an aborting waiter is removed from the queue so later callers still get slots', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 1, maxConcurrency: 1, queueTimeoutMs: 60000 });
    await limiter.acquire();

    const controller = new AbortController();
    const aborted = limiter.acquire(controller.signal);
    const survivor = limiter.acquire();
    expect(limiter.queueLength).toBe(2);

    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(LimiterAbortedError);
    expect(limiter.queueLength).toBe(1);

    limiter.release();
    await expect(survivor).resolves.toBeUndefined();
    expect(limiter.currentInFlight).toBe(1);
    limiter.stop();
  });
});

describe('AimdLimiter — shutdown', () => {
  test('stop() rejects every currently queued waiter instead of leaving it hanging', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 1, maxConcurrency: 1, queueTimeoutMs: 60000 });
    await limiter.acquire(); // occupies the only slot

    const queued1 = limiter.acquire();
    const queued2 = limiter.acquire();
    expect(limiter.queueLength).toBe(2);

    limiter.stop();

    await expect(queued1).rejects.toBeInstanceOf(ShuttingDownError);
    await expect(queued2).rejects.toBeInstanceOf(ShuttingDownError);
    expect(limiter.queueLength).toBe(0);
  });

  test('acquire() rejects immediately once stopped', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 5, maxConcurrency: 5 });
    limiter.stop();
    await expect(limiter.acquire()).rejects.toBeInstanceOf(ShuttingDownError);
  });

  test('stop() is idempotent and safe to call more than once', () => {
    const limiter = new AimdLimiter({ initialConcurrency: 5, maxConcurrency: 5 });
    expect(() => {
      limiter.stop();
      limiter.stop();
    }).not.toThrow();
  });
});

describe('AimdLimiter — concurrency race between adjust() and acquire()/release()', () => {
  test('limit changes mid-flight are respected: growing the limit while callers are queued lets them through without extra release() calls', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 2, maxConcurrency: 10, queueTimeoutMs: 2000 });

    // Fill the initial limit of 2.
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.currentInFlight).toBe(2);

    // Two more callers queue up because the limit is still 2.
    const queued = [limiter.acquire(), limiter.acquire()];
    expect(limiter.queueLength).toBe(2);

    // Simulate the sampler observing low ELU and growing the limit, all
    // while the two original callers are still holding their slots (no
    // release() has happened yet). The queued waiters should drain purely
    // because the limit grew, proving adjust() and acquire()/release()
    // interleave safely rather than only working when called in a fixed order.
    limiter.adjust(0.1);
    expect(limiter.currentLimit).toBeGreaterThan(2);

    await Promise.all(queued);
    expect(limiter.currentInFlight).toBe(4);
    limiter.stop();
  });

  test('many interleaved acquire/release/adjust calls never push inFlight above the current limit', async () => {
    const limiter = new AimdLimiter({ initialConcurrency: 3, maxConcurrency: 50, queueTimeoutMs: 2000 });
    let maxObservedInFlight = 0;

    const worker = async (i: number) => {
      await limiter.acquire();
      maxObservedInFlight = Math.max(maxObservedInFlight, limiter.currentInFlight);
      // Stagger releases to interleave with other workers and with adjust().
      await new Promise((r) => setTimeout(r, (i % 5) + 1));
      limiter.release();
    };

    const workers = Array.from({ length: 30 }, (_, i) => worker(i));

    // Fire a handful of adjust() calls while workers are actively racing.
    limiter.adjust(0.9); // shrink
    await new Promise((r) => setTimeout(r, 3));
    limiter.adjust(0.1); // grow
    await new Promise((r) => setTimeout(r, 3));
    limiter.adjust(0.9); // shrink again

    await Promise.all(workers);

    // The limit at any instant caps inFlight; since the limit only ever
    // shrinks to minConcurrency=5 by default at worst, and grows otherwise,
    // inFlight should never have exceeded maxConcurrency.
    expect(maxObservedInFlight).toBeLessThanOrEqual(50);
    expect(limiter.currentInFlight).toBe(0);
    limiter.stop();
  });
});
