/**
 * The village map, 50 x 32 tiles of 16px. Ground is built procedurally from
 * Cute Fantasy autotiles; buildings and props are placed on top and y-sorted.
 * (A Tiled map can replace this later without touching the scene code.)
 */
export const MAP_W = 50;
export const MAP_H = 32;

export type Ground = 'g' | 'p' | 'w' | 'f';

export function buildGround(): Ground[][] {
  const m: Ground[][] = Array.from({ length: MAP_H }, () => Array<Ground>(MAP_W).fill('g'));
  const rect = (x0: number, y0: number, x1: number, y1: number, t: Ground) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (m[y]?.[x] !== undefined) m[y][x] = t;
  };
  rect(0, 16, 49, 18, 'p'); // main road
  rect(22, 0, 24, 31, 'p'); // north-south road
  rect(15, 12, 31, 20, 'p'); // plaza
  rect(11, 12, 14, 14, 'p'); // inn door
  rect(17, 19, 18, 21, 'p'); // to Jack
  rect(29, 19, 30, 21, 'p'); // to stone house
  rect(10, 19, 11, 21, 'p'); // to farm
  rect(43, 12, 45, 15, 'p'); // to mine
  rect(8, 22, 14, 29, 'f'); // Buba's field
  rect(37, 0, 38, 31, 'w'); // river
  return m;
}

export interface Prop {
  kind: 'image' | 'frame';
  key: string;
  frame?: number;
  /** tile column / row of the sprite's top-left corner */
  x: number;
  y: number;
  /** extra depth bias, in px */
  bias?: number;
  anim?: string;
}

const trees: Prop[] = [];
const T = (key: string, frame: number, x: number, y: number) => trees.push({ kind: 'frame', key, frame, x, y });
// north edge
for (const x of [26, 29, 32, 35]) T('medOak', 2, x, -1);
T('spruce', 2, 17, -1); T('spruce', 2, 19, 0);
// east bank forest
for (const [x, y] of [[40, 20], [43, 22], [46, 19], [40, 25], [44, 26], [47, 24], [41, 29], [46, 29], [48, 15]]) T('medOak', 2, x, y);
T('bigOak', 2, 45, -2); T('spruce', 2, 48, 3); T('spruce', 2, 40, 0);
// west & south
for (const [x, y] of [[0, 12], [3, 13], [0, 29], [33, 28], [36, 25], [20, 27], [6, 9]]) T('medOak', 2, x, y);
T('bigOak', 2, 32, 21); T('spruce', 2, 2, 20); T('spruce', 2, 34, 13);

export const PROPS: Prop[] = [
  { kind: 'image', key: 'inn', x: 0, y: 0 },
  { kind: 'image', key: 'bakery', x: 15, y: 4 },
  { kind: 'image', key: 'smithy', x: 26, y: 4 },
  { kind: 'image', key: 'jackHouse', x: 14, y: 21 },
  { kind: 'image', key: 'stoneHouse', x: 26, y: 22 },
  { kind: 'image', key: 'windmill', x: 0, y: 22 },
  { kind: 'image', key: 'silo', x: 5, y: 26 },
  { kind: 'image', key: 'cave', x: 43, y: 9 },
  { kind: 'image', key: 'well', x: 27, y: 18, bias: 4 },
  { kind: 'image', key: 'hay', x: 9, y: 21 },
  // four market stalls, one per guild slot
  { kind: 'frame', key: 'stalls', frame: 0, x: 15, y: 12 },
  { kind: 'frame', key: 'stalls', frame: 1, x: 18, y: 12 },
  { kind: 'frame', key: 'stalls', frame: 2, x: 26, y: 12 },
  { kind: 'frame', key: 'stalls', frame: 3, x: 29, y: 12 },
  // mine
  { kind: 'frame', key: 'ores', frame: 1, x: 41, y: 10 },
  { kind: 'frame', key: 'ores', frame: 2, x: 46, y: 9 },
  { kind: 'frame', key: 'ores', frame: 4, x: 47, y: 11 },
  { kind: 'frame', key: 'ores', frame: 0, x: 41, y: 12 },
  { kind: 'frame', key: 'carts', frame: 1, x: 45, y: 10 },
  // barrels and crates
  { kind: 'frame', key: 'barrels', frame: 0, x: 21, y: 9 },
  { kind: 'frame', key: 'barrels', frame: 1, x: 14, y: 9 },
  { kind: 'frame', key: 'barrels', frame: 3, x: 25, y: 10 },
  { kind: 'frame', key: 'barrels', frame: 7, x: 33, y: 19 },
  { kind: 'frame', key: 'campfire', frame: 0, x: 20, y: 25, anim: 'campfire' },
  ...trees,
];

/** Wheat plants on Buba's field (Crops.png frames 9-12 are growth stages). */
export function wheatTiles(): { x: number; y: number; stage: number }[] {
  const out = [];
  for (let y = 23; y <= 29; y++) for (let x = 8; x <= 14; x++) out.push({ x, y, stage: 9 + ((x * 7 + y * 3) % 4) });
  return out;
}

/** Bridge over the river on the main road. */
export const BRIDGE = { x: 36, y: 16 };
