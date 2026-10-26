#!/usr/bin/env node
/**
 * Imports the Cute Fantasy RPG asset pack (c) Kenmi into the client.
 *
 * The pack's premium license allows use in commercial and non-commercial games
 * but forbids redistribution, so the files are NOT in this repository.
 * Buy/download it from https://kenmi-art.itch.io/cute-fantasy-rpg, then run:
 *
 *   npm run assets -- /path/to/Cute_Fantasy.zip
 *   npm run assets -- /path/to/Cute_Fantasy          # an extracted folder
 *   CUTE_FANTASY=/path/to/Cute_Fantasy.zip npm run assets
 *
 * Files land in apps/client/public/assets/cute_fantasy/ (gitignored).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'apps/client/public/assets/cute_fantasy');
const src = process.argv[2] ?? process.env.CUTE_FANTASY ?? join(root, 'vendor/Cute_Fantasy');

if (!existsSync(src)) {
  console.error(`Asset pack not found at ${src}.
Download Cute Fantasy RPG from https://kenmi-art.itch.io/cute-fantasy-rpg and run:
  npm run assets -- /path/to/Cute_Fantasy.zip`);
  process.exit(1);
}

let folder = src;
let tmp;
if (statSync(src).isFile()) {
  tmp = mkdtempSync(join(tmpdir(), 'cute-fantasy-'));
  try {
    execFileSync('unzip', ['-q', '-o', src, '-d', tmp]);
  } catch {
    // Windows 10+ ships bsdtar, which reads zip files
    execFileSync('tar', ['-xf', src, '-C', tmp]);
  }
  folder = tmp;
}

/** Find the directory that contains "NPCs (Premade)" — the pack root. */
function findRoot(dir, depth = 0) {
  if (existsSync(join(dir, 'NPCs (Premade)'))) return dir;
  if (depth > 3) return null;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      const r = findRoot(p, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

const packRoot = findRoot(resolve(folder));
if (!packRoot) {
  console.error('Could not find "NPCs (Premade)" inside the pack. Is this the Cute Fantasy RPG pack?');
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(packRoot, dest, { recursive: true });
if (tmp) rmSync(tmp, { recursive: true, force: true });

const required = [
  'NPCs (Premade)/Miner_Mike.png',
  'Tiles/Grass/Grass_Tiles_1.png',
  'Tiles/Water/Water_Tile_1.png',
  'Player/Player_Base/Player_Base_animations.png',
  'Icons/Outline/Resources_Icons_Outline.png',
];
const missing = required.filter((f) => !existsSync(join(dest, f)));
if (missing.length) {
  console.error('Imported, but these expected files are missing (pack version mismatch?):\n  ' + missing.join('\n  '));
  process.exit(1);
}
console.log(`Cute Fantasy assets imported to ${dest}`);
