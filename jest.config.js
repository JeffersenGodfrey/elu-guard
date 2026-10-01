module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  testTimeout: 10000,
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  // `text-summary` + `json-summary` only: the HTML/lcov writers crash on
  // Windows when the workspace path contains a space (istanbul builds a
  // per-source directory tree from `file:`-style keys and rejects the result).
  coverageReporters: ['text-summary', 'json-summary'],
  // Only the *global* floor lives here: per-path globs are matched against
  // istanbul coverage keys, which ts-jest mangles on Windows paths containing
  // spaces, and a glob that matches nothing silently stops gating. The
  // per-directory gate that actually gets enforced is scripts/check-coverage.mjs.
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 70,
      functions: 85,
      lines: 85,
    },
  },
};
