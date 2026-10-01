import { EluGuard } from '../../src/core/guard/guard';

/**
 * The architecture guarantee: one guard instance == one protected dependency.
 * Nothing may be shared between instances, otherwise one failing downstream
 * would take unrelated dependencies down with it.
 */
describe('one guard per dependency (independent state)', () => {
  test('two guards keep independent breaker state', async () => {
    const payments = new EluGuard({
      limiter: { initialConcurrency: 3, maxConcurrency: 3 },
      breaker: { failureThreshold: 0.5, minimumRequests: 2 },
    });
    const inventory = new EluGuard({ limiter: { initialConcurrency: 3, maxConcurrency: 3 } });

    const failing = () => Promise.reject(new Error('payments down'));
    await expect(payments.execute(failing)).rejects.toThrow('payments down');
    await expect(payments.execute(failing)).rejects.toThrow('payments down');

    expect(payments.stats().circuitState).toBe('open');
    // The unrelated dependency is untouched: its own breaker stays closed and
    // it keeps serving traffic while payments is failing fast.
    expect(inventory.stats().circuitState).toBe('closed');
    await expect(inventory.execute(async () => 'inventory ok')).resolves.toBe('inventory ok');

    await payments.stop();
    await inventory.stop();
  });

  test('two guards keep independent limiter accounting', async () => {
    const saturated = new EluGuard({
      limiter: { initialConcurrency: 1, maxConcurrency: 1, queueTimeoutMs: 60000 },
    });
    const free = new EluGuard({ limiter: { initialConcurrency: 1, maxConcurrency: 1 } });

    let releaseSaturated: (() => void) | undefined;
    const inFlightCall = saturated.execute(
      () =>
        new Promise<string>((resolve) => {
          releaseSaturated = () => resolve('saturated done');
        }),
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(saturated.stats().inFlight).toBe(1);
    expect(free.stats().inFlight).toBe(0);

    // A queued call on the saturated guard must not block the other dependency.
    const queued = saturated.execute(async () => 'queued done');
    expect(saturated.stats().queueLength).toBe(1);
    await expect(free.execute(async () => 'free done')).resolves.toBe('free done');

    releaseSaturated?.();
    await expect(inFlightCall).resolves.toBe('saturated done');
    await expect(queued).resolves.toBe('queued done');

    await saturated.stop();
    await free.stop();
  });

  test('stopping one guard does not stop the other', async () => {
    const a = new EluGuard({ limiter: { initialConcurrency: 2, maxConcurrency: 2 } });
    const b = new EluGuard({ limiter: { initialConcurrency: 2, maxConcurrency: 2 } });

    await a.stop();

    await expect(a.execute(async () => 'a')).rejects.toThrow();
    await expect(b.execute(async () => 'b')).resolves.toBe('b');
    expect(b.stats().inFlight).toBe(0);

    await b.stop();
  });
});
