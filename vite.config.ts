import { defineConfig } from 'vite';

// Voxel City Builder — Vite config.
// Workers are created with `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`
// and bundled as ES modules.
//
// VCB_VITE_CACHE (optional env var): dependency pre-bundling cache directory. Set it to a private
// directory when several dev servers run at the same time (parallel agents), e.g.
//   VCB_VITE_CACHE=/my/scratch/vite-cache node node_modules/vite/bin/vite.js . --port 5199
export default defineConfig({
  cacheDir: process.env.VCB_VITE_CACHE || 'node_modules/.vite',
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
});
