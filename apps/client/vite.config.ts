import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  plugins: [
    {
      // hosted builds: pull the licensed art pack from a private URL (scripts/fetch-art.mjs)
      name: 'hearth-fetch-art',
      async buildStart() {
        if (command !== 'build' || !process.env.ASSET_PACK_URL) return;
        // a runtime URL, so the config bundler leaves the script alone
        const script = pathToFileURL(fileURLToPath(new URL('../../scripts/fetch-art.mjs', import.meta.url))).href;
        const { fetchArt } = (await import(script)) as { fetchArt: () => Promise<void> };
        await fetchArt();
      },
    },
  ],
  // read the repo-root .env; only VITE_* variables reach the browser
  envDir: '../../',
  server: { port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
}));
