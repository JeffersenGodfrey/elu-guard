import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { EluGuard } from '../src';
import { ConcurrencyLimitError, GuardTimeoutError, CircuitOpenError } from '../src/errors';

// The hypothesis under test: when the event loop saturates, an adaptive limit
// that backs off preserves tail latency better than a fixed-high limit that
// keeps admitting work. A fixed-low limit is expected to win on tail latency
// but lose badly on throughput; the question is where adaptive lands.
//
// Methodology constraints, stated up front so the table below reads honestly:
//   - CPU pressure runs IN this process (see burnCpuSlice, wired into each
//     idle gap between requests). The load generator and the guarded service
//     share one process by design: the driver *is* the service. Because ELU
//     measures *this* process's loop, in-process pressure is the signal under
//     test. The only thing forked out is the downstream server, so dependency
//     latency stays clean while the service loop saturates.
//   - A warmup phase runs per config and is discarded, so JIT and ELU settle
//     before measurement.
//   - Driver and guarded service share this process by design: the loop that
//     burns CPU is the loop the guard samples. Cost of honesty: load
//     generation competes with the service for the loop, so read phase
//     *deltas*, not absolutes, as the result.
//   - Configurations run back-to-back inside one process (fixed-low, then
//     fixed-high, then adaptive), so a slow machine drift can bias late
//     configs. Repetitions (median) dampen this; interleave elsewhere if you
//     need stricter ordering guarantees.
//   - Only latencies of *completed* calls enter p50/p95/p99. Guard rejections
//     (queue timeout / circuit / deadline) are counted separately, not as
//     zero-latency samples and not folded into percentiles. Treat the two
//     together: a great p95 with a 40% rejection rate is not a win.
//
// Run it: npm run bench
// Slower, more stable runs: BENCH_REPS=5 BENCH_PHASES_MS='10000,15000,15000,10000,10000' npm run bench

const REPS = Number(process.env.BENCH_REPS ?? 3);
// steady, warmup-extra is derived from steady (see buildPhases)
const PHASES_MS = (process.env.BENCH_PHASES_MS ?? '5000,5000,8000,8000,5000').split(',').map(Number);
const CALLERS = Number(process.env.BENCH_CALLERS ?? 220);
const REQUEST_TIMEOUT_MS = 5000;
// Downstream latency (ms), mirrored into startDownstream(). The in-process
// burn slice scales against this: at duty d each caller blocks ≈d downstream
// round trips per iteration, and aggregate burn scales with CALLERS.
const DOWNSTREAM_LATENCY_MS = 30;

interface Phase {
  name: string;
  durationMs: number;
  duty: number;
  measure: boolean;
}

function buildPhases(): Phase[] {
  // Duties are per-caller burn multipliers, so total pressure scales with
  // CALLERS: duty 0.3 at 220 callers ≈ 66 concurrent burners' worth of load
  // against a 30ms downstream. That pins ELU near 1.0 without starving the
  // loop so badly the sampler itself stops ticking.
  return [
    { name: 'warmup', durationMs: PHASES_MS[0] ?? 5000, duty: 0, measure: false },
    { name: 'steady', durationMs: PHASES_MS[1] ?? 5000, duty: 0, measure: true },
    { name: 'pressure', durationMs: PHASES_MS[2] ?? 8000, duty: 0.3, measure: true },
    { name: 'heavy', durationMs: PHASES_MS[3] ?? 8000, duty: 0.6, measure: true },
    { name: 'recover', durationMs: PHASES_MS[4] ?? 5000, duty: 0, measure: true },
  ];
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface PhaseStats {
  completed: number;
  rejected: number;
  errors: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
  avgElu: number;
  avgLoopDelayMs: number;
  maxInFlight: number;
  avgLimit: number;
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
        breaker: { minimumRequests: 100000 },
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
          // Fast sampling is bench-only tuning: with 4-8s phases the default
          // 1s cadence would barely react before the phase ends. An operator
          // facing bursty load would do the same.
          sampleIntervalMs: 100,
          queueTimeoutMs: 2000,
          maxQueueLength: 5000,
        },
        breaker: { minimumRequests: 100000 },
      }),
  },
];

function startDownstream(): Promise<{ url: string; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [join(__dirname, 'downstream-server.mjs')],
      { env: { ...process.env, DOWNSTREAM_MS: String(DOWNSTREAM_LATENCY_MS) } },
      () => undefined,
    );
    let settled = false;
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      const match = /LISTENING (\d+)/.exec(chunk.toString());
      if (match && !settled) {
        settled = true;
        resolve({
          url: `http://127.0.0.1:${match[1]}/`,
          stop: () =>
            new Promise<void>((done) => {
              child.kill();
              done();
            }),
        });
      }
    });
    child.on('error', fail);
    setTimeout(() => fail(new Error('downstream did not start')), 10000).unref?.();
  });
}

// CPU pressure must saturate *this* process (where the guard samples ELU)
// without touching the downstream process. A forked child cannot do that: it
// burns a different core/loop. So pressure is an in-process burn, applied in
// each caller loop after every request; the forked helper is gone.
let pressureDuty = 0;

function setPressure(duty: number): void {
  pressureDuty = duty;
}

