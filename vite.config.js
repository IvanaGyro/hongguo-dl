import { defineConfig } from 'vite';
export default defineConfig({
  // GitHub Pages project sites are mounted at /hongguo-dl/, not at /.
  base: process.env.VITE_BASE_PATH || '/',
  // Local Vite development keeps the original same-origin /api proxy.
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { target: 'es2022' },
});
