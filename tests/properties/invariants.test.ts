import * as fc from 'fast-check';
import { AimdLimiter } from '../../src/core/limiter/aimd-limiter';
import { CircuitBreaker } from '../../src/core/breaker/circuit-breaker';
import { EluGuard } from '../../src/core/guard/guard';

describe('invariants (property-based)', () => {
  test('limiter: inFlight stays within [0, limit] under random interleavings', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            op: fc.constantFrom('acquire', 'release', 'adjust-low', 'adjust-high'),
          }),
          { maxLength: 60 },
        ),
        async (steps) => {
          const limiter = new AimdLimiter({
            initialConcurrency: 3,
            minConcurrency: 2,
            maxConcurrency: 8,
            queueTimeoutMs: 5,
          });
          const held: Array<() => void> = [];
          try {
            for (const step of steps) {
              if (step.op === 'acquire') {
                const p = limiter.acquire().then(
                  () => {
                    held.push(() => limiter.release());
                  },
                  () => undefined,
                );
                await Promise.race([p, new Promise((r) => setTimeout(r, 10))]);
              } else if (step.op === 'release') {
                const release = held.pop();
                if (release) release();
              } else if (step.op === 'adjust-low') {
                limiter.adjust(0.1);
              } else {
                limiter.adjust(0.95);
              }
              expect(limiter.currentInFlight).toBeGreaterThanOrEqual(0);
              expect(limiter.currentInFlight).toBeLessThanOrEqual(8);
              expect(limiter.currentLimit).toBeGreaterThanOrEqual(2);
              expect(limiter.currentLimit).toBeLessThanOrEqual(8);
            }
          } finally {
            limiter.stop();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test('breaker: state stays in the valid set and probes are bounded', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('success', 'failure'), { maxLength: 40 }),
        async (outcomes) => {
          const cb = new CircuitBreaker({ failureThreshold: 0.5, minimumRequests: 2, resetTimeoutMs: 5, halfOpenMaxCalls: 1 });
          let liveProbes = 0;
          for (const outcome of outcomes) {
            const admission = cb.tryAcquire();
            if (admission.kind === 'reject') continue;
            if (admission.kind === 'probe') {
              liveProbes++;
              expect(liveProbes).toBeLessThanOrEqual(1);
              if (outcome === 'success') cb.recordSuccess();
              else cb.recordFailure();
              admission.release();
              liveProbes--;
            } else if (outcome === 'success') {
              cb.recordSuccess();
            } else {
              cb.recordFailure();
            }
            expect(['closed', 'open', 'half-open']).toContain(cb.currentState);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test('guard: every acquired permit is eventually released', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom('ok', 'fail', 'slow'),
            timeout: fc.boolean(),
          }),
          { maxLength: 30 },
        ),
        async (calls) => {
          const guard = new EluGuard({
            limiter: { initialConcurrency: 4, maxConcurrency: 4, queueTimeoutMs: 200 },
            breaker: { failureThreshold: 0.9, minimumRequests: 50 },
          });
          try {
            await Promise.all(
              calls.map((call) =>
                guard
                  .execute(
                    async () => {
                      if (call.kind === 'slow') await new Promise((r) => setTimeout(r, 5));
                      if (call.kind === 'fail') throw new Error('downstream');
                      return 1;
                    },
                    call.timeout ? { timeoutMs: 50 } : {},
                  )
                  .then(
                    () => undefined,
                    () => undefined,
                  ),
              ),
            );
            expect(guard.stats().inFlight).toBe(0);
          } finally {
            await guard.stop();
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
