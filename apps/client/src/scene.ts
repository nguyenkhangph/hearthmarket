import Phaser from 'phaser';
import { NPCS, NPC_DEFS, type NpcId, type FeedEvent } from '@hearth/economy';
import { cf, IMAGES, NPC_SHEETS, SHEETS, THEO_LAYERS, TILE, TILESETS } from './assets.ts';
import { BRIDGE, buildGround, MAP_H, MAP_W, PROPS, wheatTiles, type Ground } from './map.ts';
import type { GameSource } from './source.ts';

const ROAD_ROW = 17;
const WALK_SPEED = 42; // px per second

interface Walker {
  id: NpcId;
  sprite: Phaser.GameObjects.Sprite;
  key: string;
  target: [number, number];
  path: { x: number; y: number }[];
  facing: 'down' | 'side' | 'up';
}

/** Village map scene. Everything outside the canvas (labels, panels) is DOM. */
export class VillageScene extends Phaser.Scene {
  private walkers = new Map<NpcId, Walker>();
  private night!: Phaser.GameObjects.Rectangle;
  private labels!: HTMLElement;
  private labelEls = new Map<string, HTMLElement>();
  private bubbles = new Map<NpcId, { el: HTMLElement; until: number }>();

  constructor(private src: GameSource, private onNpcClick: (id: NpcId) => void) {
    super('village');
  }

  preload() {
    for (const [k, p] of Object.entries(TILESETS)) this.load.image(k, cf(p));
    for (const [k, p] of Object.entries(IMAGES)) this.load.image(k, cf(p));
    for (const [k, s] of Object.entries(SHEETS)) this.load.spritesheet(k, cf(s.path), { frameWidth: s.w, frameHeight: s.h });
    for (const [k, p] of Object.entries(NPC_SHEETS)) this.load.spritesheet(`npc-${k}`, cf(p!), { frameWidth: 64, frameHeight: 64 });
    THEO_LAYERS.forEach((p, i) => this.load.image(`theo-layer-${i}`, cf(p)));
  }

  create() {
    this.drawGround();
    this.placeProps();
    this.composeTheo();
    this.createNpcAnims();
    this.anims.create({ key: 'campfire', frames: this.anims.generateFrameNumbers('campfire', { start: 0, end: 7 }), frameRate: 8, repeat: -1 });

    this.night = this.add.rectangle(0, 0, MAP_W * TILE, MAP_H * TILE, 0x10142a, 0).setOrigin(0).setDepth(10_000);
    this.labels = document.getElementById('labels')!;

    const v = this.src.village();
    for (const id of NPCS) {
      const n = v.s.npcs[id];
      const key = `npc-${id}`;
      const sprite = this.add.sprite(n.x * TILE + 8, n.y * TILE + 8, key, 0).setOrigin(0.5, 0.62).setInteractive({ useHandCursor: true });
      sprite.on('pointerdown', () => this.onNpcClick(id));
      sprite.play(`${key}-idle-down`);
      this.walkers.set(id, { id, sprite, key, target: [n.x, n.y], path: [], facing: 'down' });
      this.label(`npc:${id}`, `${NPC_DEFS[id].name} · ${NPC_DEFS[id].title}`, 'npc-label', () => this.onNpcClick(id));
    }
    this.src.onUpdate(() => this.sync());
    this.src.onFeed((e) => this.bubble(e));
    this.sync();
  }

