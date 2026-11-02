import Phaser from 'phaser';
import type { Village } from '@hearth/economy';
import { cf, TILE } from './assets.ts';
import { BRIDGE, MAP_H, MAP_W } from './map.ts';

/**
 * Village life: everything on the map that is not the economy. Animated water, ducks and
 * a capybara in the river, a pasture with cows, sheep and a horse, chickens and pigs by the
 * farm, butterflies and bees, flowers in the wind, smoking chimneys, a turning windmill, a
 * fountain and bunting on the plaza, lanterns that light up at night, and weather that
 * follows the world feed (rain when Can Tho or Malacca has rain or a storm, wind when the
 * Pilbara has gusts, a warm haze in a Kansas heatwave). Only drawn with the licensed art.
 */
const t = (x: number) => x * TILE;

/** [path, frame width, frame height] */
const SHEETS: Record<string, [string, number, number]> = {
  chickenA: ['Animals/Chicken/Chicken_01.png', 32, 32],
  chickenB: ['Animals/Chicken/Chicken_07.png', 32, 32],
  rooster: ['Animals/Chicken/Rooster.png', 32, 32],
  cowA: ['Animals/Cow/Cow_01.png', 32, 32],
  cowB: ['Animals/Cow/Cow_03.png', 32, 32],
  sheepA: ['Animals/Sheep/Sheep_01.png', 32, 32],
  sheepB: ['Animals/Sheep/Sheep_02.png', 32, 32],
  horse: ['Animals/Horse/Horse_01.png', 32, 32],
  pigA: ['Animals/Pig/Pig_01.png', 32, 32],
  pigB: ['Animals/Pig/Pig_05.png', 32, 32],
  duckA: ['Animals/Duck/Duck_01.png', 32, 32],
  duckB: ['Animals/Duck/Duck_in_a_hat.png', 32, 32],
  capybara: ['Animals/Kapybara/Static/Kapybara_Idle.png', 32, 32],
  butterfly: ['Animals/Butterfly/Butterfly.png', 8, 8],
  bee: ['Animals/Bee/Bee_Flying_Animation.png', 16, 16],
  water: ['Tiles/Water/Water_Middle_Anim_1.png', 16, 16],
  fish: ['Tiles/Water/Fish_Animated_Tile.png', 16, 16],
  lilyGreen: ['Outdoor decoration/Outdoor_Decor_Animations/Water_Decor_Animations/Water_Plants/Lillypad_Green_1_Anim.png', 16, 16],
  lilyPurple: ['Outdoor decoration/Outdoor_Decor_Animations/Water_Decor_Animations/Water_Plants/Lillypad_Purple_2_Anim.png', 16, 16],
  cattail: ['Outdoor decoration/Outdoor_Decor_Animations/Water_Decor_Animations/Water_Plants/Cattail_1_Anim.png', 16, 16],
  cattail2: ['Outdoor decoration/Outdoor_Decor_Animations/Water_Decor_Animations/Water_Plants/Cattail_3_Anim.png', 16, 16],
  fountain: ['Outdoor decoration/Outdoor_Decor_Animations/Other_Animations/Fountain_Anim.png', 32, 48],
  bunting: ['Outdoor decoration/Outdoor_Decor_Animations/Other_Animations/Pole_and_Bunting_1_Anim.png', 32, 32],
  lantern: ['Outdoor decoration/Lanter_Posts.png', 16, 48],
  sail: ['Buildings/Buildings/Unique_Buildings/Windmill/Windmill_Sail_Anim.png', 64, 80],
  scarecrow: ['Outdoor decoration/Scarecrows.png', 32, 32],
  bench: ['Outdoor decoration/Benches.png', 32, 32],
  cloud: ['Weather effects/Clouds.png', 64, 64],
  wind: ['Weather effects/Wind_Anim.png', 16, 16],
  torch: ['Outdoor decoration/Outdoor_Decor_Animations/Other_Animations/Torch_Anim.png', 16, 32],
  anvil: ['Buildings/House_Decor/Anvil_Anim.png', 16, 16],
  ...Object.fromEntries([1, 3, 5, 7, 9, 11, 13, 15].map((n) => [`flower${n}`, [`Outdoor decoration/Outdoor_Decor_Animations/Grass_Animations/Flower_Grass_${n}_Anim.png`, 16, 16] as [string, number, number]])),
  ...Object.fromEntries([1, 2, 3].map((n) => [`grass${n}`, [`Outdoor decoration/Outdoor_Decor_Animations/Grass_Animations/Grass_${n}_Anim.png`, 16, 16] as [string, number, number]])),
};
const IMAGES: Record<string, string> = {
  beeNest: 'Animals/Bee/Bee_Nest.png',
  rainDrop: 'Weather effects/Rain_Drop.png',
};

