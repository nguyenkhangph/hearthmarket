import Phaser from 'phaser';
import { HOME, NPCS, NPC_DEFS, fmt, priceWhy, type Deal, type NpcId, type FeedEvent } from '@hearth/economy';
import { cf, IMAGES, NPC_SHEETS, SHEETS, THEO_LAYERS, TILE, TILESETS } from './assets.ts';
import { BRIDGE, buildGround, MAP_H, MAP_W, PROPS, wheatTiles, type Ground } from './map.ts';
import type { GameSource } from './source.ts';
import { ART, makeFallbackTextures } from './fallbackArt.ts';
import { preloadLife, VillageLife } from './life.ts';

const ROAD_ROW = 17;

/**
 * Work animations from the premade NPC sheets (rows below the walk cycles): Mike swings his
 * pickaxe, Jack his axe, Buba hoes and waters the field, Chloe and Bruno busy themselves.
 * Theo has no premade sheet; his anvil rings instead (life.ts). [row, frames, fps, flipX]
 */
const WORK: Partial<Record<NpcId, { row: number; n: number; fps: number; flip?: boolean }[]>> = {
  mike: [{ row: 7, n: 6, fps: 8 }],
  jack: [{ row: 7, n: 6, fps: 8, flip: true }],
  buba: [{ row: 8, n: 6, fps: 7 }, { row: 11, n: 6, fps: 6 }],
  chloe: [{ row: 6, n: 4, fps: 5 }],
  bruno: [{ row: 6, n: 4, fps: 4 }],
};
const isWorkHour = (h: number) => (h >= 6 && h < 14) || (h >= 18 && h < 20);
const WALK_SPEED = 42; // px per second

/** One line of a conversation between two agents, played as a speech bubble on the map. */
interface TalkStep { who: NpcId; text: string; cls: string; ms: number }
interface Talk { deal: Deal; steps: TalkStep[]; i: number; next: number; waitUntil: number; started: boolean; delivery?: boolean }

export interface MapHandlers {
  click: (id: NpcId) => void;
  hover?: (id: NpcId) => void;
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

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
  private life?: VillageLife;
  private working = false;
  private bubbles = new Map<NpcId, { el: HTMLElement; until: number; think?: boolean; talk?: boolean }>();
  /** agent deals already played on the map, by deal id */
  private played = new Set<number>();
  private talks: Talk[] = [];
  private talkDay = -1;
  /** the NPC under the pointer, for the price explanation */
  private whyFor: NpcId | null = null;
  private whyEl!: HTMLElement;

  constructor(private src: GameSource, private handlers: MapHandlers) {
    super('village');
  }

  private onNpcClick(id: NpcId) {
    this.handlers.click(id);
  }

  preload() {
    if (!ART.ok) return; // no licensed pack here: stand-in textures are drawn in create()
    for (const [k, p] of Object.entries(TILESETS)) this.load.image(k, cf(p));
    for (const [k, p] of Object.entries(IMAGES)) this.load.image(k, cf(p));
    for (const [k, s] of Object.entries(SHEETS)) this.load.spritesheet(k, cf(s.path), { frameWidth: s.w, frameHeight: s.h });
    for (const [k, p] of Object.entries(NPC_SHEETS)) this.load.spritesheet(`npc-${k}`, cf(p!), { frameWidth: 64, frameHeight: 64 });
    THEO_LAYERS.forEach((p, i) => this.load.image(`theo-layer-${i}`, cf(p)));
    preloadLife(this);
  }

