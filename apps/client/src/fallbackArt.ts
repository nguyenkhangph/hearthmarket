import type Phaser from 'phaser';
import { NPCS, type NpcId } from '@hearth/economy';
import { cf, IMAGES, NPC_SHEETS, SHEETS, THEO_LAYERS, TILE, TILESETS } from './assets.ts';

/**
 * The Cute Fantasy pack is licensed art that this repository may not redistribute, so a
 * fresh clone has no images. Instead of a broken map, the game then draws simple stand-in
 * textures under the same keys and sizes, and every system (map, NPCs, panels, chain) works
 * the same. `npm run assets` brings the real art back.
 */
export const ART = { ok: true };

/** True when the pack is served next to the page (Vite dev may answer index.html for a missing file). */
export async function detectArt(): Promise<boolean> {
  try {
    const r = await fetch(cf(TILESETS.grassMid), { method: 'GET', cache: 'no-cache' });
    ART.ok = r.ok && (r.headers.get('content-type') ?? '').startsWith('image');
  } catch {
    ART.ok = false;
  }
  if (!ART.ok) document.body.dataset.art = 'fallback';
  return ART.ok;
}

const IMAGE_SIZE: Record<string, [number, number, string]> = {
  inn: [112, 112, '#b5523b'],
  smithy: [96, 96, '#6d6f80'],
  bakery: [80, 96, '#3f7fa8'],
  jackHouse: [80, 96, '#a8453a'],
  stoneHouse: [80, 96, '#5772a8'],
  windmill: [64, 112, '#c9b38a'],
  silo: [48, 80, '#b0866a'],
  cave: [48, 48, '#3b3b46'],
  well: [32, 48, '#8a8f9e'],
  bridge: [48, 64, '#8a6a46'],
  hay: [32, 32, '#d8b85a'],
};

const NPC_COLOR: Record<NpcId, string> = {
  mike: '#c98b52', jack: '#c0473a', buba: '#5aa04a', chloe: '#e7e7ef', theo: '#3a3a44', bruno: '#7b5fb0',
};

function canvas(scene: Phaser.Scene, key: string, w: number, h: number) {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const tex = scene.textures.createCanvas(key, w, h)!;
  const ctx = tex.getContext();
  ctx.imageSmoothingEnabled = false;
  return { tex, ctx };
}

function frames(tex: Phaser.Textures.CanvasTexture, fw: number, fh: number) {
  const cols = Math.floor(tex.width / fw);
  const rows = Math.floor(tex.height / fh);
  for (let i = 0; i < cols * rows; i++) tex.add(i, 0, (i % cols) * fw, Math.floor(i / cols) * fh, fw, fh);
}

