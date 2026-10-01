# Contributing

## Setup

```bash
git clone <your-fork-url>
cd elu-guard
npm install
```

## Commands

| Command | What it does |
|---|---|
| `npm run build` | `tsup` → `dist/cjs` (`.js` + `.d.ts`) and `dist/esm` (`.mjs` + `.d.mts`) |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` over `src/` and `tests/` |
| `npm test` | jest, every suite under `tests/` |
| `npm run test:coverage` | jest with coverage; enforces the floors in `jest.config.js` |
| `npm run test:properties` | only the `fast-check` invariant suite |
| `npm run lint` | eslint over `src/`, `tests/`, `benchmarks/`, `examples/` |
| `npm run audit:prod` | `npm audit --omit=dev` (gates the tree that actually ships) |
| `npm run bench` | mixed async-I/O + CPU-spike benchmark (`BENCH_REPS`, `BENCH_PHASE_MS`) |
| `npm run bench:sync` | the original synchronous benchmark, kept for history |
| `npm run soak` | sustained mixed workload, checks that permits/probes return to 0 |
| `npm run demo` | live ELU / limit / breaker output |
| `npm run verify:package` | packs, fresh-installs and consumes the tarball from CJS/ESM/TS |
| `npm run verify:all` | typecheck + lint + test + coverage + build + package verification |

## Before opening a PR

- `npm run verify:all` must pass locally. CI additionally runs `publint`,
  `@arethetypeswrong/cli`, `npm run test:coverage`, the Node 20/22/24 matrix, and
  the Fastify v4 / Express v4 compatibility jobs.
- Add tests for any behaviour change. `tests/unit/` for core logic,
  `tests/adapters/` for anything touching an adapter (those spin up real servers
  and sockets), `tests/properties/` when the change touches state-machine
  invariants.
- Keep `.github/workflows/benchmark.yml`'s methodology intact if you touch a
  benchmark: the phases are deterministic on purpose so results stay comparable.
- If you touch the public API (`src/index.ts`, option shapes, error types),
  update `README.md`, `CHANGELOG.md` and `scripts/verify-package.mjs` (its
  consumers are the executable definition of "consumable").

## Non-negotiable invariants

These are the properties the library exists to provide. A PR that breaks one of
them is a bug, not a design discussion:

1. Every `acquire()` has exactly one matching `release()`, on every path
   (success, downstream failure, timeout, caller abort, breaker transition,
   limiter rejection, shutdown).
2. A rejected limiter `acquire()` never leaves a half-open probe reserved.
3. A caller abort or client disconnect never counts as a downstream failure.
4. `0 <= inFlight <= currentLimit` at all times.
5. `stop()` clears timers, stops the ELU sampler and rejects queued callers.

## Code style

- TypeScript strict mode is on; don't work around it with `any` unless there is
  genuinely no better option (and say why in a comment).
- Keep `src/core/` free of framework imports. If something needs Express or
  Fastify types it belongs in `src/adapters/`; the core only knows `node:*`.
- One guard per protected dependency is the architecture: never add a global
  registry or shared state that makes two guards' health interfere.

## Reporting bugs

Open an issue with a minimal reproduction. "The limiter doesn't adapt" is hard
to act on; "here's a 10-line script and the ELU/limit values I see vs expected"
is easy to act on.