  // ------------------------------------------------------------------ ground
  private drawGround() {
    const g = buildGround();
    const W = MAP_W * TILE;
    const H = MAP_H * TILE;
    const tex = this.textures.createCanvas('ground', W, H)!;
    const ctx = tex.getContext();
    ctx.imageSmoothingEnabled = false;
    const img = (k: string) => this.textures.get(k).getSourceImage() as HTMLImageElement;
    const tile = (k: string, cols: number, idx: number, x: number, y: number) =>
      ctx.drawImage(img(k), (idx % cols) * TILE, Math.floor(idx / cols) * TILE, TILE, TILE, x * TILE, y * TILE, TILE, TILE);
    const at = (x: number, y: number): Ground => g[Math.min(MAP_H - 1, Math.max(0, y))][Math.min(MAP_W - 1, Math.max(0, x))];
    const hole = (t: Ground) => t === 'p' || t === 'f';

    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const t = g[y][x];
        if (t === 'w') { ctx.drawImage(img('waterMid'), x * TILE, y * TILE); continue; }
        if (t === 'p' || t === 'f') {
          ctx.drawImage(img('path'), x * TILE, y * TILE);
          if (t === 'f') tile('farm', 7, 0, x, y);
          continue;
        }
        // grass: water edges first (opaque tiles that include grass)
        const nW = at(x - 1, y), nE = at(x + 1, y), nN = at(x, y - 1), nS = at(x, y + 1);
        const w = (a: Ground) => a === 'w';
        if (w(nE) || w(nW) || w(nN) || w(nS) || w(at(x + 1, y + 1)) || w(at(x - 1, y + 1)) || w(at(x + 1, y - 1)) || w(at(x - 1, y - 1))) {
          const idx = w(nE) && !w(nW) ? 3 : w(nW) && !w(nE) ? 5 : w(nS) ? 1 : w(nN) ? 7
            : w(at(x + 1, y + 1)) ? 0 : w(at(x - 1, y + 1)) ? 2 : w(at(x + 1, y - 1)) ? 6 : 8;
          if (w(nE) && w(nW)) ctx.drawImage(img('waterMid'), x * TILE, y * TILE);
          else tile('water', 3, idx, x, y);
          continue;
        }
        ctx.drawImage(img((x * 13 + y * 7) % 9 === 0 ? 'grassMid2' : 'grassMid'), x * TILE, y * TILE);
        const h = { e: hole(nE), w: hole(nW), n: hole(nN), s: hole(nS) };
        const orth = Number(h.e) + Number(h.w) + Number(h.n) + Number(h.s);
        let idx = -1;
        if (orth >= 2) {
          ctx.drawImage(img('path'), x * TILE, y * TILE);
          continue;
        } else if (h.e) idx = 16;
        else if (h.w) idx = 18;
        else if (h.s) idx = 1;
        else if (h.n) idx = 33;
        else if (hole(at(x + 1, y + 1))) idx = 0;
        else if (hole(at(x - 1, y + 1))) idx = 2;
        else if (hole(at(x + 1, y - 1))) idx = 32;
        else if (hole(at(x - 1, y - 1))) idx = 34;
        if (idx >= 0) {
          ctx.drawImage(img('path'), x * TILE, y * TILE);
          tile('grass', 16, idx, x, y);
        }
      }
    }
    // bridge: left end, three plank columns, right end (Bridge_Wood_1, 48x64 piece)
    const bridge = img('bridge');
    const bx = BRIDGE.x * TILE - 8;
    const by = (BRIDGE.y - 1) * TILE;
    const cols = [0, 16, 16, 16, 32];
    cols.forEach((sx, i) => ctx.drawImage(bridge, sx, 0, 16, 64, bx + i * 16, by, 16, 64));
    tex.refresh();
    this.add.image(0, 0, 'ground').setOrigin(0).setDepth(-1000);

    const crops = this.textures.get('crops');
    for (let i = 0; i < 7 * 44; i++) if (!crops.has(String(i))) crops.add(String(i), 0, (i % 7) * 16, Math.floor(i / 7) * 16, 16, 16);
    for (const w of wheatTiles()) this.add.image(w.x * TILE, w.y * TILE, 'crops', String(w.stage)).setOrigin(0).setDepth(w.y * TILE + 14);
  }

  private placeProps() {
    for (const p of PROPS) {
      const x = p.x * TILE;
      const y = p.y * TILE;
      const obj = p.kind === 'image' ? this.add.image(x, y, p.key) : this.add.sprite(x, y, p.key, p.frame);
      obj.setOrigin(0, 0);
      obj.setDepth(y + obj.height - 6 + (p.bias ?? 0));
      if (p.anim && obj instanceof Phaser.GameObjects.Sprite) this.time.delayedCall(10, () => obj.play(p.anim!));
    }
  }

  /** Theo has no premade sheet: stack the modular layers into one spritesheet. */
  private composeTheo() {
    const base = this.textures.get('theo-layer-0').getSourceImage() as HTMLImageElement;
    const rows = 6;
    const canvas = this.textures.createCanvas('npc-theo', base.width, rows * 64)!;
    const ctx = canvas.getContext();
    ctx.imageSmoothingEnabled = false;
    THEO_LAYERS.forEach((_, i) => {
      const layer = this.textures.get(`theo-layer-${i}`).getSourceImage() as HTMLImageElement;
      ctx.drawImage(layer, 0, 0, layer.width, rows * 64, 0, 0, layer.width, rows * 64);
    });
    canvas.refresh();
    const cols = base.width / 64;
    for (let i = 0; i < cols * rows; i++) canvas.add(i, 0, (i % cols) * 64, Math.floor(i / cols) * 64, 64, 64);
    (canvas as Phaser.Textures.Texture & { __cols?: number }).__cols = cols;
  }

  private createNpcAnims() {
    for (const id of NPCS) {
      const key = `npc-${id}`;
      const cols = id === 'theo' ? (this.textures.get(key).getSourceImage() as HTMLCanvasElement).width / 64 : 6;
      const row = (r: number, n = 6) => Array.from({ length: n }, (_, i) => ({ key, frame: r * cols + i }));
      const mk = (name: string, r: number, rate: number) =>
        this.anims.create({ key: `${key}-${name}`, frames: row(r), frameRate: rate, repeat: -1 });
      mk('idle-down', 0, 5);
      mk('idle-side', 1, 5);
      mk('idle-up', 2, 5);
      mk('walk-down', 3, 9);
      mk('walk-side', 4, 9);
      mk('walk-up', 5, 9);
    }
  }

  // ------------------------------------------------------------------ live state
  private sync() {
    const v = this.src.village();
    for (const id of NPCS) {
      const n = v.s.npcs[id];
      const w = this.walkers.get(id)!;
      if (w.target[0] !== n.x || w.target[1] !== n.y) {
        w.target = [n.x, n.y];
        w.path = this.route(w.sprite.x, w.sprite.y, n.x * TILE + 8, n.y * TILE + 8);
      }
    }
    // night tint: dark from 20:00 to 05:00
    const h = v.hour;
    const dark = h >= 20 || h < 5 ? 0.38 : h === 19 || h === 5 ? 0.18 : 0;
    this.tweens.add({ targets: this.night, fillAlpha: dark, duration: 800 });
    // stall owners
    v.s.stalls.forEach((st, i) => {
      const gl = st.guild ? v.s.guilds[st.guild] : null;
      const xs = [15, 18, 26, 29];
      this.label(`stall:${i}`, gl ? gl.name : 'For rent', gl ? 'stall-label owned' : 'stall-label');
      this.positionLabel(`stall:${i}`, xs[i] * TILE + 24, 15 * TILE + 12);
    });
  }

  /** L-shaped walk that uses the main road (and the bridge) between far points. */
  private route(x0: number, y0: number, x1: number, y1: number) {
    const roadY = ROAD_ROW * TILE + 8;
    if (Math.abs(x1 - x0) < 4 * TILE) return [{ x: x1, y: y0 }, { x: x1, y: y1 }];
    return [{ x: x0, y: roadY }, { x: x1, y: roadY }, { x: x1, y: y1 }];
  }

  update(_t: number, dtMs: number) {
    const dt = dtMs / 1000;
    for (const w of this.walkers.values()) {
      const s = w.sprite;
      const next = w.path[0];
      if (next) {
        const dx = next.x - s.x;
        const dy = next.y - s.y;
        const dist = Math.hypot(dx, dy);
        const stepLen = WALK_SPEED * dt;
        if (dist <= stepLen) {
          s.setPosition(next.x, next.y);
          w.path.shift();
        } else {
          s.x += (dx / dist) * stepLen;
          s.y += (dy / dist) * stepLen;
        }
        const facing = Math.abs(dx) > Math.abs(dy) ? 'side' : dy < 0 ? 'up' : 'down';
        s.setFlipX(facing === 'side' && dx < 0);
        w.facing = facing;
        const anim = `${w.key}-walk-${facing}`;
        if (s.anims.currentAnim?.key !== anim) s.play(anim);
      } else {
        const anim = `${w.key}-idle-${w.facing === 'side' ? 'side' : w.facing}`;
        if (s.anims.currentAnim?.key !== anim) s.play(anim);
      }
      s.setDepth(s.y + 8);
      this.positionLabel(`npc:${w.id}`, s.x, s.y - 22);
      const b = this.bubbles.get(w.id);
      if (b) {
        if (performance.now() > b.until) {
          b.el.remove();
          this.bubbles.delete(w.id);
        } else this.placeEl(b.el, s.x, s.y - 36);
      }
    }
  }

  // ------------------------------------------------------------------ DOM overlays
  private toScreen(x: number, y: number) {
    const canvas = this.game.canvas;
    const r = canvas.getBoundingClientRect();
    const host = this.labels.getBoundingClientRect();
    return { x: r.left - host.left + (x / (MAP_W * TILE)) * r.width, y: r.top - host.top + (y / (MAP_H * TILE)) * r.height };
  }

  private placeEl(el: HTMLElement, x: number, y: number) {
    const p = this.toScreen(x, y);
    el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
  }

  private label(id: string, text: string, cls: string, onClick?: () => void) {
    let el = this.labelEls.get(id);
    if (!el) {
      el = document.createElement('div');
      this.labels.appendChild(el);
      this.labelEls.set(id, el);
      if (onClick) el.addEventListener('click', onClick);
    }
    if (el.textContent !== text) el.textContent = text;
    el.className = `map-label ${cls}`;
  }

  private positionLabel(id: string, x: number, y: number) {
    const el = this.labelEls.get(id);
    if (el) this.placeEl(el, x, y);
  }

  private bubble(e: FeedEvent) {
    if (!e.npc || !['deal', 'order', 'blocked', 'craft', 'hunger'].includes(e.kind)) return;
    const text = e.text.replace(/ · tx .*$/, '').replace(`${NPC_DEFS[e.npc].name} `, '');
    this.bubbles.get(e.npc)?.el.remove();
    const el = document.createElement('div');
    el.className = `bubble ${e.kind === 'blocked' ? 'bubble-blocked' : ''}`;
    el.textContent = text.length > 48 ? text.slice(0, 46) + '…' : text;
    this.labels.appendChild(el);
    this.bubbles.set(e.npc, { el, until: performance.now() + 4500 });
  }
}

export function startGame(parent: HTMLElement, src: GameSource, onNpcClick: (id: NpcId) => void) {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: MAP_W * TILE,
    height: MAP_H * TILE,
    pixelArt: true,
    backgroundColor: '#1b1e2b',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: new VillageScene(src, onNpcClick),
  });
}
