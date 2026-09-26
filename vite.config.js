import { defineConfig } from 'vite';

export default defineConfig({
  // manifold-3d loads its .wasm relative to import.meta.url; esbuild
  // pre-bundling breaks that, so leave the package alone.
  optimizeDeps: {
    exclude: ['manifold-3d'],
  },
  // The solid worker imports manifold-3d, which needs import.meta.url.
  worker: {
    format: 'es',
  },
});
