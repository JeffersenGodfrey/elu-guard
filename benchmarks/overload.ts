import { EluGuard } from '../src';
import { ConcurrencyLimitError, GuardTimeoutError, CircuitOpenError } from '../src/errors';

const RUN_MS = Number(process.env.BENCH_RUN_MS ?? 20000);
const HEAVY_WORKERS = Number(process.env.BENCH_HEAVY_WORKERS ?? 250);
const CHEAP_WORKERS = Number(process.env.BENCH_CHEAP_WORKERS ?? 50);
const BURST_INTERVAL_MS = Number(process.env.BENCH_BURST_INTERVAL_MS ?? 60);
const BURST_CPU_MS = Number(process.env.BENCH_BURST_CPU_MS ?? 40);
const TASK_CPU_MS = Number(process.env.BENCH_TASK_CPU_MS ?? 80);
const QUEUE_TIMEOUT_MS = Number(process.env.BENCH_QUEUE_TIMEOUT_MS ?? 100);

function busyWork(ms: number): void {
  const end = Date.now() + ms;
  let acc = 0;
  while (Date.now() < end) {
    acc += Math.sqrt(acc + 1) + Math.random();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

interface ScenarioSummary {
  label: string;
  accepted: number;
  rejected: number;
  throughput: number;
  totalLatencyP50: number;
  totalLatencyP95: number;
  queueDelayP50: number;
  queueDelayP95: number;
  timeToRejectP50: number;
  timeToRejectP95: number;
  heapMb: number;
  rssMb: number;
}

async function runNoProtection(): Promise<ScenarioSummary> {
  const startedAt = Date.now();
  const deadline = startedAt + RUN_MS;
  const accepted: number[] = [];
  const rejected: number[] = [];
  const queueDelays: number[] = [];
  const memoryBefore = process.memoryUsage();

  const cheap = Array.from({ length: CHEAP_WORKERS }, async () => {
    while (Date.now() < deadline) {
      await sleep(25 + Math.random() * 25);
    }
  });

  const heavy = Array.from({ length: HEAVY_WORKERS }, async () => {
    while (Date.now() < deadline) {
      const invokedAt = Date.now();
      const startedAtActual = Date.now();
      busyWork(TASK_CPU_MS);
      const latency = Date.now() - invokedAt;
      accepted.push(latency);
      queueDelays.push(Math.max(0, startedAtActual - invokedAt));
    }
  });

  const burst = setInterval(() => {
    if (Date.now() >= deadline) return;
    const workers = Array.from({ length: 12 }, async () => {
      const invokedAt = Date.now();
      busyWork(BURST_CPU_MS);
      if (Date.now() - invokedAt > 0) accepted.push(Date.now() - invokedAt);
    });
    void Promise.all(workers);
  }, BURST_INTERVAL_MS);

  await Promise.all([...cheap, ...heavy]);
  clearInterval(burst);

  const memoryAfter = process.memoryUsage();

  return {
    label: 'no-protection',
    accepted: accepted.length,
    rejected: rejected.length,
    throughput: accepted.length / (RUN_MS / 1000),
    totalLatencyP50: median(accepted),
    totalLatencyP95: percentile(accepted, 0.95),
    queueDelayP50: median(queueDelays),
    queueDelayP95: percentile(queueDelays, 0.95),
    timeToRejectP50: 0,
    timeToRejectP95: 0,
    heapMb: (memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024 / 1024,
    rssMb: (memoryAfter.rss - memoryBefore.rss) / 1024 / 1024,
  };
}

async function runGuardedScenario(label: string, makeGuard: () => EluGuard): Promise<ScenarioSummary> {
  const guard = makeGuard();
  const startedAt = Date.now();
  const deadline = startedAt + RUN_MS;
  const totalLatencies: number[] = [];
  const queueDelays: number[] = [];
  const rejectTimes: number[] = [];
  const memoryBefore = process.memoryUsage();

  const cheap = Array.from({ length: CHEAP_WORKERS }, async () => {
    while (Date.now() < deadline) {
      await sleep(25 + Math.random() * 25);
    }
  });

  const tasks: Promise<void>[] = [];
  const burst = setInterval(() => {
    if (Date.now() >= deadline) return;
    for (let i = 0; i < HEAVY_WORKERS; i++) {
      const invokedAt = Date.now();
      const p = guard.execute(async () => {
        const executionStart = Date.now();
        queueDelays.push(executionStart - invokedAt);
        busyWork(TASK_CPU_MS);
        totalLatencies.push(Date.now() - invokedAt);
      }, { timeoutMs: QUEUE_TIMEOUT_MS + 200 }).catch((err) => {
        rejectTimes.push(Date.now() - invokedAt);
        if (!(err instanceof ConcurrencyLimitError || err instanceof GuardTimeoutError || err instanceof CircuitOpenError)) {
          throw err;
        }
      });
      tasks.push(p);
    }
  }, BURST_INTERVAL_MS);

  await Promise.all([...cheap, ...tasks]);
  clearInterval(burst);
  await guard.stop();

  const memoryAfter = process.memoryUsage();

  return {
    label,
    accepted: totalLatencies.length,
    rejected: rejectTimes.length,
    throughput: totalLatencies.length / (RUN_MS / 1000),
    totalLatencyP50: median(totalLatencies),
    totalLatencyP95: percentile(totalLatencies, 0.95),
    queueDelayP50: median(queueDelays),
    queueDelayP95: percentile(queueDelays, 0.95),
    timeToRejectP50: median(rejectTimes),
    timeToRejectP95: percentile(rejectTimes, 0.95),
    heapMb: (memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024 / 1024,
    rssMb: (memoryAfter.rss - memoryBefore.rss) / 1024 / 1024,
  };
}

async function main(): Promise<void> {
  const scenarios = [
    {
      label: 'fixed-low(10)',
      makeGuard: () =>
        new EluGuard({
          limiter: {
            minConcurrency: 10,
            maxConcurrency: 10,
            targetElu: 0.8,
            sampleIntervalMs: 100,
            queueTimeoutMs: QUEUE_TIMEOUT_MS,
            maxQueueLength: 2000,
          },
          breaker: { minimumRequests: 100000 },
        }),
    },
    {
      label: 'fixed-high(50)',
      makeGuard: () =>
        new EluGuard({
          limiter: {
            minConcurrency: 50,
            maxConcurrency: 50,
            targetElu: 0.8,
            sampleIntervalMs: 100,
            queueTimeoutMs: QUEUE_TIMEOUT_MS,
            maxQueueLength: 2000,
          },
          breaker: { minimumRequests: 100000 },
        }),
    },
    {
      label: 'adaptive(5..50)',
      makeGuard: () =>
        new EluGuard({
          limiter: {
            minConcurrency: 5,
            maxConcurrency: 50,
            targetElu: 0.7,
            hysteresis: 0.15,
            sampleIntervalMs: 120,
            queueTimeoutMs: QUEUE_TIMEOUT_MS,
            maxQueueLength: 2000,
          },
          breaker: { minimumRequests: 100000 },
        }),
    },
  ];

  const results = [await runNoProtection(), ... (await Promise.all(scenarios.map((s) => runGuardedScenario(s.label, s.makeGuard))))];

  console.log('\n| config | accepted | rejected | throughput | p50 total ms | p95 total ms | p50 queue ms | p95 queue ms | p50 reject ms | p95 reject ms | heap delta MB | rss delta MB |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of results) {
    console.log(
      `| ${row.label} | ${row.accepted} | ${row.rejected} | ${(row.throughput ?? 0).toFixed(2)} | ${row.totalLatencyP50.toFixed(1)} | ${row.totalLatencyP95.toFixed(1)} | ${row.queueDelayP50.toFixed(1)} | ${row.queueDelayP95.toFixed(1)} | ${row.timeToRejectP50.toFixed(1)} | ${row.timeToRejectP95.toFixed(1)} | ${row.heapMb.toFixed(2)} | ${row.rssMb.toFixed(2)} |`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
