import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  plugins: [
    {
      // hosted builds: pull the licensed art pack from a private URL (scripts/fetch-art.mjs)
      name: 'hearth-fetch-art',
      async buildStart() {
        if (command !== 'build') return; // fetchArt logs whether ASSET_PACK_URL is set
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
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    // two pages: the game, and the public live-economy dashboard
    rollupOptions: { input: { main: fileURLToPath(new URL('index.html', import.meta.url)), dashboard: fileURLToPath(new URL('dashboard.html', import.meta.url)) } },
  },
}));
