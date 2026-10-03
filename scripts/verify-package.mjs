/**
 * Fresh-install package verification.
 *
 * Packing the real tarball, installing it into a throwaway directory and using
 * it from CommonJS, ESM and TypeScript is the only way to catch packaging
 * mistakes that `npm link` / importing `../src` cannot see: wrong `exports`
 * conditions, missing declarations, files that were never included.
 *
 * Two TypeScript consumers are checked, because they behave differently:
 *   - core only (realistic library setup, `skipLibCheck` on): no dependency on
 *     the optional framework types must be required.
 *   - adapters, with express/fastify types present and `skipLibCheck` OFF: this
 *     fully type-checks the shipped declarations, including adapter signatures.
 *
 * Framework types are linked in from the repo instead of downloaded, so the run
 * works offline and tests the exact versions CI installs.
 *
 * Run with: npm run verify:package (or SKIP_BUILD=1 to reuse dist/)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: isWindows, ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** Every file we are willing to publish. Anything else in the tarball is a bug. */
const ALLOWED_PACK_PATHS = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  /^dist\/cjs\/[^/]+$/,
  /^dist\/esm\/[^/]+$/,
];

function assertPackContents() {
  const output = run('npm', ['pack', '--dry-run', '--json'], { cwd: repoRoot });
  const [info] = JSON.parse(output);
  const paths = info.files.map((file) => file.path).sort();

  const unexpected = paths.filter(
    (path) => !ALLOWED_PACK_PATHS.some((rule) => (rule instanceof RegExp ? rule.test(path) : rule === path)),
  );
  if (unexpected.length > 0) {
    throw new Error(`unexpected files would be published:\n  ${unexpected.join('\n  ')}`);
  }
  if (!paths.includes('dist/cjs/index.js') || !paths.includes('dist/esm/index.mjs')) {
    throw new Error(`tarball is missing a build output:\n  ${paths.join('\n  ')}`);
  }
  if (!paths.some((path) => path.startsWith('dist/cjs/') && path.endsWith('.d.ts'))) {
    throw new Error('tarball is missing CommonJS type declarations');
  }
  if (!paths.some((path) => path.endsWith('.d.mts'))) {
    throw new Error('tarball is missing ESM type declarations');
  }
  log(`  pack contents ok (${paths.length} files; no tests, benchmarks, examples or config)`);
}

const CJS_CONSUMER = [
  "const assert = require('node:assert');",
  "const { EluGuard, CircuitOpenError, GuardTimeoutError, ConcurrencyLimitError } = require('elu-guard');",
  "const { eluGuardHttp } = require('elu-guard/http');",
  "const { eluGuardExpress } = require('elu-guard/express');",
  "const { eluGuardFastify } = require('elu-guard/fastify');",
  '',
  'async function main() {',
  "  assert.strictEqual(typeof EluGuard, 'function');",
  "  assert.strictEqual(typeof ConcurrencyLimitError, 'function');",
  "  assert.strictEqual(typeof eluGuardHttp, 'function');",
  "  assert.strictEqual(typeof eluGuardExpress, 'function');",
  "  assert.strictEqual(typeof eluGuardFastify, 'function');",
  '  const guard = new EluGuard({',
  '    limiter: { minConcurrency: 2, maxConcurrency: 2, maxQueueLength: 0, queueTimeoutMs: 50 },',
  '    breaker: { failureThreshold: 0.5, minimumRequests: 2 },',
  '  });',
  '',
  '  assert.strictEqual(await guard.execute(async () => 40 + 2), 42);',
  '  assert.strictEqual(guard.stats().inFlight, 0);',
  "  assert.strictEqual(typeof guard.stats().probes, 'number');",
  '',
  '  await assert.rejects(',
  '    () => guard.execute(() => new Promise(() => {}), { timeoutMs: 20 }),',
  "    (err) => err instanceof GuardTimeoutError && err.name === 'GuardTimeoutError',",
  '  );',
  '  assert.strictEqual(guard.stats().inFlight, 0);',
  '',
  "  const failing = () => Promise.reject(new Error('downstream down'));",
  '  await assert.rejects(() => guard.execute(failing));',
  '  await assert.rejects(() => guard.execute(failing));',
  '  await assert.rejects(() => guard.execute(async () => 1), (err) => err instanceof CircuitOpenError);',
  "  assert.strictEqual(guard.stats().circuitState, 'open');",
  '',
  "  assert.strictEqual(await guard.execute(async () => 1, { fallback: () => 'cached' }), 'cached');",
  '  await guard.stop();',
  "  console.log('cjs consumer: ok');",
  '}',
  '',
  'main().catch((err) => {',
  '  console.error(err);',
  '  process.exit(1);',
  '});',
  '',
].join('\n');

