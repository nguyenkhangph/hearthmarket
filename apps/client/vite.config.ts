import { defineConfig } from 'vite';

export default defineConfig({
  // read the repo-root .env; only VITE_* variables reach the browser
  envDir: '../../',
  server: { port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
