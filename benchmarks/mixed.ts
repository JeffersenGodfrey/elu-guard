import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { EluGuard } from '../src';
import { ConcurrencyLimitError, GuardTimeoutError, CircuitOpenError } from '../src/errors';

/**
 * Mixed-workload benchmark.
 *
 * The first benchmark in this repo (`compare.ts`) drove purely synchronous CPU
 * work. Synchronous CPU work cannot be parallelised by raising a concurrency
 * limit, so that experiment could not have shown an adaptive win - and it
 * correctly showed none. It is kept for history and is not the evidence.
 *
 * This benchmark is the actual test of the claim: the guarded operation is real
 * asynchronous I/O against a local HTTP server (a real socket, and a real
 * AbortSignal path, no external network), while the *service* process is
 * periodically blocked by synchronous CPU spikes. Admission control is only
 * interesting when the event loop - not the downstream - is the scarce resource.
 *
 * Each configuration runs the identical scenario:
 *
 *   steady (no spikes) -> spikes begin -> heavy -> recover
 *
 * and every phase's duration, the caller count and the number of repetitions
 * are configurable, so the same protocol can be run longer:
 *
 *   BENCH_REPS=3 npm run bench
 *   BENCH_REPS=5 BENCH_PHASE_MS=10000 npm run bench
 *
 * Metrics are per-metric medians across repetitions, so a single noisy run
 * cannot decide the story.
 *
 * Requires Node 18+ for global fetch.
 */

const PHASE_MS = Number(process.env.BENCH_PHASE_MS ?? 5000);
const REPS = Number(process.env.BENCH_REPS ?? 1);
const CALLERS = Number(process.env.BENCH_CALLERS ?? 40);
const DOWNSTREAM_MIN_MS = 80;
const DOWNSTREAM_MAX_MS = 160;
const REQUEST_TIMEOUT_MS = 5000;

interface Phase {
  name: string;
  durationMs: number;
  /** Block the event loop for cpuSpikeMs, then wait cpuSpikeEveryMs before doing it again. */
  cpuSpikeEveryMs: number;
  cpuSpikeMs: number;
}

function buildPhases(): Phase[] {
  return [
    { name: 'steady', durationMs: PHASE_MS, cpuSpikeEveryMs: 0, cpuSpikeMs: 0 },
    { name: 'spikes', durationMs: PHASE_MS, cpuSpikeEveryMs: 500, cpuSpikeMs: 60 },
    { name: 'heavy', durationMs: PHASE_MS, cpuSpikeEveryMs: 250, cpuSpikeMs: 90 },
    { name: 'recover', durationMs: PHASE_MS, cpuSpikeEveryMs: 0, cpuSpikeMs: 0 },
  ];
}

let sink = 0;

/** Synchronous CPU spike: this is the event-loop pressure the limiter reacts to. */
function busyWork(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    sink += Math.sqrt(Math.random());
  }
  void sink;
}

interface Downstream {
  url: (ms: number) => string;
  close: () => Promise<void>;
}

