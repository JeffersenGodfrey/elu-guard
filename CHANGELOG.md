# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - Unreleased

Breaking change: the framework adapters move to opt-in sub-paths with zero
runtime dependencies, alongside the operational surface needed to put
`elu-guard` in front of a real dependency (cancellation, deadlines, fallback).

### Added
- **Sub-path adapters**: `elu-guard/http`, `elu-guard/express` and `elu-guard/fastify` are separate entries (each re-exporting the core), so the root entry no longer pulls in framework types. `express`, `fastify` and `fastify-plugin` are optional **peer** dependencies, and the shipped package now has zero runtime dependencies.
- **Conservative adaptive control**: the limiter now starts at `minConcurrency` by default, accepts classified failure feedback, optional latency feedback, and an optional `retryAfterMs` hook that temporarily pauses admissions after downstream rate limiting.
- **`limitChange` now carries a `LimitChange` object** (`{ previousLimit, limit, elu, reason }`) plus a `LimitChangeReason` union (`low-elu` | `high-elu` | `failure` | `latency` | `retry-after`), so consumers can tell an ELU decrease apart from a failure/latency backoff and from the new rate-limit `pause()`, which emits `retry-after`; the limiter also exposes `pause()` and a `latencyP95` getter.
- **`rejected` event** on `EluGuard`, with a `RejectedReason` union (`circuit-open` | `limiter` | `timeout` | `aborted`), for metrics that need to count refusals without catching exceptions.
- **Latency feedback over a rolling p95 window**: `latencyWindowSize` (default 100) and `latencyMinSamples` (default 20) mean a single slow call no longer shrinks the limit.
- **`createGuard()` factory**: a concise entry point for the common one-guard-per-dependency setup.
- **Deadlines and cancellation in `execute()`**: `timeoutMs` (per guard or per call), `signal` (caller `AbortSignal`), and `fallback` (sync or async value/function invoked when the guard rejects before or during the call).
- **Error classification**: `isFailure` (per guard or per call) plus `countTimeoutAsFailure` to decide what the breaker counts. Caller aborts, `ConcurrencyLimitError`, `ShuttingDownError`, and `CircuitOpenError` are not breaker failures by default; timeouts are.
- **`ExecutionContext`**: the task receives `{ signal }` so downstream SDKs can be cancelled on timeout/abort.
- New error classes with `cause` support: `ConcurrencyLimitError`, `GuardTimeoutError`, `GuardAbortedError` (joining `CircuitOpenError`, `ShuttingDownError`, `LimitRejectedError`).
- **Dual module build**: `dist/cjs` (`.js` + `.d.ts`) and `dist/esm` (`.mjs` + `.d.mts`) with a conditional `exports` map, validated with `publint` and `@arethetypeswrong/cli`.
- New benchmarks: `npm run bench` (mixed async I/O + CPU-pressure phases comparing fixed-low and fixed-high limits against adaptive, with a forked downstream server and CPU-pressure helper, medians over repetitions) and `npm run soak` (permit/probe leak check over time); `npm run demo` stress demo. The stale compare/CPU-heavy/overload/fragile-downstream/bench:sync scripts are gone.
- Property-based invariant tests (`fast-check`) covering limiter accounting and breaker state transitions, alongside expanded unit and adapter suites (83 tests).
- New guard regression tests: deadlines/aborts that a task ignores, deadline expiry while queued, late settlement of an abandoned task, and probe hand-back on abort during half-open.

