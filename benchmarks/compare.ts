import { EluGuard } from '../src';

/** Synchronously blocks the event loop for roughly `ms` milliseconds, simulating CPU-bound work. */
function busyWork(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // intentionally busy
  }
}

interface RunResult {
  label: string;
  concurrency: number;
  totalRequests: number;
  completed: number;
  rejected: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  durationMs: number;
  throughputPerSec: number;
}

async function runScenario(
  label: string,
  guard: EluGuard,
  totalRequests: number,
  concurrency: number,
  workMs: number
): Promise<RunResult> {
  const latencies: number[] = [];
  let completed = 0;
  let rejected = 0;
  const start = Date.now();

  let launched = 0;
  async function worker() {
    while (launched < totalRequests) {
      launched++;
      const reqStart = Date.now();
      try {
        await guard.execute(async () => {
          busyWork(workMs);
        });
        completed++;
        latencies.push(Date.now() - reqStart);
      } catch {
        rejected++;
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  const durationMs = Date.now() - start;

  latencies.sort((a, b) => a - b);
  const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;

  return {
    label,
    concurrency,
    totalRequests,
    completed,
    rejected,
    avgLatencyMs: Math.round(avg),
    p95LatencyMs: Math.round(p95),
    durationMs,
    throughputPerSec: Math.round((completed / durationMs) * 1000 * 100) / 100,
  };
}

async function main() {
  // Simulated concurrent callers hitting the guard directly (in-process).
  // This measures the library's own admission/throughput behavior, not
  // network-level HTTP throughput - see the caveat in benchmarks/README.md.
  const concurrencyLevels = [20, 60, 150];
  const totalRequests = 200;
  const workMs = 8;

  const results: RunResult[] = [];

  for (const concurrency of concurrencyLevels) {
    // Fixed baseline: min === max pins the limit, so it never adapts.
    // Chosen at 30 to sit roughly mid-range of the adaptive run's floor/ceiling.
    const fixed = new EluGuard({
      limiter: { minConcurrency: 30, maxConcurrency: 30, queueTimeoutMs: 4000, maxQueueLength: 5000 },
    });
    results.push(await runScenario('fixed(30)', fixed, totalRequests, concurrency, workMs));
    await fixed.stop();

    const adaptive = new EluGuard({
      limiter: {
        minConcurrency: 5,
        maxConcurrency: 60,
        targetElu: 0.75,
        sampleIntervalMs: 150,
        queueTimeoutMs: 4000,
        maxQueueLength: 5000,
      },
    });
    results.push(await runScenario('adaptive', adaptive, totalRequests, concurrency, workMs));
    await adaptive.stop();
  }

  console.log('\n| Concurrency | Strategy | Completed | Rejected | Avg latency (ms) | p95 latency (ms) | Throughput (req/s) |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of results) {
    console.log(
      `| ${r.concurrency} | ${r.label} | ${r.completed}/${r.totalRequests} | ${r.rejected} | ${r.avgLatencyMs} | ${r.p95LatencyMs} | ${r.throughputPerSec} |`
    );
  }
}

main();