/**
 * Synchronously burns `ms` of this thread. Called from each caller loop after
 * every request, so the duty fraction of wall time is spent with the event
 * loop blocked - which is exactly what ELU and loop-delay observe. The
 * `fetch` to the forked downstream server still costs real I/O latency, but
 * the saturation signal is local.
 */
function burnCpuSlice(ms: number): void {
  if (ms <= 0) return;
  const end = performance.now() + ms;
  let acc = 0;
  while (performance.now() < end) acc += Math.sqrt(acc + 1);
  // Keep V8 honest: a provably-dead loop may be eliminated.
  if (acc === -1) console.log(acc);
}

async function runScenario(makeGuard: () => EluGuard, url: string): Promise<Map<string, PhaseStats>> {
  const guard = makeGuard();
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const results = new Map<string, PhaseStats>();
  let stop = false;
  let completed: number[] = [];
  let rejected = 0;
  let errors = 0;

  const caller = async () => {
    while (!stop) {
      const t0 = performance.now();
      try {
        const res = await guard.execute(({ signal }) => fetch(url, { signal }), { timeoutMs: REQUEST_TIMEOUT_MS });
        await res.arrayBuffer();
        completed.push(performance.now() - t0);
      } catch (err) {
        if (err instanceof ConcurrencyLimitError || err instanceof CircuitOpenError || err instanceof GuardTimeoutError) {
          rejected++;
        } else {
          errors++;
        }
      }
      // In-process saturation: burn a duty fraction of each iteration so the
      // *service* loop (this one) saturates while downstream stays clean.
      // Slice scales with downstream latency and pressure duty; aggregate
      // burn scales with CALLERS, so a duty of 0.3 at 220 callers ≈ 66
      // burners' worth of load per downstream round trip.
      burnCpuSlice(pressureDuty * DOWNSTREAM_LATENCY_MS);
    }
  };

  const callers = Array.from({ length: CALLERS }, () => caller());

  for (const p of buildPhases()) {
    setPressure(p.duty);
    completed = [];
    rejected = 0;
    errors = 0;
    const eluSamples: number[] = [];
    const limitSamples: number[] = [];
    let maxInFlight = 0;
    loopDelay.reset();
    const sampler = setInterval(() => {
      const s = guard.stats();
      eluSamples.push(s.elu);
      limitSamples.push(s.limit);
      if (s.inFlight > maxInFlight) maxInFlight = s.inFlight;
    }, 100);
    await new Promise((r) => setTimeout(r, p.durationMs));
    clearInterval(sampler);
    const stats: PhaseStats = {
      completed: completed.length,
      rejected,
      errors,
      throughput: completed.length / (p.durationMs / 1000),
      p50: percentile(completed, 0.5),
      p95: percentile(completed, 0.95),
      p99: percentile(completed, 0.99),
      avgElu: eluSamples.length ? eluSamples.reduce((a, b) => a + b, 0) / eluSamples.length : 0,
      avgLoopDelayMs: loopDelay.mean / 1e6,
      maxInFlight,
      avgLimit: limitSamples.length ? limitSamples.reduce((a, b) => a + b, 0) / limitSamples.length : 0,
    };
    if (p.measure) results.set(p.name, stats);
  }

  stop = true;
  setPressure(0);
  await Promise.all(callers);
  loopDelay.disable();
  await guard.stop();
  return results;
}

async function main(): Promise<void> {
  const downstream = await startDownstream();
  const perConfig = new Map<string, Array<Map<string, PhaseStats>>>(CONFIGS.map((c) => [c.label, []]));
  try {
    for (let rep = 0; rep < REPS; rep++) {
      for (const config of CONFIGS) {
        perConfig.get(config.label)!.push(await runScenario(config.makeGuard, downstream.url));
      }
      console.log(`repetition ${rep + 1}/${REPS} done`);
    }
  } finally {
    setPressure(0);
    await downstream.stop();
  }

  console.log(`\nPer-phase medians over ${REPS} repetition(s); callers=${CALLERS}; downstream=${DOWNSTREAM_LATENCY_MS}ms in a separate process; pressure is in-process CPU burn`);
  console.log('| phase | config | req/s | p50 ms | p95 ms | p99 ms | rejected | errors | avg ELU | avg loop-delay ms | avg limit | max in-flight |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const phase of buildPhases()
    .filter((p) => p.measure)
    .map((p) => p.name)) {
    for (const config of CONFIGS) {
      const runs = perConfig.get(config.label)!.map((m) => m.get(phase)!);
      const pick = (key: keyof PhaseStats) => median(runs.map((r) => r[key]));
      console.log(
        `| ${phase} | ${config.label} | ${pick('throughput').toFixed(1)} | ${pick('p50').toFixed(0)} | ${pick('p95').toFixed(0)} | ${pick('p99').toFixed(0)} | ${pick('rejected').toFixed(0)} | ${pick('errors').toFixed(0)} | ${pick('avgElu').toFixed(2)} | ${pick('avgLoopDelayMs').toFixed(1)} | ${pick('avgLimit').toFixed(0)} | ${pick('maxInFlight').toFixed(0)} |`,
      );
    }
  }
}

main().catch((err) => {
  setPressure(0);
  console.error(err);
  process.exit(1);
});