### Changed
- **Adapters moved off the root entry**: `eluGuardHttp`, `eluGuardExpress` and `eluGuardFastify` are no longer exported from `elu-guard`; import them from their sub-path instead. Framework packages became optional peers (and `fastify-plugin` left `dependencies`).
- `CircuitBreaker` internals: `canPass()` is replaced by `tryAcquire()`, which returns an `Admission` union (`allow` / `probe` / `reject`) so callers explicitly release half-open probes. Adapters were migrated accordingly.
- `EluGuard` emits `stateChange` / `limitChange` from the guarded path and exposes `close()` as an alias of `stop()`.
- `AimdLimiter.acquire()` accepts an optional `AbortSignal`; waiters are removed from the queue on abort or timeout.
- `execute()` accepts a per-call `isFailure` override, threaded through the same classification used by the breaker and the limiter.
- Import specifiers use explicit `.js` extensions so the sources resolve under `Node16`/`NodeNext`.
- Caller aborts consistently reject with `GuardAbortedError`, carrying `AbortSignal.reason` as `cause`. (A bare `abort()` produces a `DOMException`, whose `instanceof Error` status differs between Node and jest's environment, so it is no longer thrown through directly.)
- Dev toolchain refreshed: `@typescript-eslint/*` v8 (supports TypeScript 5.9 without the unsupported-version warning), `tsup` dual output, unused `autocannon` devDependency removed.

### Fixed
- **Controller bound safety**: asymmetric `minConcurrency`/`maxConcurrency` settings can no longer make feedback raise the active limit above the configured maximum.
- **Coverage gate parser**: recursive glob text in the coverage script could terminate its own block comment under Node; the release gate now executes correctly.
- **Deadlines are now enforced, not suggested.** `execute()` rejects with `GuardTimeoutError` even when the task ignores `ctx.signal`; previously an in-flight task that never settled left the returned promise pending forever (and the deadline timer was `unref`'d, so it could not fire in a short-lived script at all). Abandoned tasks are left to finish on their own — their late settlement is ignored and cannot become an unhandled rejection.
- **Deadlines free queued calls too**: a timeout that expires while the call is still waiting for a slot cancels the queue wait instead of holding the caller until a slot opens.
- **Half-open probe-slot leak**: probes are now released in a single place (on the transition back to `closed`) and on limiter rejection / client disconnect in the adapters, so repeated probe failures can no longer exhaust the half-open allowance and wedge the breaker.
- Queued callers are rejected (instead of hanging) when the limiter is stopped or when a caller aborts; aborting while queued now raises `GuardAbortedError` (previously a bare `ShuttingDownError`), and a cancelled call records no breaker outcome at all (it used to be booked as a success) while handing any half-open probe back.

### Security
- `npm audit` reports 0 vulnerabilities (dev and production dependency trees); `npm run audit:prod` gates the shipped tree in CI.

## [0.1.0] - Unreleased (never published)

### Added
- `EluSampler` — wraps Node's `perf_hooks` Event Loop Utilization API.
- `AimdLimiter` — AIMD-controlled adaptive concurrency limiter driven by ELU, with a `targetElu`/`hysteresis` band, FIFO queueing, queue timeouts, and graceful `stop()` that rejects queued callers instead of hanging them.
- `CircuitBreaker` — closed/open/half-open state machine over a rolling failure-rate window.
- `EluGuard` — composes both behind a single `execute()` call; emits `stateChange` and `limitChange` events; exposes `stats()`.
- Adapters: raw HTTP (`eluGuardHttp`), Express (`eluGuardExpress`), Fastify (`eluGuardFastify`).
- Examples: basic usage, Express, Fastify, and a self-contained stress demo (`npm run demo`).
- Benchmark comparing adaptive vs. a fixed-limit baseline under simulated load, with an honest write-up of what the results do and don't show.
- CI (lint/build/test across Node 18/20/22) and a tag-triggered npm publish workflow.

### Known limitations
- The mixed I/O + CPU-pressure benchmark is diagnostic evidence, not proof that adaptive mode beats a known fixed limit; on the development machine the fixed-high limit wins while the loop has slack and the adaptive limit wins once CPU pressure pins it, so the result is workload-specific.
- ELU is a local signal and cannot directly measure worker-thread saturation or an unknown downstream capacity without failure/latency feedback.
- API surface (option names, defaults) may still change before 1.0.0 based on real-world feedback.
