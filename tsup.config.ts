import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    dts: true,
    sourcemap: true,
    target: 'node16',
    outDir: 'dist/cjs',
    outExtension: () => ({ js: '.js' }),
  },
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    target: 'node16',
    outDir: 'dist/esm',
    outExtension: () => ({ js: '.mjs' }),
  },
]);
