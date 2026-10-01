# elu-guard

[![npm version](https://img.shields.io/npm/v/elu-guard.svg)](https://www.npmjs.com/package/elu-guard)
[![npm types](https://img.shields.io/npm/types/elu-guard.svg)](https://www.npmjs.com/package/elu-guard)
[![node](https://img.shields.io/node/v/elu-guard.svg)](https://www.npmjs.com/package/elu-guard)
[![license](https://img.shields.io/npm/l/elu-guard.svg)](./LICENSE)
[![CI](https://github.com/JeffersenGodfrey/elu-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/JeffersenGodfrey/elu-guard/actions/workflows/ci.yml)

Adaptive concurrency limiting + circuit breaking for Node.js services, in-process
and framework-agnostic.

One guard protects one downstream dependency. The guard decides whether a call is
admitted *now* (based on how saturated your event loop actually is) and whether the
dependency looks healthy *at all* (based on the failures you tell it to count):

```
        ELU  ->  AIMD  ->  adaptive concurrency limit  ->  circuit breaker  ->  downstream
   (how busy      (back off /     (how many calls may be    (fail fast while the
    the event      recover)        in flight right now)      dependency is broken)
    loop is)
```

```ts
import { createGuard } from 'elu-guard';

// One guard per dependency: payments, inventory and search do not share health.
const payments = createGuard({
  limiter: { minConcurrency: 5, maxConcurrency: 100, targetElu: 0.7 },
  breaker: { failureThreshold: 0.5, minimumRequests: 10 },
  timeoutMs: 3000,
  isFailure: (err) => (err as { status?: number })?.status >= 500,
});

const charge = await payments.execute(({ signal }) => stripe.charge(amount, { signal }));
```

## The problem

A Node service under load degrades in two different ways, and they need two
different responses:

1. **The event loop saturates.** The process is up and the downstream is fine,
   but every request in flight makes every other request slower. Admitting *more*
   concurrency makes this worse, not better. The fix is admission control:
   temporarily admit less, recover when the loop is idle again.
2. **A dependency breaks.** One downstream starts timing out or returning 5xx.
   Retrying it and waiting on it wastes capacity everyone else could use. The fix
   is fail-fast: stop calling it for a while, keep the rest of the service healthy.

`elu-guard` is both, composed behind a single `execute()` call, with the failure
semantics left to you.

## Why ELU (and not latency, CPU% or RPS)

CPU% tells you what the machine is doing, not what *your process* is waiting on.
Latency tells you a call was slow, but not whether that was your process or the
dependency (and latency-based schemes need their own circuit-breaking to avoid
treating a slow dependency as a slow process). `perf_hooks.eventLoopUtilization()`
measures how much of the last window your event loop spent active versus idle -
a direct signal of local saturation, unrelated to how slow any single downstream
is. That is the signal the control loop reacts to.

## How it works

```
execute(fn, opts)
      |
      v
  circuit breaker --open--> fail fast (CircuitOpenError) or fallback
      |
   admitted
      v
   limiter.acquire() --no slot--> queue -> reject (ConcurrencyLimitError) / timeout
      |                         |
      |  slot granted           +--> queued callers are freed when a deadline or
      v                              a caller abort fires while they wait
  deadline + AbortController ---> ctx.signal handed to your task
      |
      v
   await Promise.race([fn(ctx), fence])   <- a deadline is a fence, not a hint
      |
   settle: release permit + hand back any half-open probe exactly once
      |
   classify(result) -> breaker.recordSuccess() | breaker.recordFailure()
```

   ## Architecture

   ```mermaid
   flowchart LR
      Caller[Caller or framework adapter] --> Guard[EluGuard.execute]
      Guard --> Breaker[Circuit breaker]
      Breaker -->|OPEN| Fallback[Fail fast or fallback]
      Breaker -->|CLOSED or HALF_OPEN| Limiter[AIMD concurrency limiter]
      Limiter -->|No slot| Queue[FIFO queue with timeout and abort]
      Limiter -->|Admitted| Task[Downstream task]
      Task --> Outcome{Outcome}
      Outcome -->|Success| Recovery[Record success and release permit]
      Outcome -->|Failure or timeout| Failure[Classify failure and release permit]
      Failure --> Breaker
      Failure --> Feedback[Failure, latency, or Retry-After feedback]
      Feedback --> Limiter
      ELU[Node event-loop utilization] --> Limiter
      Recovery --> Breaker
   ```

   Each guard owns its limiter and breaker. There is no global registry or shared
   health state, so a failing dependency cannot reduce capacity for unrelated
   dependencies.

The pieces:

```
src/core/
  elu/      EluSampler      thin wrapper over perf_hooks ELU sampling
  limiter/  AimdLimiter     AIMD control loop + acquire/release/queue semantics
  breaker/  CircuitBreaker  closed/open/half-open state machine + probe reservation
  guard/    EluGuard        composes both behind execute(), owns deadline/abort
src/errors/                 typed errors shared across the public API
src/adapters/
  http/     eluGuardHttp    zero framework dependency
  express/  eluGuardExpress
  fastify/  eluGuardFastify
```

The core has no knowledge of Express, Fastify or HTTP beyond Node's own types;
the adapters are a thin, optional layer on top. Circular state - probe
reservations, queued waiters, timers - is what most of the test suite is about:

- every `acquire()` has exactly one matching `release()`, on every path;
- a rejected limiter acquisition never leaves a half-open probe reserved;
- a caller abort or client disconnect never counts as a dependency failure;
- `0 <= inFlight <= currentLimit` always.

## Install

```bash
npm install elu-guard
```

Node.js 18 or newer (CI runs 20, 22 and 24). The core uses Node's own
`perf_hooks`; the Fastify adapter also uses the small `fastify-plugin` runtime
dependency.

## Quick start

```ts
import { createGuard } from 'elu-guard';

const stripeGuard = createGuard({
  limiter: { minConcurrency: 5, maxConcurrency: 100, targetElu: 0.7 },
  breaker: { failureThreshold: 0.5, minimumRequests: 10, resetTimeoutMs: 10_000 },
  timeoutMs: 3000,
});

// Wrap the downstream call itself:
const charge = await stripeGuard.execute(
  ({ signal }) => stripeClient.charge({ amount: 100 }, { signal }),
  { fallback: () => ({ queued: true }) },
);
```

What happens on the way in:

| Situation | Result |
|---|---|
| Admitted, task resolves | the value, breaker records a success |
| Admitted, task rejects | the error (or `fallback`), breaker records per `isFailure` |
| Admitted, deadline expires | `GuardTimeoutError`, permit released, task's `signal` aborted |
| Caller aborts | `GuardAbortedError` (carrying `signal.reason` as `cause`) |
| No slot free | queued, then admitted or `ConcurrencyLimitError` |
| Circuit open | `CircuitOpenError` (or `fallback`) without touching the dependency |

## One guard per dependency

The single most important rule:

```ts
// Yes: one guard per downstream, each with its own breaker, limiter and health.
const stripe = new EluGuard({ /* ... */ });
const mongo = new EluGuard({ /* ... */ });
const openai = new EluGuard({ /* ... */ });
```

```ts
// No: one guard for a whole process (or for your HTTP server) fronting several
// independent dependencies. "Stripe is failing" must not close the circuit for
// MongoDB, and it certainly must not stop your server serving routes that never
// talk to Stripe.
```

Each `EluGuard` instance owns independent limiter and breaker state - nothing is
global or shared - so named dependencies fall out of ordinary variables. A shared
registry (`guard.registry('stripe')`) is deliberately not part of this version.

### Important limitation

The adaptive controller measures **local event-loop utilization**. It does not
automatically learn a remote database pool cap, API rate limit, HTTP 429, or
downstream latency curve. For a fragile dependency, set a limit that matches its
capacity and configure `isFailure` so dependency errors reach the circuit breaker.
Use one guard per dependency; do not treat the ELU signal as a replacement for
downstream-specific limits or rate controls.

There are two ways to attach a guard, and they are not interchangeable:

| | Use it for | What guards the call | Who classifies the outcome |
|---|---|---|---|
| `guard.execute(fn)` | calls your code makes to a dependency | breaker probe + limiter permit | the guard, in-process |
| `eluGuardHttp` / `eluGuardExpress` / `eluGuardFastify` | inbound routes that *are* the edge to one dependency | breaker probe + limiter permit | the response: 5xx fails, client disconnect does not |

Do not stack both on the same route: the adapter would hold one permit while your
handler asks for a second one. Pick one - adapters for inbound routes,
`execute()` for internal call sites.

## Configuration

### `EluGuard` options

| Option | Default | Meaning |
|---|---|---|
| `timeoutMs` | none | Default deadline for every `execute()` call |
| `isFailure(error)` | built-in heuristic | Return `true` to count a rejection as a downstream failure |
| `retryAfterMs(error)` | none | Return a server-supplied retry delay in milliseconds to pause admissions |
| `countTimeoutAsFailure` | `true` | Whether a guard timeout is a breaker failure |
| `limiter` | `{}` | `AimdLimiterOptions` |
| `breaker` | `{}` | `CircuitBreakerOptions` |

### `limiter` options (`AimdLimiterOptions`)

| Option | Default | Meaning |
|---|---|---|
| `minConcurrency` | `5` | Floor for the limit |
| `maxConcurrency` | `500` | Ceiling for the limit |
| `initialConcurrency` | `minConcurrency` | Starting limit for conservative warm-up |
| `targetElu` | `0.8` | At or above this ELU, the limit decreases multiplicatively |
| `hysteresis` | `0.2` | Gap below `targetElu` before the limit grows again (anti-oscillation) |
| `decreaseFactor` | `0.8` | Multiplicative decrease applied above target |
| `failureDecreaseFactor` | `0.8` | Multiplicative decrease after a failure counted by `isFailure` |
| `latencyThresholdMs` | none | Reduce the limit when an admitted operation exceeds this duration |
| `latencyDecreaseFactor` | `0.8` | Multiplicative decrease applied after a latency breach |
| `increaseStep` | `0` (sqrt of limit) | Fixed additive increase; `0` means `sqrt(currentLimit)` |
| `sampleIntervalMs` | `1000` | How often ELU is resampled and the limit re-evaluated |
| `queueTimeoutMs` | `5000` | How long a queued caller waits before `ConcurrencyLimitError` |
| `maxQueueLength` | `1000` | Queued callers allowed before new ones are rejected immediately |

### `breaker` options (`CircuitBreakerOptions`)

| Option | Default | Meaning |
|---|---|---|
| `failureThreshold` | `0.5` | Failure *ratio* over the window that opens the circuit |
| `minimumRequests` | `10` | Outcomes needed before the ratio is evaluated |
| `windowMs` | `10000` | Rolling window for outcomes |
| `resetTimeoutMs` | `5000` | How long the circuit stays open before probing |
| `halfOpenMaxCalls` | `3` | Concurrent probes allowed while half-open |

### `execute()` options (`ExecuteOptions`)

| Option | Meaning |
|---|---|
| `timeoutMs` | Per-call deadline, overrides the guard default |
| `signal` | Caller `AbortSignal`; aborting rejects with `GuardAbortedError` |
| `fallback(error)` | Value or function used instead of throwing on rejection paths |
| `countTimeoutAsFailure` | Per-call override of the guard default |

For HTTP clients, map the response metadata into the optional retry hook:

```ts
const guard = createGuard({
   retryAfterMs: (error) => {
      const retryAfter = (error as { retryAfterMs?: number }).retryAfterMs;
      return retryAfter;
   },
});
```

The core does not assume a particular HTTP client or error shape. Your wrapper
should throw an error for a 429 response, attach the parsed `Retry-After` delay,
and return `true` from `isFailure` when that response should affect dependency
health.

## Benchmarks

Run `npm run bench:fragile-downstream` to test a local dependency with a hard
concurrent capacity. It returns HTTP 429 after that capacity is full and compares
no admission control, a fixed limit at the dependency capacity, and the adaptive
controller with ELU recovery plus classified-failure backoff.

This is a diagnostic benchmark, not a claim that adaptive concurrency always
improves throughput. In the tested scenario, the fixed limit prevents overload,
while the adaptive controller can still briefly overshoot before failure
feedback lowers its limit. Results depend on the workload, dependency behavior,
and configuration.

