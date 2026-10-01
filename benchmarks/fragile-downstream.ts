import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { EluGuard } from '../src';
import { ConcurrencyLimitError, CircuitOpenError, GuardTimeoutError } from '../src/errors';

const RUN_MS = Number(process.env.BENCH_RUN_MS ?? 15000);
const CALLERS = Number(process.env.BENCH_CALLERS ?? 100);
const DOWNSTREAM_CAP = Number(process.env.BENCH_DOWNSTREAM_CAP ?? 20);
const DOWNSTREAM_MS = Number(process.env.BENCH_DOWNSTREAM_MS ?? 40);
const REQUEST_TIMEOUT_MS = Number(process.env.BENCH_REQUEST_TIMEOUT_MS ?? 1000);

interface Downstream {
  url: string;
  close: () => Promise<void>;
  stats: () => { overloads: number; peakActive: number };
}

function startDownstream(): Promise<Downstream> {
  return new Promise((resolve) => {
    let active = 0;
    let overloads = 0;
    let peakActive = 0;
    const server: Server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      if (active >= DOWNSTREAM_CAP) {
        overloads++;
        res.statusCode = 429;
        res.end('downstream overloaded');
        return;
      }

      active++;
      peakActive = Math.max(peakActive, active);
      let finished = false;
      const timer = setTimeout(() => {
        finished = true;
        active--;
        res.statusCode = 200;
        res.end('ok');
      }, DOWNSTREAM_MS);
      res.on('close', () => {
        clearTimeout(timer);
        if (!finished) active--;
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/work`,
        close: () => new Promise<void>((done) => server.close(() => done())),
        stats: () => ({ overloads, peakActive }),
      });
    });
  });
}

interface ScenarioResult {
  label: string;
  successful: number;
  downstreamRejected: number;
  limiterRejected: number;
  circuitRejected: number;
  timedOut: number;
  p95LatencyMs: number;
  throughput: number;
  downstreamOverloads: number;
  downstreamPeakActive: number;
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

async function runScenario(label: string, makeGuard: (() => EluGuard) | null, downstream: Downstream): Promise<ScenarioResult> {
  const guard = makeGuard?.() ?? null;
  const statsBefore = downstream.stats();
  const startedAt = Date.now();
  const latencies: number[] = [];
  let successful = 0;
  let downstreamRejected = 0;
  let limiterRejected = 0;
  let circuitRejected = 0;
  let timedOut = 0;
  let stop = false;

  const caller = async () => {
    while (!stop) {
      const requestStartedAt = Date.now();
      try {
        const request = () => fetch(downstream.url).then((response) => {
          if (!response.ok) throw new Error(`downstream status ${response.status}`);
          return response;
        });
        if (guard) await guard.execute(() => request(), { timeoutMs: REQUEST_TIMEOUT_MS });
        else await request();
        successful++;
        latencies.push(Date.now() - requestStartedAt);
      } catch (error) {
        if (error instanceof ConcurrencyLimitError) limiterRejected++;
        else if (error instanceof CircuitOpenError) circuitRejected++;
        else if (error instanceof GuardTimeoutError) timedOut++;
        else downstreamRejected++;
      }
    }
  };

  const callers = Array.from({ length: CALLERS }, () => caller());
  await new Promise((resolve) => setTimeout(resolve, RUN_MS));
  stop = true;
  await Promise.all(callers);
  if (guard) await guard.stop();

  const elapsedSec = (Date.now() - startedAt) / 1000;
  const downstreamStats = downstream.stats();
  return {
    label,
    successful,
    downstreamRejected,
    limiterRejected,
    circuitRejected,
    timedOut,
    p95LatencyMs: percentile(latencies, 0.95),
    throughput: successful / elapsedSec,
    downstreamOverloads: downstreamStats.overloads - statsBefore.overloads,
    downstreamPeakActive: downstreamStats.peakActive,
  };
}

async function main(): Promise<void> {
  const downstream = await startDownstream();
  const scenarios = [
    { label: 'no-limiter', makeGuard: null },
    {
      label: `fixed(${DOWNSTREAM_CAP})`,
      makeGuard: () => new EluGuard({
        limiter: {
          minConcurrency: DOWNSTREAM_CAP,
          maxConcurrency: DOWNSTREAM_CAP,
          queueTimeoutMs: 100,
          maxQueueLength: CALLERS,
        },
        breaker: { minimumRequests: 100000 },
      }),
    },
    {
      label: 'adaptive(5..50)',
      makeGuard: () => new EluGuard({
        limiter: {
          minConcurrency: 5,
          maxConcurrency: 50,
          initialConcurrency: 50,
          sampleIntervalMs: 100,
          queueTimeoutMs: 100,
          maxQueueLength: CALLERS,
        },
        breaker: { minimumRequests: 100000 },
      }),
    },
  ];

  try {
    const results = [];
    for (const scenario of scenarios) {
      results.push(await runScenario(scenario.label, scenario.makeGuard, downstream));
    }

    console.log('\n| config | successful | downstream rejected | limiter rejected | circuit rejected | timed out | p95 latency ms | successful/s | downstream overloads | downstream peak active |');
    console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const row of results) {
      console.log(`| ${row.label} | ${row.successful} | ${row.downstreamRejected} | ${row.limiterRejected} | ${row.circuitRejected} | ${row.timedOut} | ${row.p95LatencyMs.toFixed(1)} | ${row.throughput.toFixed(2)} | ${row.downstreamOverloads} | ${row.downstreamPeakActive} |`);
    }
  } finally {
    await downstream.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});