#!/usr/bin/env node
/**
 * Coverage gate.
 *
 * jest's own `coverageThreshold` is configured with recursive source globs, and
 * those globs are matched against istanbul's coverage
 * *keys*. Under ts-jest on Windows, when the workspace path contains a space,
 * those keys come out mangled (`...\src\core\guard\file:\E:\ELU%20Guard\...`),
 * so every glob silently matches nothing, jest warns that coverage data was not
 * found, and the gate quietly
 * stops gating.
 *
 * Reading `coverage/coverage-summary.json` and grouping by the real source path
 * is immune to that (the summary's own percentages are correct), and it lets us
 * fail when a group has *no* data instead of skipping it.
 *
 * Usage: jest --coverage && node scripts/check-coverage.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SUMMARY = resolve(process.cwd(), 'coverage', 'coverage-summary.json');

/**
 * Minimum percentages, keyed by source group.
 *
 * The core state machines carry the strictest floor: a silent permit or probe
 * leak there is a production incident, not a cosmetic bug. Adapters are thinner
 * and are exercised by integration tests against real servers.
 */
const GROUPS = [
  { prefix: 'src/core/', thresholds: { statements: 85, branches: 75, functions: 85, lines: 85 } },
  { prefix: 'src/errors/', thresholds: { statements: 90, branches: 55, functions: 55, lines: 90 } },
  { prefix: 'src/adapters/', thresholds: { statements: 83, branches: 70, functions: 80, lines: 85 } },
];

const METRICS = ['statements', 'branches', 'functions', 'lines'];

/**
 * Reduce an istanbul coverage key to a repo-relative source path.
 *
 * Clean keys look like `/repo/src/core/guard/guard.ts` (POSIX) or
 * `C:\repo\src\core\guard\guard.ts` (Windows). Mangled keys additionally embed a
 * `file:` URL, so the *last* `/src/` wins in every case.
 */
function relativeSourcePath(key) {
  const slashed = key.replace(/\\/g, '/');
  const marker = slashed.lastIndexOf('/src/');
  return marker === -1 ? slashed : slashed.slice(marker + 1);
}

function readSummary() {
  try {
    return JSON.parse(readFileSync(SUMMARY, 'utf8'));
  } catch (err) {
    console.error(
      `Unable to read ${SUMMARY}. Run \`npm run test:coverage\` first (${err instanceof Error ? err.message : err}).`,
    );
    process.exit(1);
  }
}

function emptyTotals() {
  const totals = {};
  for (const metric of METRICS) totals[metric] = { covered: 0, total: 0 };
  return totals;
}

function accumulate(totals, entry) {
  for (const metric of METRICS) {
    const value = entry[metric];
    if (!value) continue;
    totals[metric].covered += value.covered ?? 0;
    totals[metric].total += value.total ?? 0;
  }
}

function percent({ covered, total }) {
  return total === 0 ? 0 : (covered / total) * 100;
}

const summary = readSummary();
const files = Object.entries(summary).filter(([key]) => key !== 'total');

if (files.length === 0) {
  console.error('coverage-summary.json contains no file entries; the coverage run produced no data.');
  process.exit(1);
}

const grouped = new Map(GROUPS.map((group) => [group.prefix, emptyTotals()]));
const ungrouped = [];

for (const [key, entry] of files) {
  const source = relativeSourcePath(key);
  const group = GROUPS.find((candidate) => source.startsWith(candidate.prefix));
  if (!group) {
    if (source.startsWith('src/')) ungrouped.push(source);
    continue;
  }
  accumulate(grouped.get(group.prefix), entry);
}

let failed = false;
const rows = [];

for (const group of GROUPS) {
  const totals = grouped.get(group.prefix);
  const cells = {};
  for (const metric of METRICS) {
    if (totals[metric].total === 0) {
      console.error(`No coverage data collected for ${group.prefix} - the gate cannot be trusted.`);
      failed = true;
      cells[metric] = null;
      continue;
    }
    const value = percent(totals[metric]);
    cells[metric] = value;
    if (value < group.thresholds[metric]) failed = true;
  }
  rows.push({ group: group.prefix, cells, thresholds: group.thresholds });
}

console.log('\nCoverage gate');
console.log('| group | ' + METRICS.join(' | ') + ' |');
console.log('|---|' + METRICS.map(() => '---|').join(''));
for (const row of rows) {
  const cells = METRICS.map((metric) => {
    const value = row.cells[metric];
    const floor = row.thresholds[metric];
    if (value === null) return 'no data';
    const mark = value + 1e-9 >= floor ? 'pass' : 'FAIL';
    return `${value.toFixed(1)}% (>=${floor}%) ${mark}`;
  });
  console.log(`| ${row.group} | ${cells.join(' | ')} |`);
}

if (ungrouped.length > 0) {
  console.log(
    `\nNote: ${ungrouped.length} src file(s) are not assigned to a gated group (e.g. ${ungrouped[0]}).`,
  );
}

if (failed) {
  console.error('\nCoverage gate failed.');
  process.exit(1);
}
console.log('\nCoverage gate passed.');