const ESM_CONSUMER = [
  "import assert from 'node:assert';",
  "import { EluGuard, CircuitOpenError, GuardTimeoutError } from 'elu-guard';",
  "import { eluGuardHttp } from 'elu-guard/http';",
  "import { eluGuardExpress } from 'elu-guard/express';",
  "import { eluGuardFastify } from 'elu-guard/fastify';",
  '',
  'const guard = new EluGuard({',
  '  limiter: { minConcurrency: 2, maxConcurrency: 2, maxQueueLength: 0, queueTimeoutMs: 50 },',
  '  breaker: { failureThreshold: 0.5, minimumRequests: 2 },',
  '});',
  '',
  'assert.strictEqual(await guard.execute(async () => 40 + 2), 42);',
  'assert.strictEqual(guard.stats().inFlight, 0);',
  '',
  'await assert.rejects(',
  '  () => guard.execute(() => new Promise(() => {}), { timeoutMs: 20 }),',
  '  (err) => err instanceof GuardTimeoutError,',
  ');',
  '',
  "const failing = () => Promise.reject(new Error('downstream down'));",
  'await assert.rejects(() => guard.execute(failing));',
  'await assert.rejects(() => guard.execute(failing));',
  'await assert.rejects(() => guard.execute(async () => 1), (err) => err instanceof CircuitOpenError);',
  '',
  'await guard.stop();',
  "console.log('esm consumer: ok');",
  '',
].join('\n');

const CORE_TS_CONSUMER = [
  "import { EluGuard, CircuitState, GuardTimeoutError } from 'elu-guard';",
  '',
  'export async function use(): Promise<CircuitState> {',
  '  const guard = new EluGuard({',
  '    timeoutMs: 1000,',
  '    countTimeoutAsFailure: false,',
  '    isFailure: (error: unknown) => error instanceof Error,',
  '  });',
  '  const value: number = await guard.execute(',
  '    async ({ signal }) => {',
  '      void signal;',
  '      return 1;',
  '    },',
  '    { fallback: () => 0 },',
  '  );',
  '  void value;',
  '  void GuardTimeoutError;',
  '  return guard.stats().circuitState;',
  '}',
  '',
].join('\n');

const ADAPTER_TS_CONSUMER = [
  "import express from 'express';",
  "import Fastify from 'fastify';",
  "import { EluGuard, eluGuardExpress } from 'elu-guard/express';",
  "import { eluGuardFastify } from 'elu-guard/fastify';",
  "import { eluGuardHttp } from 'elu-guard/http';",
  '',
  'const guard = new EluGuard();',
  '',
  '// These assignments are the point: the shipped declarations must satisfy the',
  '// frameworks without any casting.',
  'const app = express();',
  'app.use(eluGuardExpress(guard));',
  '',
  'const fastify = Fastify();',
  'void fastify.register(eluGuardFastify(guard));',
  '',
  'export const handler = eluGuardHttp(guard, (_req, res) => {',
  "  res.end('ok');",
  '});',
  '',
].join('\n');

function writeConsumer(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
}

/** Framework type packages are linked from the repo so the check stays offline. */
const FRAMEWORK_TYPE_PACKAGES = ['@types', 'express', 'fastify', 'pino', 'fastify-plugin'];


