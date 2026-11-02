#!/usr/bin/env node
/**
 * Build step for hosted clients (Vercel): fetches the licensed Cute Fantasy pack from a
 * private location and imports it, so a build from GitHub ships the real art without the
 * pack ever being in this public repository.
 *
 *   ASSET_PACK_URL    where the zip lives, e.g. a file in a PRIVATE GitHub repo:
 *                     https://api.github.com/repos/<you>/hearthmarket-art/contents/Cute_Fantasy.zip
 *   ASSET_PACK_TOKEN  optional bearer token (a fine-grained GitHub token with read access to
 *                     that one repo). Keep both as build environment variables, never in code.
 *
 * Without ASSET_PACK_URL, or if the download fails, the build goes on and the game draws its
 * stand-in art. Never fails the build. Runs from the client's Vite build (vite.config.ts), or:
 *
 *   ASSET_PACK_URL=... node scripts/fetch-art.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'apps/client/public/assets/cute_fantasy');
const url = process.env.ASSET_PACK_URL;
const token = process.env.ASSET_PACK_TOKEN;

export async function fetchArt() {
  if (existsSync(join(dest, 'NPCs (Premade)'))) {
    console.log('fetch-art: pack already imported');
    return;
  }
  if (!url) {
    console.log('fetch-art: ASSET_PACK_URL not set, the build uses stand-in art');
    return;
  }
  try {
    const headers = { Accept: url.includes('api.github.com') ? 'application/vnd.github.raw' : 'application/octet-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(url, { headers, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const zip = new Uint8Array(await r.arrayBuffer());
    // unzip in JavaScript: build images do not always have an unzip binary
    const { unzipSync } = createRequire(join(root, 'apps/client/package.json'))('fflate');
    const files = unzipSync(zip);
    const tmp = mkdtempSync(join(tmpdir(), 'cute-fantasy-'));
    let n = 0;
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith('/') || name.includes('..')) continue;
      const out = join(tmp, name);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, data);
      n++;
    }
    execFileSync(process.execPath, [join(root, 'scripts/import-assets.mjs'), tmp], { stdio: 'inherit' });
    rmSync(tmp, { recursive: true, force: true });
    console.log(`fetch-art: imported ${n} files`);
  } catch (e) {
    console.warn(`fetch-art: could not fetch the pack (${e.message}); the build uses stand-in art`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await fetchArt();
