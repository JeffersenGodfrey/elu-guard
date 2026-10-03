import { defineConfig } from 'tsup';

const entries = ['src/index.ts', 'src/http.ts', 'src/express.ts', 'src/fastify.ts'];

export default defineConfig([
  {
    entry: entries,
    format: ['cjs'],
    dts: true,
    // Map files were tripling tarball weight for no runtime benefit.
    sourcemap: false,
    target: 'node16',
    outDir: 'dist/cjs',
    outExtension: () => ({ js: '.js' }),
  },
  {
    entry: entries,
    format: ['esm'],
    dts: true,
    sourcemap: false,
    target: 'node16',
    outDir: 'dist/esm',
    outExtension: () => ({ js: '.mjs' }),
  },
]);
