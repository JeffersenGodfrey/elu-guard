import { EluGuard } from '../src';

const CALLERS = Number(process.env.BENCH_CALLERS ?? 40);
const RUN_MS = Number(process.env.BENCH_RUN_MS ?? 12000);
const REPS = Number(process.env.BENCH_REPS ?? 3);
const SPIKE_EVERY_MS = Number(process.env.BENCH_SPIKE_EVERY_MS ?? 500);
const SPIKE_MS = Number(process.env.BENCH_SPIKE_MS ?? 120);
const TASK_MS = Number(process.env.BENCH_TASK_MS ?? 20);

function busyWork(ms: number): void {
  const end = Date.now() + ms;
  let acc = 0;
  while (Date.now() < end) {
    acc += Math.sqrt(acc + 1) + Math.random();
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

async function runScenario(label: string, makeGuard: () => EluGuard): Promise<{
  label: string;
  completed: number;
  rejected: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
  maxDelay: number;
}> {
  const guard = makeGuard();
  const latencies: number[] = [];
  let completed = 0;
  let rejected = 0;
  const startedAt = Date.now();
  const deadline = startedAt + RUN_MS;
  const pressure = setInterval(() => busyWork(SPIKE_MS), SPIKE_EVERY_MS);

  const workers = Array.from({ length: CALLERS }, async () => {
    while (Date.now() < deadline) {
      const t0 = Date.now();
      try {
        await guard.execute(async () => {
          busyWork(TASK_MS + Math.random() * 15);
        }, { timeoutMs: 5000 });
        completed++;
        latencies.push(Date.now() - t0);
      } catch {
        rejected++;
      }
    }
  });

  await Promise.all(workers);
  clearInterval(pressure);
  await guard.stop();

  const elapsedSec = (Date.now() - startedAt) / 1000;
  return {
    label,
    completed,
    rejected,
    throughput: completed / elapsedSec,
    p50: median(latencies),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    maxDelay: Math.max(...latencies, 0),
  };
}

async function main(): Promise<void> {
  const configs = [
    {
      label: 'fixed-low(10)',
      makeGuard: () =>
        new EluGuard({
          limiter: {
            minConcurrency: 10,
            maxConcurrency: 10,
            queueTimeoutMs: 2000,
            maxQueueLength: 5000,
          },
        }),
    },
    {
      label: 'fixed-high(100)',
      makeGuard: () =>
        new EluGuard({
          limiter: {
            minConcurrency: 100,
            maxConcurrency: 100,
            queueTimeoutMs: 2000,
            maxQueueLength: 5000,
          },
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
            sampleIntervalMs: 150,
            hysteresis: 0.15,
            queueTimeoutMs: 2000,
            maxQueueLength: 5000,
          },
        }),
    },
  ];

  const runs: Record<string, Array<{ label: string; completed: number; rejected: number; throughput: number; p50: number; p95: number; p99: number; maxDelay: number }>> = {};

  for (let rep = 0; rep < REPS; rep++) {
    for (const config of configs) {
      const result = await runScenario(config.label, config.makeGuard);
      runs[config.label] ??= [];
      runs[config.label].push(result);
    }
    console.log(`rep ${rep + 1}/${REPS} complete`);
  }

  const medians = Object.entries(runs).map(([label, values]) => {
    const pick = (key: keyof (typeof values)[number]) => median(values.map((v) => v[key] as number));
    return {
      label,
      completed: pick('completed'),
      rejected: pick('rejected'),
      throughput: pick('throughput'),
      p50: pick('p50'),
      p95: pick('p95'),
      p99: pick('p99'),
      maxDelay: pick('maxDelay'),
    };
  });

  console.log('\n| config | completed | rejected | throughput | p50 ms | p95 ms | p99 ms | max delay ms |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of medians) {
    console.log(
      `| ${row.label} | ${row.completed} | ${row.rejected} | ${row.throughput.toFixed(2)} | ${row.p50.toFixed(0)} | ${row.p95.toFixed(0)} | ${row.p99.toFixed(0)} | ${row.maxDelay.toFixed(0)} |`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