export function preloadLife(scene: Phaser.Scene) {
  for (const [k, [p, w, h]] of Object.entries(SHEETS)) scene.load.spritesheet(`life-${k}`, cf(p), { frameWidth: w, frameHeight: h });
  for (const [k, p] of Object.entries(IMAGES)) scene.load.image(`life-${k}`, cf(p));
}

interface Species {
  key: string;
  cols: number;
  idle: readonly [number, number];
  walk: readonly [number, number];
  eat?: readonly [number, number];
  speed: number;
}
type Kind = Omit<Species, 'key'>;
/** row, frame count; 8 columns unless stated (pigs have 9) */
const COW = { cols: 8, idle: [0, 2], walk: [3, 8], eat: [6, 8], speed: 9 } as const;
const CHICKEN = { cols: 8, idle: [0, 2], walk: [1, 6], eat: [2, 8], speed: 16 } as const;
const PIG = { cols: 9, idle: [0, 2], walk: [3, 8], eat: [6, 9], speed: 10 } as const;
const DUCK = { cols: 8, idle: [7, 2], walk: [8, 4], speed: 8 } as const;

interface Critter {
  s: Phaser.GameObjects.Sprite;
  sp: Species;
  zone: Phaser.Geom.Rectangle;
  target?: { x: number; y: number };
  rest: number;
}

export class VillageLife {
  private critters: Critter[] = [];
  private glows: Phaser.GameObjects.Image[] = [];
  private flyers: { s: Phaser.GameObjects.Sprite; cx: number; cy: number; r: number; a: number; v: number }[] = [];
  private clouds: Phaser.GameObjects.Image[] = [];
  private rain?: Phaser.GameObjects.Particles.ParticleEmitter;
  private haze!: Phaser.GameObjects.Rectangle;
  private gloom!: Phaser.GameObjects.Rectangle;
  private windTimer = 0;
  private weather = { rain: false, wind: false, heat: false };
  private anvil?: Phaser.GameObjects.Sprite;
  private sparks?: Phaser.GameObjects.Particles.ParticleEmitter;

  constructor(private scene: Phaser.Scene) {}

  private anim(key: string, frames: number[], rate: number, repeat = -1) {
    const k = `life-${key}-${frames[0]}-${frames.length}`;
    if (!this.scene.anims.exists(k)) {
      this.scene.anims.create({ key: k, frames: frames.map((f) => ({ key: `life-${key}`, frame: f })), frameRate: rate, repeat });
    }
    return k;
  }

  private row(key: string, cols: number, row: number, n: number, rate: number) {
    return this.anim(key, Array.from({ length: n }, (_, i) => row * cols + i), rate);
  }

  private loop(key: string, x: number, y: number, n: number, rate: number, opts: { origin?: [number, number]; depth?: number; start?: number } = {}) {
    const s = this.scene.add.sprite(x, y, `life-${key}`, 0).setOrigin(...(opts.origin ?? [0, 0]));
    s.setDepth(opts.depth ?? y + s.height);
    s.play({ key: this.anim(key, Array.from({ length: n }, (_, i) => i), rate), startFrame: opts.start ?? Math.floor(Math.random() * n) });
    return s;
  }

