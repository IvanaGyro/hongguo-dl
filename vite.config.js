import { defineConfig } from 'vite';
export default defineConfig({
  // Same-origin API: local frontend development forwards to wrangler dev.
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { target: 'es2022' },
});
