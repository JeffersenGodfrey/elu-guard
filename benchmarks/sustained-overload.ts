import { EluGuard } from '../src';

const TOTAL_JOBS = Number(process.env.BENCH_TOTAL_JOBS ?? 2000);
const JOB_CPU_MS = Number(process.env.BENCH_JOB_CPU_MS ?? 80);
const QUEUE_TIMEOUT_MS = Number(process.env.BENCH_QUEUE_TIMEOUT_MS ?? 10);
const DEADLINE_MS = Number(process.env.BENCH_DEADLINE_MS ?? 80);
const SAMPLE_EVERY_MS = Number(process.env.BENCH_SAMPLE_EVERY_MS ?? 250);

function busyWork(ms: number): void {
  const end = Date.now() + ms;
  let acc = 0;
  while (Date.now() < end) {
    acc += Math.sqrt(acc + 1) + Math.random();
  }
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

interface ScenarioResult {
  label: string;
  completed: number;
  rejected: number;
  throughput: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  peakQueue: number;
  p95Queue: number;
  peakRssMb: number;
  peakHeapMb: number;
}

async function runScenario(label: string, makeGuard: (() => EluGuard) | null): Promise<ScenarioResult> {
  const guard = makeGuard ? makeGuard() : null;
  const start = Date.now();
  const latencies: number[] = [];
  const queueSamples: number[] = [];
  const rssSamples: number[] = [];
  const heapSamples: number[] = [];
  let completed = 0;
  let rejected = 0;
  let peakQueue = 0;

  const sample = () => {
    const mem = process.memoryUsage();
    const queueLength = guard?.stats().queueLength ?? 0;
    queueSamples.push(queueLength);
    rssSamples.push(mem.rss / 1024 / 1024);
    heapSamples.push(mem.heapUsed / 1024 / 1024);
    peakQueue = Math.max(peakQueue, queueLength);
  };

  const sampler = setInterval(sample, SAMPLE_EVERY_MS);
  const tasks = Array.from({ length: TOTAL_JOBS }, () => {
    const scheduledAt = Date.now();
    return (async () => {
      try {
        if (guard) {
          await guard.execute(async () => {
            busyWork(JOB_CPU_MS);
          }, { timeoutMs: DEADLINE_MS });
        } else {
          busyWork(JOB_CPU_MS);
        }
        completed++;
        latencies.push(Date.now() - scheduledAt);
      } catch {
        rejected++;
      }
    })();
  });

  await Promise.all(tasks);
  clearInterval(sampler);
  sample();
  if (guard) await guard.stop();

  const elapsedSec = (Date.now() - start) / 1000;

  return {
    label,
    completed,
    rejected,
    throughput: completed / elapsedSec,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    peakQueue,
    p95Queue: percentile(queueSamples, 0.95),
    peakRssMb: Math.max(...rssSamples),
    peakHeapMb: Math.max(...heapSamples),
  };
}

async function main(): Promise<void> {
  const scenarios = [
    {
      label: 'no-limiter',
      makeGuard: null,
    },
    {
      label: 'fixed-high(100)',
      makeGuard: () =>
        new EluGuard({
          limiter: {
            minConcurrency: 100,
            maxConcurrency: 100,
            targetElu: 0.8,
            sampleIntervalMs: 50,
            queueTimeoutMs: QUEUE_TIMEOUT_MS,
            maxQueueLength: 200,
          },
          breaker: { minimumRequests: 100000 },
        }),
    },
    {
      label: 'adaptive(5..100)',
      makeGuard: () =>
        new EluGuard({
          limiter: {
            minConcurrency: 5,
            maxConcurrency: 100,
            targetElu: 0.7,
            hysteresis: 0.15,
            sampleIntervalMs: 50,
            queueTimeoutMs: QUEUE_TIMEOUT_MS,
            maxQueueLength: 200,
          },
          breaker: { minimumRequests: 100000 },
        }),
    },
  ];

  const results = await Promise.all(scenarios.map((cfg) => runScenario(cfg.label, cfg.makeGuard)));

  console.log('\n| config | completed | rejected | throughput/s | p50 latency | p95 latency | peak queue | p95 queue | peak rss MB | peak heap MB |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of results) {
    console.log(
      `| ${row.label} | ${row.completed} | ${row.rejected} | ${row.throughput.toFixed(2)} | ${row.p50LatencyMs.toFixed(1)} | ${row.p95LatencyMs.toFixed(1)} | ${row.peakQueue} | ${row.p95Queue} | ${row.peakRssMb.toFixed(1)} | ${row.peakHeapMb.toFixed(1)} |`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