  create() {
    const sc = this.scene;

    // ---------------- river: moving water, plants, fish, ducks, a capybara
    for (let y = 0; y < MAP_H; y++) {
      if (y >= BRIDGE.y - 1 && y <= BRIDGE.y + 2) continue; // under the bridge
      for (const x of [37, 38]) this.loop('water', t(x), t(y), 8, 5, { depth: -999, start: (x + y) % 8 });
    }
    for (const [k, x, y] of [['lilyGreen', 37, 4], ['lilyPurple', 38, 11], ['lilyGreen', 38, 23], ['lilyPurple', 37, 30], ['cattail', 37, 2], ['cattail2', 38, 6], ['cattail', 37, 21], ['cattail2', 38, 28]] as const) {
      this.loop(k, t(x), t(y), 8, 4, { depth: -998 });
    }
    for (const [x, y] of [[38, 8], [37, 26]]) this.loop('fish', t(x), t(y), 16, 6, { depth: -998 });
    this.critter('duckA', DUCK, new Phaser.Geom.Rectangle(t(37) + 6, t(1), 20, t(12)));
    this.critter('duckB', DUCK, new Phaser.Geom.Rectangle(t(37) + 6, t(21), 20, t(8)));
    this.loop('capybara', t(37) + 16, t(28) + 16, 9, 4, { origin: [0.5, 0.5], depth: t(28) + 20 });

    // ---------------- pasture (north-east): cows, sheep, a horse
    const pasture = new Phaser.Geom.Rectangle(t(40), t(2), t(7), t(5));
    for (const k of ['cowA', 'cowB', 'sheepA', 'sheepB', 'horse']) this.critter(k, COW, pasture);
    // ---------------- farmyard: chickens by the field, pigs at the back
    const yard = new Phaser.Geom.Rectangle(t(3), t(19) + 10, t(5), t(2) - 6);
    for (const k of ['chickenA', 'chickenB', 'chickenA', 'rooster']) this.critter(k, CHICKEN, yard);
    const sty = new Phaser.Geom.Rectangle(t(34), t(29) + 8, t(2), t(2));
    for (const k of ['pigA', 'pigB']) this.critter(k, PIG, sty);

    // ---------------- flowers and grass in the wind
    const tufts: [number, number][] = [
      [1, 14], [2, 13], [5, 14], [7, 13], [8, 15], [9, 14], [26, 1], [27, 3], [31, 1], [33, 2], [35, 1], [40, 9], [42, 10], [48, 8], [39, 6],
      [1, 21], [4, 20], [20, 22], [21, 29], [20, 31], [34, 21], [35, 26], [36, 30], [42, 21], [45, 23], [48, 27], [43, 30], [39, 24], [2, 30], [6, 31],
      [10, 13], [12, 15], [30, 1], [44, 1], [46, 9], [41, 27], [47, 31], [33, 30], [21, 24],
    ];
    const kinds = ['flower1', 'flower3', 'flower5', 'flower7', 'flower9', 'flower11', 'flower13', 'flower15', 'grass1', 'grass2', 'grass3'];
    tufts.forEach(([x, y], i) => this.loop(kinds[i % kinds.length], t(x), t(y), 8, 3 + (i % 3), { depth: t(y) + 4 }));

    // ---------------- butterflies over the flowers, bees over the field
    const bfly = [[3, 13], [33, 1], [43, 22], [20, 27], [44, 5]];
    bfly.forEach(([x, y], i) => {
      const s = sc.add.sprite(t(x), t(y), 'life-butterfly', i * 2).setDepth(5000);
      s.play(this.row('butterfly', 2, i % 8, 2, 8));
      this.flyers.push({ s, cx: t(x), cy: t(y), r: 18 + i * 3, a: i, v: 0.6 + i * 0.1 });
    });
    sc.add.image(t(7) + 8, t(21) + 4, 'life-beeNest').setOrigin(0.5, 1).setDepth(t(21) + 4).setScale(0.75);
    for (let i = 0; i < 3; i++) {
      const s = sc.add.sprite(t(10), t(24), 'life-bee', 0).setDepth(5000).setScale(0.75);
      s.play(this.anim('bee', [0, 1, 2, 3], 14));
      this.flyers.push({ s, cx: t(10) + i * 18, cy: t(24) + i * 10, r: 14 + i * 4, a: i * 2, v: 1.6 });
    }

    // ---------------- plaza: fountain, bunting, benches; farm scarecrow
    this.loop('fountain', t(23) + 8, t(15), 8, 8, { origin: [0.5, 1], depth: t(15) });
    for (let i = 0; i < 8; i++) this.loop('bunting', t(15) + i * 32, t(10) + 4, 8, 6, { depth: t(10) + 20, start: i % 8 });
    sc.add.image(t(20), t(14) + 6, 'life-bench', 1).setOrigin(0, 0).setDepth(t(15));
    sc.add.image(t(25) + 8, t(14) + 6, 'life-bench', 1).setOrigin(0, 0).setDepth(t(15));
    sc.add.sprite(t(11), t(25) + 4, 'life-scarecrow', 2).setOrigin(0, 0).setDepth(t(27));

    // ---------------- Theo's anvil: rings while he works (his sheet has no tool animation)
    this.anvil = sc.add.sprite(t(31) + 2, t(12) + 4, 'life-anvil', 0).setOrigin(0, 0).setDepth(t(13));
    this.sparks = sc.add.particles(t(31) + 10, t(12) + 6, this.sparkTexture(), {
      lifespan: 450, speed: { min: 30, max: 70 }, angle: { min: 200, max: 340 }, gravityY: 160,
      scale: { start: 1, end: 0.4 }, alpha: { start: 1, end: 0 }, quantity: 3, frequency: 650, emitting: false,
    }).setDepth(t(13) + 2);

    // ---------------- chimney smoke and the windmill
    const chimneys: [number, number][] = [[1.1, 2.2], [6.6, 1.7], [20.5, 5.1], [30, 5.5], [31.4, 7.8], [18, 22.4], [33.1, 23.6]];
    chimneys.forEach(([x, y], i) => {
      const s = sc.add.sprite(t(x) + 4, t(y), 'smoke', 0).setOrigin(0.3, 1).setDepth(9000).setAlpha(0.85);
      s.play({ key: this.smokeAnim(), startFrame: i % 5 });
    });
    this.loop('sail', t(0) + 32, t(22) + 42, 4, 3, { origin: [0.5, 0.5], depth: t(22) + 120 });

    // ---------------- lanterns along the main road, with a glow at night
    const glowTex = this.glowTexture();
    const posts: [number, number][] = [[3, 13], [9, 13], [33, 13], [41, 13], [47, 13], [5, 17], [15, 17], [26, 17], [34, 17], [43, 17]];
    for (const [x, y] of posts) {
      // first row of the sheet: a grey post whose flame flickers over 6 frames (16x48 each)
      const post = sc.add.sprite(t(x), t(y), 'life-lantern', 0).setOrigin(0, 0).setDepth(t(y) + 46);
      post.play({ key: this.anim('lantern', [0, 1, 2, 3, 4, 5], 6), startFrame: (x + y) % 6 });
      const g = sc.add.image(t(x) + 8, t(y) + 10, glowTex).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0).setScale(0.8).setDepth(10_001);
      this.glows.push(g);
    }
    for (const [x, y] of [[19, 24], [22, 25]]) {
      this.loop('torch', t(x), t(y), 8, 10, { depth: t(y) + 30 });
      this.glows.push(sc.add.image(t(x) + 8, t(y) + 6, glowTex).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0).setScale(0.7).setDepth(10_001));
    }

    // ---------------- sky: drifting cloud shadows, rain, wind, heat haze
    for (let i = 0; i < 4; i++) {
      const c = sc.add.image(Math.random() * t(MAP_W), t(4 + i * 7), 'life-cloud', i % 4).setScale(3).setTint(0x000000).setAlpha(0.14).setDepth(9500);
      this.clouds.push(c);
    }
    this.haze = sc.add.rectangle(0, 0, t(MAP_W), t(MAP_H), 0xff9a3c, 0).setOrigin(0).setDepth(9600);
    this.gloom = sc.add.rectangle(0, 0, t(MAP_W), t(MAP_H), 0x1c2c4a, 0).setOrigin(0).setDepth(9601);
    this.rain = sc.add.particles(0, -10, this.dropTexture(), {
      x: { min: 0, max: t(MAP_W) + 80 },
      lifespan: 1400,
      speedY: { min: 260, max: 330 },
      speedX: { min: -70, max: -50 },
      quantity: 5,
      frequency: 24,
      rotate: 12,
      alpha: { start: 0.75, end: 0.45 },
      emitting: false,
    }).setDepth(9700);
  }

  /** Theo works when the village works: the anvil animates and throws sparks. */
  setWorking(on: boolean) {
    if (!this.anvil) return;
    if (on && !this.anvil.anims.isPlaying) {
      this.anvil.play(this.anim('anvil', [0, 1, 2, 3, 4, 5, 6, 7], 10));
      this.sparks?.start();
    } else if (!on && this.anvil.anims.isPlaying) {
      this.anvil.stop().setFrame(0);
      this.sparks?.stop();
    }
  }

  private sparkTexture() {
    const key = 'life-spark';
    if (this.scene.textures.exists(key)) return key;
    const tex = this.scene.textures.createCanvas(key, 2, 2)!;
    const ctx = tex.getContext();
    ctx.fillStyle = '#ffd36b';
    ctx.fillRect(0, 0, 2, 2);
    tex.refresh();
    return key;
  }

  private smokeAnim() {
    const k = 'life-smoke';
    if (!this.scene.anims.exists(k)) this.scene.anims.create({ key: k, frames: this.scene.anims.generateFrameNumbers('smoke', { start: 0, end: 4 }), frameRate: 5, repeat: -1 });
    return k;
  }

  /** a thin streak reads as rain at this scale (the pack's drop is a 3 px dot, used for splashes) */
  private dropTexture() {
    const key = 'life-streak';
    if (this.scene.textures.exists(key)) return key;
    const tex = this.scene.textures.createCanvas(key, 2, 9)!;
    const ctx = tex.getContext();
    const g = ctx.createLinearGradient(0, 0, 0, 9);
    g.addColorStop(0, 'rgba(190,230,255,0)');
    g.addColorStop(1, 'rgba(210,240,255,0.95)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 2, 9);
    tex.refresh();
    return key;
  }

  private glowTexture() {
    const key = 'life-glow';
    if (this.scene.textures.exists(key)) return key;
    const tex = this.scene.textures.createCanvas(key, 96, 96)!;
    const ctx = tex.getContext();
    const g = ctx.createRadialGradient(48, 48, 2, 48, 48, 48);
    g.addColorStop(0, 'rgba(255,200,110,0.85)');
    g.addColorStop(0.35, 'rgba(255,170,80,0.35)');
    g.addColorStop(1, 'rgba(255,150,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 96, 96);
    tex.refresh();
    return key;
  }

  private critter(key: string, sp: Kind, zone: Phaser.Geom.Rectangle) {
    const s = this.scene.add.sprite(zone.x + Math.random() * zone.width, zone.y + Math.random() * zone.height, `life-${key}`, 0).setOrigin(0.5, 0.75);
    const c: Critter = { s, sp: { ...sp, key }, zone, rest: Math.random() * 3 };
    this.idle(c);
    this.critters.push(c);
  }

  private idle(c: Critter) {
    const eat = c.sp.eat && Math.random() < 0.5;
    const [row, n] = eat ? c.sp.eat! : c.sp.idle;
    c.s.play(this.row(c.sp.key, c.sp.cols, row, n, eat ? 7 : 3), true);
    c.target = undefined;
    c.rest = 2 + Math.random() * 4;
  }

  /** Night 0..1 lights the lanterns; the world feed sets the weather. */
  sync(v: Village, dark: number) {
    for (const g of this.glows) this.scene.tweens.add({ targets: g, alpha: dark > 0 ? 0.25 + dark : 0, duration: 800 });
    const sev = (id: string) => v.s.world.regions.find((r) => r.id === id)?.severity ?? 0;
    const w = { rain: sev('cantho') > 0.3 || sev('malacca') > 0.3, wind: sev('pilbara') > 0.3, heat: sev('kansas') > 0.3 };
    if (w.rain) w.heat = false;
    if (w.rain !== this.weather.rain) {
      if (w.rain) this.rain?.start();
      else this.rain?.stop();
      this.scene.tweens.add({ targets: this.gloom, fillAlpha: w.rain ? 0.16 : 0, duration: 1500 });
    }
    if (w.heat !== this.weather.heat) this.scene.tweens.add({ targets: this.haze, fillAlpha: w.heat ? 0.07 : 0, duration: 1500 });
    this.weather = w;
  }

  update(dtMs: number) {
    const dt = dtMs / 1000;
    for (const c of this.critters) {
      const s = c.s;
      if (!c.target) {
        c.rest -= dt;
        if (c.rest <= 0) {
          c.target = { x: c.zone.x + Math.random() * c.zone.width, y: c.zone.y + Math.random() * c.zone.height };
          s.play(this.row(c.sp.key, c.sp.cols, c.sp.walk[0], c.sp.walk[1], 8), true);
        }
      } else {
        const dx = c.target.x - s.x;
        const dy = c.target.y - s.y;
        const d = Math.hypot(dx, dy);
        const step = c.sp.speed * dt;
        if (d <= step) {
          s.setPosition(c.target.x, c.target.y);
          this.idle(c);
        } else {
          s.x += (dx / d) * step;
          s.y += (dy / d) * step;
          if (Math.abs(dx) > 0.5) s.setFlipX(dx < 0);
        }
      }
      s.setDepth(s.y + 6);
    }
    for (const f of this.flyers) {
      f.a += f.v * dt;
      f.s.setPosition(f.cx + Math.cos(f.a) * f.r, f.cy + Math.sin(f.a * 1.7) * f.r * 0.5);
      f.s.setFlipX(Math.sin(f.a) > 0);
    }
    const W = t(MAP_W);
    for (const c of this.clouds) {
      c.x += (this.weather.wind ? 22 : 6) * dt;
      if (c.x > W + 120) c.x = -120;
    }
    if (this.weather.wind) {
      this.windTimer -= dt;
      if (this.windTimer <= 0) {
        this.windTimer = 0.6 + Math.random();
        const s = this.scene.add.sprite(Math.random() * W * 0.8, Math.random() * t(MAP_H), 'life-wind', 0).setDepth(9650).setAlpha(0.8).setScale(1.5);
        s.play(this.anim('wind', Array.from({ length: 14 }, (_, i) => i), 14, 0));
        this.scene.tweens.add({ targets: s, x: s.x + 90, duration: 1000 });
        s.once('animationcomplete', () => s.destroy());
      }
    }
  }
}