function linkFrameworkTypes(workspace) {
  const nodeModules = join(workspace, 'node_modules');
  const linked = [];
  for (const name of FRAMEWORK_TYPE_PACKAGES) {
    const source = join(repoRoot, 'node_modules', name);
    const target = join(nodeModules, name);
    if (!existsSync(source) || existsSync(target)) continue;
    try {
      symlinkSync(source, target, 'junction');
      linked.push(name);
    } catch {
      // Leave it out; the adapter type check below reports what is missing.
    }
  }
  return linked;
}

function verifyConsumers(workspace) {
  const tscJs = join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
  const baseTsArgs = ['--noEmit', '--strict', '--esModuleInterop', '--target', 'es2020'];

  log(run(process.execPath, ['cjs-consumer.cjs'], { cwd: workspace, shell: false }).trim());
  log(run(process.execPath, ['esm-consumer.mjs'], { cwd: workspace, shell: false }).trim());

  // Core-only consumer: what a library author actually compiles against.
  run(
    process.execPath,
    [tscJs, ...baseTsArgs, '--skipLibCheck', '--module', 'node16', '--moduleResolution', 'node16', 'core-consumer.ts'],
    { cwd: workspace, shell: false },
  );
  // Legacy resolution, which follows "types" -> dist/cjs/index.d.ts
  run(
    process.execPath,
    [tscJs, ...baseTsArgs, '--skipLibCheck', '--module', 'commonjs', '--moduleResolution', 'node10', 'core-consumer.ts'],
    { cwd: workspace, shell: false },
  );
  log('  core typescript consumer: ok (node16 + node10 resolution)');

  // Adapter consumer with the frameworks installed and skipLibCheck OFF, so the
  // shipped declarations are checked in full, framework signatures included.
  run(
    process.execPath,
    [tscJs, ...baseTsArgs, '--module', 'node16', '--moduleResolution', 'node16', 'adapter-consumer.ts'],
    { cwd: workspace, shell: false },
  );
  // The sub-paths must also resolve under legacy node10 resolution, which finds
  // them through the "typesVersions" map in package.json.
  run(
    process.execPath,
    [tscJs, ...baseTsArgs, '--module', 'commonjs', '--moduleResolution', 'node10', 'adapter-consumer.ts'],
    { cwd: workspace, shell: false },
  );
  log('  adapter typescript consumer: ok (express + fastify types, node16 + node10, skipLibCheck off)');
}

function main() {
  if (!process.env.SKIP_BUILD) {
    log('building...');
    run('npm', ['run', 'build'], { cwd: repoRoot });
  }

  log('checking what would be published...');
  assertPackContents();

  const staging = mkdtempSync(join(tmpdir(), 'elu-guard-pack-'));
  const workspace = join(staging, 'consumer');
  mkdirSync(workspace, { recursive: true });

  try {
    log('packing and installing into a fresh consumer...');
    const packed = run('npm', ['pack', '--pack-destination', staging], { cwd: repoRoot }).trim();
    const tarball = join(staging, packed.split(/\r?\n/).pop().trim());

    writeFileSync(
      join(workspace, 'package.json'),
      JSON.stringify({ name: 'elu-guard-consumer-check', private: true, version: '1.0.0' }, null, 2),
      'utf8',
    );
    run('npm', ['install', tarball, '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: workspace });

    const linked = linkFrameworkTypes(workspace);
    log(`  linked framework types from the repo: ${linked.join(', ')}`);

    writeConsumer(workspace, {
      'cjs-consumer.cjs': CJS_CONSUMER,
      'esm-consumer.mjs': ESM_CONSUMER,
      'core-consumer.ts': CORE_TS_CONSUMER,
      'adapter-consumer.ts': ADAPTER_TS_CONSUMER,
    });
    verifyConsumers(workspace);

    log(`\npackage verification passed (${tarball.split(/[\\/]/).pop()})`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`\npackage verification FAILED\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