async function startDownstream(): Promise<Downstream> {
  const server: Server = createServer((req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    const ms = Number(parsed.searchParams.get('ms') ?? 100);
    const timer = setTimeout(() => {
      res.statusCode = 200;
      res.end('ok');
    }, ms);
    // The guarded client cancels its request on timeout; drop the pending work
    // so cancelled requests do not keep the downstream busy for free.
    res.on('close', () => clearTimeout(timer));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;

  return {
    url: (ms: number) => `http://127.0.0.1:${port}/work?ms=${ms}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface ScenarioResult {
  label: string;
  completed: number;
  limiterRejected: number;
  circuitRejected: number;
  timedOut: number;
  errors: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
  avgElu: number;
  peakElu: number;
  eventLoopDelayMs: number;
  avgInFlight: number;
  peakInFlight: number;
}

async function runScenario(
  label: string,
  makeGuard: () => EluGuard,
  downstream: Downstream,
): Promise<ScenarioResult> {
  const guard = makeGuard();
  const latencies: number[] = [];
  const eluSamples: number[] = [];
  const inFlightSamples: number[] = [];
  let completed = 0;
  let limiterRejected = 0;
  let circuitRejected = 0;
  let timedOut = 0;
  let errors = 0;
  let stop = false;

  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();

  const sampler = setInterval(() => {
    const s = guard.stats();
    eluSamples.push(s.elu);
    inFlightSamples.push(s.inFlight);
  }, 100);

  const phaseRef: { current: Phase | null } = { current: null };
  const spikeLoop = (async () => {
    while (!stop) {
      const phase = phaseRef.current;
      if (phase && phase.cpuSpikeEveryMs > 0) {
        busyWork(phase.cpuSpikeMs);
        await new Promise((r) => setTimeout(r, phase.cpuSpikeEveryMs));
      } else {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  })();

  const startedAt = Date.now();

  const callerLoop = async () => {
    while (!stop) {
      const t0 = Date.now();
      const ms = Math.round(DOWNSTREAM_MIN_MS + Math.random() * (DOWNSTREAM_MAX_MS - DOWNSTREAM_MIN_MS));
      try {
        const res = await guard.execute(({ signal }) => fetch(downstream.url(ms), { signal }), {
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        await res.arrayBuffer();
        completed++;
        latencies.push(Date.now() - t0);
      } catch (err) {
        if (err instanceof GuardTimeoutError) timedOut++;
        else if (err instanceof CircuitOpenError) circuitRejected++;
        else if (err instanceof ConcurrencyLimitError) limiterRejected++;
        else errors++;
      }
    }
  };

  const callers = Array.from({ length: CALLERS }, () => callerLoop());

  for (const phase of buildPhases()) {
    phaseRef.current = phase;
    await new Promise((r) => setTimeout(r, phase.durationMs));
  }
  stop = true;
  await Promise.all(callers);
  await spikeLoop;
  clearInterval(sampler);
  const durationSec = (Date.now() - startedAt) / 1000;
  loopDelay.disable();
  await guard.stop();

  return {
    label,
    completed,
    limiterRejected,
    circuitRejected,
    timedOut,
    errors,
    throughput: completed / durationSec,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    avgElu: mean(eluSamples),
    peakElu: eluSamples.length ? Math.max(...eluSamples) : 0,
    eventLoopDelayMs: loopDelay.max / 1e6,
    avgInFlight: mean(inFlightSamples),
    peakInFlight: inFlightSamples.length ? Math.max(...inFlightSamples) : 0,
  };
}

interface Config {
  label: string;
  makeGuard: () => EluGuard;
}

const CONFIGS: Config[] = [
  {
    label: 'fixed-low(10)',
    makeGuard: () =>
      new EluGuard({
        limiter: { minConcurrency: 10, maxConcurrency: 10, queueTimeoutMs: 2000, maxQueueLength: 5000 },
        breaker: { minimumRequests: 100000 }, // isolate the limiter: never trip
      }),
  },
  {
    label: 'fixed-high(100)',
    makeGuard: () =>
      new EluGuard({
        limiter: { minConcurrency: 100, maxConcurrency: 100, queueTimeoutMs: 2000, maxQueueLength: 5000 },
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
          sampleIntervalMs: 250,
          queueTimeoutMs: 2000,
          maxQueueLength: 5000,
        },
        breaker: { minimumRequests: 100000 },
      }),
  },
];

function aggregate(label: string, runs: ScenarioResult[]): ScenarioResult {
  const pick = (key: keyof ScenarioResult) => median(runs.map((r) => r[key] as number));
  return {
    label,
    completed: pick('completed'),
    limiterRejected: pick('limiterRejected'),
    circuitRejected: pick('circuitRejected'),
    timedOut: pick('timedOut'),
    errors: pick('errors'),
    throughput: pick('throughput'),
    p50: pick('p50'),
    p95: pick('p95'),
    p99: pick('p99'),
    avgElu: pick('avgElu'),
    peakElu: pick('peakElu'),
    eventLoopDelayMs: pick('eventLoopDelayMs'),
    avgInFlight: pick('avgInFlight'),
    peakInFlight: pick('peakInFlight'),
  };
}

function printTable(rows: ScenarioResult[]): void {
  const r = (n: number) => String(Math.round(n * 100) / 100);
  console.log(
    '\n| config | completed | limiter-rejected | timed-out | errors | req/s | p50 ms | p95 ms | p99 ms | avg ELU | peak ELU | max loop delay ms | avg in-flight | peak in-flight |',
  );
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    console.log(
      `| ${row.label} | ${row.completed} | ${row.limiterRejected} | ${row.timedOut} | ${row.errors} | ${r(row.throughput)} | ${r(row.p50)} | ${r(row.p95)} | ${r(row.p99)} | ${r(row.avgElu)} | ${r(row.peakElu)} | ${r(row.eventLoopDelayMs)} | ${r(row.avgInFlight)} | ${row.peakInFlight} |`,
    );
  }
}

async function main(): Promise<void> {
  const downstream = await startDownstream();
  const perConfig = new Map<string, ScenarioResult[]>(CONFIGS.map((c) => [c.label, []]));

  try {
    for (let rep = 0; rep < REPS; rep++) {
      for (const config of CONFIGS) {
        const result = await runScenario(config.label, config.makeGuard, downstream);
        perConfig.get(config.label)!.push(result);
      }
      console.log(`repetition ${rep + 1}/${REPS} done`);
    }
  } finally {
    await downstream.close();
  }

  const rows = CONFIGS.map((c) => aggregate(c.label, perConfig.get(c.label)!));
  console.log(
    `\nPer-metric medians over ${REPS} repetition(s); phases: ${buildPhases()
      .map((p) => `${p.name}=${p.durationMs}ms`)
      .join(', ')}; callers=${CALLERS}; downstream=${DOWNSTREAM_MIN_MS}-${DOWNSTREAM_MAX_MS}ms`,
  );
  printTable(rows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
