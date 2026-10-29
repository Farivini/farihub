import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  worker: { format: 'es' },
  // The WASM package resolves its binary relative to its own module; keep it out of pre-bundling.
  optimizeDeps: { exclude: ['@ironcalc/wasm'] },
  build: { target: 'es2022', sourcemap: true },
});
