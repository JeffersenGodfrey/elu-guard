import { EluGuard } from '../src';

async function main() {
  const minutes = Number(process.env.SOAK_MINUTES ?? 5);
  const deadline = Date.now() + minutes * 60 * 1000;
  const guard = new EluGuard({
    limiter: { minConcurrency: 5, maxConcurrency: 60, sampleIntervalMs: 250, queueTimeoutMs: 2000 },
    breaker: { failureThreshold: 0.5, minimumRequests: 20, resetTimeoutMs: 1000 },
  });
  let completed = 0;
  let failed = 0;
  let maxInFlight = 0;
  const memStart = process.memoryUsage();

  const worker = async (id: number) => {
    while (Date.now() < deadline) {
      try {
        await guard.execute(async ({ signal }) => {
          if (id % 7 === 0) {
            const end = Date.now() + 10;
            while (Date.now() < end) {
              Math.sqrt(id + 1);
            }
          }
          await new Promise((r, rej) => {
            const t = setTimeout(r, 20 + Math.random() * 40);
            signal.addEventListener('abort', () => {
              clearTimeout(t);
              rej(signal.reason ?? new Error('aborted'));
            }, { once: true });
          });
          if (Math.random() < 0.05) throw new Error('downstream blip');
        }, { timeoutMs: 2000 });
        completed++;
      } catch {
        failed++;
      }
      maxInFlight = Math.max(maxInFlight, guard.stats().inFlight);
    }
  };

  await Promise.all(Array.from({ length: 20 }, (_, i) => worker(i)));
  const memEnd = process.memoryUsage();
  const s = guard.stats();
  console.log(`completed=${completed} failed=${failed} maxInFlight=${maxInFlight}`);
  console.log(`final inFlight=${s.inFlight} queue=${s.queueLength} limit=${s.limit} circuit=${s.circuitState}`);
  console.log(`heap ${(memStart.heapUsed / 1e6).toFixed(1)}MB -> ${(memEnd.heapUsed / 1e6).toFixed(1)}MB, rss ${(memStart.rss / 1e6).toFixed(1)}MB -> ${(memEnd.rss / 1e6).toFixed(1)}MB`);
  if (s.inFlight !== 0) {
    console.error('SOAK FAIL: inFlight did not return to 0');
    process.exitCode = 1;
  }
  await guard.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
