import { EluGuard } from '../../src';

/** Synchronously blocks the event loop for roughly `ms` milliseconds. */
function busyWork(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // intentionally busy: this is what drives ELU up for the demo
  }
}

function formatStats(guard: EluGuard): string {
  const s = guard.stats();
  return `ELU ${s.elu.toFixed(2).padStart(5)}   Limit ${String(s.limit).padStart(4)}   Active ${String(s.inFlight).padStart(4)}   Queue ${s.queueLength}`;
}

async function main() {
  console.log('ELU Guard — Adaptive Concurrency Demo\n');

  // A separate guard per phase: the breaker demo needs a clean rolling
  // window, not one diluted by the load test's successful calls.
  const limiterGuard = new EluGuard({
    limiter: {
      initialConcurrency: 20,
      maxConcurrency: 30,
      minConcurrency: 5,
      targetElu: 0.75,
      hysteresis: 0.2,
      sampleIntervalMs: 300,
    },
  });

  limiterGuard.on('limitChange', (change) => {
    console.log(`  [adjust] elu=${change.elu.toFixed(2)} ${change.previousLimit} -> ${change.limit} (${change.reason})`);
  });

  console.log('Baseline');
  console.log('──────────────────────────────');
  console.log(formatStats(limiterGuard));

  console.log('\nIncreasing event-loop load...\n');
  const loadPromises: Promise<void>[] = [];
  for (let i = 0; i < 40; i++) {
    loadPromises.push(
      limiterGuard
        .execute(async () => {
          busyWork(25);
        })
        .catch(() => {
          // rejected calls (queue timeout) are expected under heavy load; ignored for the demo
        })
    );
  }
  await new Promise((r) => setTimeout(r, 1500));
  console.log(formatStats(limiterGuard));
  await Promise.all(loadPromises);

  console.log('\nEvent loop recovering...\n');
  await new Promise((r) => setTimeout(r, 1500));
  console.log(formatStats(limiterGuard));
  await limiterGuard.stop();

  console.log('\n──────────────────────────────');
  console.log('Circuit breaker demo (fresh guard, clean window)');
  console.log('──────────────────────────────');

  const breakerGuard = new EluGuard({
    limiter: { initialConcurrency: 20, maxConcurrency: 30 },
    breaker: { failureThreshold: 0.5, minimumRequests: 3, resetTimeoutMs: 1500 },
  });
  breakerGuard.on('stateChange', (state) => {
    console.log(`  [circuit] -> ${state.toUpperCase()}`);
  });

  console.log('\nDownstream failures:');
  const failing = () => Promise.reject(new Error('downstream unavailable'));
  for (let i = 1; i <= 4; i++) {
    try {
      await breakerGuard.execute(failing);
    } catch {
      console.log(`  failure ${i}`);
    }
  }
  console.log(`Circuit: ${breakerGuard.stats().circuitState.toUpperCase()}`);

  console.log('\nRequests rejected without calling downstream:');
  try {
    await breakerGuard.execute(async () => 'should not run');
  } catch (err) {
    console.log(`  rejected fast: ${(err as Error).name}`);
  }

  console.log('\nWaiting for recovery...');
  await new Promise((r) => setTimeout(r, 1600));
  console.log(`Circuit: ${breakerGuard.stats().circuitState.toUpperCase()}`);

  console.log('\nProbe: SUCCESS');
  await breakerGuard.execute(async () => 'ok');
  console.log(`Circuit: ${breakerGuard.stats().circuitState.toUpperCase()}`);

  await breakerGuard.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