  create() {
    if (!ART.ok) makeFallbackTextures(this);
    this.drawGround();
    this.buildMineCliff();
    this.placeProps();
    // fixed labels (stalls) follow the canvas when the window is resized
    this.scale.on('resize', () => this.time.delayedCall(0, () => this.sync()));
    this.composeTheo();
    this.createNpcAnims();
    this.anims.create({ key: 'campfire', frames: this.anims.generateFrameNumbers('campfire', { start: 0, end: 7 }), frameRate: 8, repeat: -1 });
    if (ART.ok) {
      this.life = new VillageLife(this);
      this.life.create();
    }

    this.night = this.add.rectangle(0, 0, MAP_W * TILE, MAP_H * TILE, 0x10142a, 0).setOrigin(0).setDepth(10_000);
    this.labels = document.getElementById('labels')!;

    const v = this.src.village();
    for (const id of NPCS) {
      const n = v.s.npcs[id];
      const key = `npc-${id}`;
      const sprite = this.add.sprite(n.x * TILE + 8, n.y * TILE + 8, key, 0).setOrigin(0.5, 0.62).setInteractive({ useHandCursor: true });
      sprite.on('pointerdown', () => this.onNpcClick(id));
      sprite.on('pointerover', () => this.showWhy(id));
      sprite.on('pointerout', () => this.hideWhy(id));
      sprite.play(`${key}-idle-down`);
      this.walkers.set(id, { id, sprite, key, target: [n.x, n.y], path: [], facing: 'down' });
      this.label(`npc:${id}`, `${NPC_DEFS[id].name} · ${NPC_DEFS[id].title}`, 'npc-label', () => this.onNpcClick(id));
      const lab = this.labelEls.get(`npc:${id}`)!;
      lab.addEventListener('mouseenter', () => this.showWhy(id));
      lab.addEventListener('mouseleave', () => this.hideWhy(id));
    }
    this.whyEl = document.getElementById('why-tip')!;
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

  /**
   * The mine: a rock face 7 tiles wide, cut as a 9-slice from the cliff sheet (left, middle
   * and right columns; rim, grass, face and foot rows), with the timbered entrance set in it.
   */
  private buildMineCliff() {
    const W = 7;
    const rows = [0, 16, 32, 48, 64, 80]; // source rows (16px) from top to bottom
    if (this.textures.exists('mineCliff')) this.textures.remove('mineCliff');
    const tex = this.textures.createCanvas('mineCliff', W * TILE, rows.length * TILE)!;
    const ctx = tex.getContext();
    ctx.imageSmoothingEnabled = false;
    if (ART.ok) {
      const src = this.textures.get('cliff').getSourceImage() as HTMLImageElement;
      for (let c = 0; c < W; c++) {
        const sx = c === 0 ? 16 : c === W - 1 ? 48 : 32;
        rows.forEach((sy, r) => ctx.drawImage(src, sx, sy, TILE, TILE, c * TILE, r * TILE, TILE, TILE));
      }
    } else {
      ctx.fillStyle = '#4f7a3a';
      ctx.fillRect(2, 0, W * TILE - 4, 3 * TILE);
      ctx.fillStyle = '#6d6f80';
      ctx.fillRect(2, 3 * TILE, W * TILE - 4, 4 * TILE - 6);
    }
    tex.refresh();
  }

  private placeProps() {
    for (const p of PROPS) {
      const x = p.x * TILE;
      const y = p.y * TILE;
      const obj = p.kind === 'image' ? this.add.image(x, y, p.key) : this.add.sprite(x, y, p.key, p.frame);
      obj.setOrigin(0, 0);
      // the windmill sheet also holds a still sail beside the tower; the animated one is in life.ts
      if (p.key === 'windmill' && ART.ok) obj.setCrop(0, 0, 56, 112);
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
      if (ART.ok) {
        (WORK[id] ?? []).forEach((w, i) =>
          this.anims.create({ key: `${key}-work${i}`, frames: Array.from({ length: w.n }, (_, k) => ({ key, frame: w.row * cols + k })), frameRate: w.fps, repeat: -1 }),
        );
      }
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
      if ((w.target[0] !== n.x || w.target[1] !== n.y) && !this.heldByTalk(id)) {
        w.target = [n.x, n.y];
        w.path = this.route(w.sprite.x, w.sprite.y, n.x * TILE + 8, n.y * TILE + 8);
      }
    }
    // night tint: dark from 20:00 to 05:00
    const h = v.hour;
    const dark = h >= 21 || h < 5 ? 0.5 : h === 19 || h === 20 || h === 5 ? 0.25 : 0;
    this.tweens.add({ targets: this.night, fillAlpha: dark, duration: 800 });
    this.life?.sync(v, dark);
    this.working = isWorkHour(h);
    this.life?.setWorking(this.working);
    this.queueTalks();
    if (this.whyFor) this.renderWhy();
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
    this.life?.update(dtMs);
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
        let anim = `${w.key}-idle-${w.facing === 'side' ? 'side' : w.facing}`;
        const jobs = ART.ok ? WORK[w.id] : undefined;
        const [hx, hy] = HOME[w.id];
        if (jobs && this.working && Math.abs(s.x - (hx * TILE + 8)) < 2 && Math.abs(s.y - (hy * TILE + 8)) < 2) {
          // alternate between the NPC's jobs every ~6 seconds
          const i = Math.floor(performance.now() / 6000 + w.id.length) % jobs.length;
          anim = `${w.key}-work${i}`;
          s.setFlipX(!!jobs[i].flip);
        } else if (ART.ok && w.id === 'theo' && this.working && Math.abs(s.x - (hx * TILE + 8)) < 2 && Math.abs(s.y - (hy * TILE + 8)) < 2) {
          anim = `${w.key}-idle-side`; // at the anvil, to his right
          s.setFlipX(false);
        }
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
    this.playTalks();
    if (this.whyFor) {
      // below the NPC, or above it near the bottom edge; never past the sides of the stage
      const s = this.walkers.get(this.whyFor)!.sprite;
      const host = this.labels.getBoundingClientRect();
      const w = this.whyEl.offsetWidth;
      const h = this.whyEl.offsetHeight;
      const below = this.toScreen(s.x, s.y + 14);
      const above = this.toScreen(s.x, s.y - 30);
      const x = Math.min(Math.max(below.x - w / 2, 8), host.width - w - 8);
      const y = below.y + h + 8 > host.height ? above.y - h : below.y;
      this.whyEl.style.transform = `translate(${x}px, ${Math.max(8, y)}px)`;
    }
  }

  // ------------------------------------------------------------------ why this price
  private showWhy(id: NpcId) {
    this.whyFor = id;
    this.renderWhy();
    this.whyEl.classList.remove('hidden');
    this.handlers.hover?.(id);
  }

  private hideWhy(id: NpcId) {
    if (this.whyFor !== id) return;
    this.whyFor = null;
    this.whyEl.classList.add('hidden');
  }

  /** The same numbers the engine uses, in words: market stock, world price and weather, plan, deals. */
  private renderWhy() {
    const id = this.whyFor!;
    const w = priceWhy(this.src.village(), id);
    this.whyEl.innerHTML = `<div class="wt-head"><b>${escHtml(NPC_DEFS[id].name)}</b> · why this price</div><div>${escHtml(w.head)}</div><ul>${w.lines.slice(0, 5).map((l) => `<li>${escHtml(l)}</li>`).join('')}</ul><div class="muted">Click for the diary and the deals.</div>`;
  }

  // ------------------------------------------------------------------ agents negotiating on the map
  /**
   * Each morning the agents strike their deals; from 6:00 the sellers walk to the buyer's
   * workshop (engine.meetings) and the first delivery settles there. The map plays the
   * conversation as alternating speech bubbles, then the deal and the delivery.
   */
  private queueTalks() {
    const v = this.src.village();
    if (v.day !== this.talkDay) {
      this.talkDay = v.day;
      for (const t of this.talks) this.endTalk(t);
      this.talks = [];
    }
    if (v.hour < 6 || v.hour > 11 || (this.src as { fastForwarding?: boolean }).fastForwarding) return;
    for (const d of (v.s.deals ?? []).filter((x) => x.day === v.day && !this.played.has(x.id))) {
      this.played.add(d.id);
      // one conversation per agent at a time: Theo talks to Mike, then to Jack
      const busyUntil = Math.max(0, ...this.talks.filter((t) => [t.deal.buyer, t.deal.seller].some((n) => n === d.buyer || n === d.seller)).map((t) => t.waitUntil + t.steps.reduce((a, s) => a + s.ms, 0)));
      this.talks.push({ deal: d, steps: this.talkSteps(d), i: 0, next: 0, waitUntil: Math.max(performance.now() + 8000, busyUntil), started: false });
    }
  }

  private talkSteps(d: Deal): TalkStep[] {
    // long haggles: the opening, then the closing words
    const rounds = d.rounds.length > 4 ? [...d.rounds.slice(0, 2), ...d.rounds.slice(-2)] : d.rounds;
    const steps: TalkStep[] = rounds.map((r) => {
      let text = r.say.length > 90 ? `${r.say.slice(0, 88)}…` : r.say;
      if (r.price && !/\d/.test(text)) text += ` (${fmt(r.price, 2)})`;
      return { who: r.who, text, cls: 'bubble-talk', ms: 1600 };
    });
    if (d.status === 'agreed') {
      steps.push({ who: d.buyer, text: `🤝 Deal: ${fmt(d.price!, 2)} per ${d.item}`, cls: 'bubble-deal', ms: 2400 });
    } else {
      steps.push({ who: d.buyer, text: '✗ No deal: off to the market', cls: 'bubble-blocked', ms: 2400 });
    }
    return steps;
  }

  private playTalks() {
    const now = performance.now();
    const v = this.src.village();
    for (const t of [...this.talks]) {
      if (!t.started) {
        const arrived = [t.deal.buyer, t.deal.seller].every((id) => this.walkers.get(id)!.path.length === 0);
        if (now < t.waitUntil - 6500 || (!arrived && now < t.waitUntil)) continue;
        t.started = true;
        t.next = now;
      }
      if (now < t.next) continue;
      if (t.i === t.steps.length && !t.delivery) {
        t.delivery = true;
        // the delivery that settled at the agreed price, if any
        const d = t.deal;
        const hire = d.status === 'agreed' && v.s.txs.find((x) => x.method === 'hire' && x.signer === NPC_DEFS[d.buyer].account && x.args.seller === NPC_DEFS[d.seller].account && x.args.price === d.price && x.t >= d.day * 24 - 24);
        if (hire) t.steps.push({ who: d.seller, text: `📦 ${hire.args.qty} ${d.item} delivered to ${NPC_DEFS[d.buyer].name}`, cls: 'bubble-deal', ms: 2400 });
      }
      if (t.i > t.steps.length - 1) {
        this.endTalk(t);
        this.talks.splice(this.talks.indexOf(t), 1);
        continue;
      }
      const st = t.steps[t.i++];
      const other = st.who === t.deal.buyer ? t.deal.seller : t.deal.buyer;
      const ob = this.bubbles.get(other);
      if (ob?.talk) { ob.el.remove(); this.bubbles.delete(other); }
      this.say(st.who, st.text, st.cls, st.ms);
      t.next = now + st.ms;
    }
  }

  private say(id: NpcId, text: string, cls: string, ms: number) {
    this.bubbles.get(id)?.el.remove();
    const el = document.createElement('div');
    el.className = `bubble ${cls}`;
    el.textContent = text;
    this.labels.appendChild(el);
    this.bubbles.set(id, { el, until: performance.now() + ms + 150, talk: true });
  }

  private endTalk(t: Talk) {
    for (const id of [t.deal.buyer, t.deal.seller]) {
      const b = this.bubbles.get(id);
      if (b?.talk) { b.el.remove(); this.bubbles.delete(id); }
    }
  }

  /** An agent at the buyer's workshop stays there until its conversation is over. */
  private heldByTalk(id: NpcId) {
    const s = this.walkers.get(id)!.sprite;
    return this.talks.some((t) => {
      if (t.deal.buyer !== id && t.deal.seller !== id) return false;
      const [hx, hy] = HOME[t.deal.buyer];
      return Math.abs(s.x - (hx * TILE + 8)) <= 3 * TILE && Math.abs(s.y - (hy * TILE + 8)) <= 3 * TILE;
    });
  }

  private talking(id: NpcId) {
    return this.talks.some((t) => t.deal.buyer === id || t.deal.seller === id);
  }

  // ------------------------------------------------------------------ DOM overlays
  private toScreen(x: number, y: number) {
    const canvas = this.game.canvas;
    const r = canvas.getBoundingClientRect();
    const host = this.labels.getBoundingClientRect();
    // r is in screen pixels; label offsets are in the host's own (untransformed) pixels
    const k = canvas.offsetWidth ? r.width / canvas.offsetWidth : 1;
    return { x: (r.left - host.left + (x / (MAP_W * TILE)) * r.width) / k, y: (r.top - host.top + (y / (MAP_H * TILE)) * r.height) / k };
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
    if (!e.npc || !['deal', 'order', 'blocked', 'craft', 'hunger', 'think'].includes(e.kind)) return;
    if (this.talking(e.npc) && e.kind !== 'blocked') return; // the conversation has the floor
    if (e.kind === 'deal' && / agree | find no deal /.test(e.text)) return; // played as a conversation at 6:00
    if (e.kind !== 'think' && this.bubbles.get(e.npc)?.think && performance.now() < this.bubbles.get(e.npc)!.until) return; // let a thought finish
    const think = e.kind === 'think';
    const text = e.text.replace(/ · tx .*$/, '').replace(`${NPC_DEFS[e.npc].name} `, '').replace(/^thinks( \([^)]*\))?: /, '💭 ');
    this.bubbles.get(e.npc)?.el.remove();
    const el = document.createElement('div');
    el.className = `bubble ${e.kind === 'blocked' ? 'bubble-blocked' : ''} ${think ? 'bubble-think' : ''}`;
    const max = think ? 120 : 48;
    el.textContent = text.length > max ? text.slice(0, max - 2) + '…' : text;
    this.labels.appendChild(el);
    this.bubbles.set(e.npc, { el, until: performance.now() + (think ? 8000 : 4500), think });
  }
}

export function startGame(parent: HTMLElement, src: GameSource, handlers: MapHandlers) {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: MAP_W * TILE,
    height: MAP_H * TILE,
    pixelArt: true,
    backgroundColor: '#120d0a',
    // fill the whole stage (no side bars); a sliver of the map edge is cropped instead
    scale: { mode: Phaser.Scale.ENVELOP, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: new VillageScene(src, handlers),
  });
}