function fill(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function building(ctx: CanvasRenderingContext2D, w: number, h: number, roof: string) {
  const wallTop = Math.round(h * 0.42);
  fill(ctx, '#e3d3b0', 6, wallTop, w - 12, h - wallTop - 4);
  ctx.fillStyle = roof;
  ctx.beginPath();
  ctx.moveTo(2, wallTop + 4);
  ctx.lineTo(w / 2, 6);
  ctx.lineTo(w - 2, wallTop + 4);
  ctx.closePath();
  ctx.fill();
  fill(ctx, '#6a4a32', w / 2 - 7, h - 24, 14, 20);
  fill(ctx, '#9fc7e6', 14, wallTop + 12, 12, 10);
  if (w > 50) fill(ctx, '#9fc7e6', w - 26, wallTop + 12, 12, 10);
}

function person(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, bob: number, facing: 'down' | 'side' | 'up') {
  const cx = x + 32;
  const top = y + 20 + bob;
  fill(ctx, 'rgba(0,0,0,.25)', cx - 8, y + 50, 16, 3);
  fill(ctx, color, cx - 7, top + 12, 14, 16); // body
  fill(ctx, '#3a2a22', cx - 6, top + 28, 5, 6); // legs
  fill(ctx, '#3a2a22', cx + 1, top + 28, 5, 6);
  fill(ctx, '#f0c8a0', cx - 6, top, 12, 12); // head
  if (facing !== 'up') {
    fill(ctx, '#2a2a2a', facing === 'side' ? cx + 2 : cx - 4, top + 5, 2, 2);
    if (facing === 'down') fill(ctx, '#2a2a2a', cx + 2, top + 5, 2, 2);
  } else fill(ctx, '#5a3a2a', cx - 6, top, 12, 6);
}

/** Stand-in textures under the keys the scene expects. Call before drawing the map. */
export function makeFallbackTextures(scene: Phaser.Scene) {
  // ground tiles
  const solid = (key: string, color: string, speck?: string) => {
    const { tex, ctx } = canvas(scene, key, TILE, TILE);
    fill(ctx, color, 0, 0, TILE, TILE);
    if (speck) [[3, 4], [11, 9], [6, 13]].forEach(([x, y]) => fill(ctx, speck, x, y, 1, 2));
    tex.refresh();
  };
  solid('grassMid', '#6ab04c', '#7fc35c');
  solid('grassMid2', '#64a847', '#5a9a40');
  solid('path', '#d6b98a', '#c8a978');
  solid('waterMid', '#4a8fc9', '#6aa9dc');
  const sheet = (key: string, w: number, h: number, draw?: (ctx: CanvasRenderingContext2D) => void) => {
    const { tex, ctx } = canvas(scene, key, w, h);
    draw?.(ctx);
    tex.refresh();
    return tex;
  };
  sheet('grass', 16 * TILE, 3 * TILE); // transparent: the path below shows
  sheet('water', 3 * TILE, 3 * TILE, (ctx) => fill(ctx, '#4a8fc9', 0, 0, 3 * TILE, 3 * TILE));
  sheet('farm', 7 * TILE, TILE, (ctx) => {
    fill(ctx, '#8a5a3a', 0, 0, 7 * TILE, TILE);
    for (let y = 2; y < TILE; y += 5) fill(ctx, '#7a4c30', 0, y, 7 * TILE, 2);
  });
  sheet('crops', 7 * TILE, 44 * TILE, (ctx) => {
    for (let i = 0; i < 7 * 44; i++) {
      const x = (i % 7) * TILE;
      const y = Math.floor(i / 7) * TILE;
      fill(ctx, '#d9b84a', x + 5, y + 4, 2, 10);
      fill(ctx, '#c9a63a', x + 9, y + 6, 2, 8);
    }
  });
  sheet('decor', 9 * TILE, 4 * TILE);
  sheet('pathDecor', 4 * TILE, 4 * TILE);

  // buildings and props
  for (const key of Object.keys(IMAGES)) {
    const [w, h, color] = IMAGE_SIZE[key] ?? [32, 32, '#888'];
    sheet(key, w, h, (ctx) => {
      if (key === 'bridge') {
        fill(ctx, '#8a6a46', 0, 20, w, 24);
        for (let x = 2; x < w; x += 6) fill(ctx, '#6e5236', x, 20, 1, 24);
      } else if (key === 'cave') {
        fill(ctx, '#55555f', 0, 8, w, h - 8);
        fill(ctx, '#1d1d24', 14, 22, 20, 26);
      } else if (key === 'well') {
        fill(ctx, color, 4, 24, 24, 20);
        fill(ctx, '#6a4a32', 6, 4, 3, 22);
        fill(ctx, '#6a4a32', 23, 4, 3, 22);
        fill(ctx, '#b5523b', 2, 2, 28, 5);
      } else if (key === 'hay') {
        fill(ctx, color, 2, 10, 28, 20);
      } else if (key === 'silo') {
        fill(ctx, color, 6, 16, w - 12, h - 18);
        fill(ctx, '#8a6450', 4, 8, w - 8, 10);
      } else building(ctx, w, h, color);
    });
  }
  for (const [key, s] of Object.entries(SHEETS)) {
    const cols = 8;
    const rows = 4;
    const tex = sheet(key, s.w * cols, s.h * rows, (ctx) => {
      for (let i = 0; i < cols * rows; i++) {
        const x = (i % cols) * s.w;
        const y = Math.floor(i / cols) * s.h;
        if (key === 'bigOak' || key === 'medOak' || key === 'spruce' || key === 'birch') {
          fill(ctx, '#6a4a32', x + s.w / 2 - 3, y + s.h - 16, 6, 14);
          ctx.fillStyle = key === 'spruce' ? '#2f6b45' : key === 'birch' ? '#7fb85a' : '#3f8a3a';
          ctx.beginPath();
          ctx.arc(x + s.w / 2, y + s.h / 2 - 2, s.w / 2 - 2, 0, Math.PI * 2);
          ctx.fill();
        } else if (key === 'stalls') {
          fill(ctx, ['#c0473a', '#3f7fa8', '#d8a83a', '#5aa04a'][i % 4], x + 2, y + 6, s.w - 4, 12);
          fill(ctx, '#8a6a46', x + 6, y + 18, s.w - 12, 22);
        } else if (key === 'ores') {
          fill(ctx, ['#8a8f9e', '#c98b52', '#d8c25a', '#6d6f80', '#9fc7e6'][i % 5], x + 3, y + 6, 10, 8);
        } else if (key === 'campfire') {
          fill(ctx, '#6a4a32', x + 3, y + 26, 10, 3);
          fill(ctx, i % 2 ? '#f0a03a' : '#e5602e', x + 5, y + 18 - (i % 3), 6, 8);
        } else if (key === 'barrels' || key === 'carts') {
          fill(ctx, '#8a5a3a', x + 2, y + s.h - 18, s.w - 4, 16);
        }
      }
    });
    frames(tex, s.w, s.h);
  }

  // NPCs: 6 columns x 6 rows of 64x64 (idle down/side/up, walk down/side/up)
  const facings = ['down', 'side', 'up', 'down', 'side', 'up'] as const;
  const drawPeople = (ctx: CanvasRenderingContext2D, cols: number, color: string) => {
    for (let r = 0; r < 6; r++) for (let c = 0; c < cols; c++) person(ctx, c * 64, r * 64, color, r >= 3 ? (c % 2 ? -1 : 0) : c % 3 === 0 ? -1 : 0, facings[r]);
  };
  for (const id of NPCS) {
    if (id === 'theo') continue;
    if (!NPC_SHEETS[id]) continue;
    const tex = sheet(`npc-${id}`, 6 * 64, 6 * 64, (ctx) => drawPeople(ctx, 6, NPC_COLOR[id]));
    frames(tex, 64, 64);
  }
  // Theo is composed from layers by the scene: give it one full layer and empty others
  THEO_LAYERS.forEach((_, i) => sheet(`theo-layer-${i}`, 9 * 64, 6 * 64, i === 0 ? (ctx) => drawPeople(ctx, 9, NPC_COLOR.theo) : undefined));
}

/** Item icon without the pack: a small coloured token with a letter. */
export const FALLBACK_ICON: Record<string, [string, string]> = {
  ore: ['#8a8f9e', 'O'], timber: ['#8a5a3a', 'T'], wheat: ['#d9b84a', 'W'], bread: ['#c98b52', 'B'],
  tools: ['#6d6f80', 'K'], sword: ['#9fc7e6', 'S'], gold: ['#e8c040', 'G'],
};
