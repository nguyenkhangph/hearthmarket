import type { ItemId, NpcId } from '@hearth/economy';

/**
 * Every Cute Fantasy file the game uses, relative to the pack root.
 * The pack is imported locally with `npm run assets` (never committed).
 */
export const CF = 'assets/cute_fantasy/';
export const cf = (p: string) => CF + p.split('/').map(encodeURIComponent).join('/');

export const TILE = 16;

export const TILESETS = {
  grass: 'Tiles/Grass/Grass_Tiles_1.png', // 16 cols: grass autotile with transparent holes
  grassMid: 'Tiles/Grass/Grass_1_Middle.png',
  grassMid2: 'Tiles/Grass/Grass_2_Middle.png',
  path: 'Tiles/Grass/Path_Middle.png',
  water: 'Tiles/Water/Water_Tile_1.png', // 3 cols: grass/water autotile
  waterMid: 'Tiles/Water/Water_Middle.png',
  farm: 'Tiles/FarmLand/FarmLand_Tile.png', // 7 cols
  crops: 'Crops/Crops.png', // 7 cols
  decor: 'Outdoor decoration/Outdoor_Decor.png', // 9 cols
  pathDecor: 'Tiles/Grass/Path_Decoration.png',
};

export const IMAGES: Record<string, string> = {
  inn: 'Buildings/Buildings/Unique_Buildings/Inn/Inn_Red.png',
  smithy: 'Buildings/Buildings/Unique_Buildings/Blacksmith_House/Blacksmith_House_Red.png',
  bakery: 'Buildings/Buildings/Houses/Wood/House_4_Wood_Green_Blue.png',
  jackHouse: 'Buildings/Buildings/Houses/Wood/House_1_Wood_Base_Red.png',
  stoneHouse: 'Buildings/Buildings/Houses/Stone/House_3_Stone_Base_Blue.png',
  windmill: 'Buildings/Buildings/Unique_Buildings/Windmill/Windmill.png',
  silo: 'Buildings/Buildings/Unique_Buildings/Silo/Silo.png',
  cave: 'Tiles/Cliff/Cave_Entrance.png',
  well: 'Outdoor decoration/Well.png',
  bridge: 'Tiles/Bridge/Bridge_Wood_1.png',
  hay: 'Outdoor decoration/Hay_Bales.png',
};

/** Sheets cut into equal frames. */
export const SHEETS: Record<string, { path: string; w: number; h: number }> = {
  stalls: { path: 'Buildings/Buildings/Unique_Buildings/Stalls/Market_Stalls.png', w: 48, h: 48 },
  bigOak: { path: 'Trees/Big_Oak_Tree.png', w: 64, h: 80 },
  medOak: { path: 'Trees/Medium_Oak_Tree.png', w: 32, h: 48 },
  spruce: { path: 'Trees/Medium_Spruce_Tree.png', w: 32, h: 48 },
  birch: { path: 'Trees/Medium_Birch_Tree.png', w: 32, h: 48 },
  ores: { path: 'Outdoor decoration/Ores.png', w: 16, h: 16 },
  barrels: { path: 'Outdoor decoration/barrels.png', w: 16, h: 32 },
  carts: { path: 'Outdoor decoration/Minecrats.png', w: 32, h: 32 },
  campfire: { path: 'Outdoor decoration/Outdoor_Decor_Animations/Other_Animations/Campfire_Anim.png', w: 16, h: 32 },
  windmillSail: { path: 'Buildings/Buildings/Unique_Buildings/Windmill/Windmill_Sail_Anim.png', w: 64, h: 80 },
  smoke: { path: 'Buildings/House_Decor/Chimney_smoke_Anim.png', w: 32, h: 32 },
  rain: { path: 'Weather effects/Rain_Drop.png', w: 16, h: 16 },
};

/** Premade NPC sheets: 64x64 frames, 6 columns. Rows: idle down/side/up, walk down/side/up. */
export const NPC_SHEETS: Partial<Record<NpcId, string>> = {
  mike: 'NPCs (Premade)/Miner_Mike.png',
  jack: 'NPCs (Premade)/Lumberjack_Jack.png',
  buba: 'NPCs (Premade)/Farmer_Buba.png',
  chloe: 'NPCs (Premade)/Chef_Chloe.png',
  bruno: 'NPCs (Premade)/Bartender_Bruno.png',
};

/** Theo has no premade sheet: compose him from the modular player layers (9 columns). */
export const THEO_LAYERS = [
  'Player/Player_Base/Player_Base_animations.png',
  'Player/Feet/Shoes_1_Brown.png',
  'Player/Legs/OG_Pants/Pants_1_Brown.png',
  'Player/Chest/OG_Shirt/Shirt_1_Black.png',
  'Player/Hands/Hands_1_Bare.png',
  'Player/Head/Hair_1/Hair_1_Black.png',
];

/** 16px icons for the UI: [sheet path, columns, index]. */
export const ICONS: Record<ItemId | 'gold', [string, number, number]> = {
  ore: ['Icons/Outline/Resources_Icons_Outline.png', 6, 0],
  timber: ['Icons/Outline/Resources_Icons_Outline.png', 6, 24],
  wheat: ['Crops/Crops.png', 7, 13],
  bread: ['Icons/Outline/Food_Icons_Outline.png', 8, 3],
  tools: ['Icons/Outline/Tool_Icons_Outline.png', 10, 2],
  sword: ['Icons/Outline/Tool_Icons_Outline.png', 10, 4],
  gold: ['Icons/Outline/Resources_Icons_Outline.png', 6, 14],
};

export function icon(id: ItemId | 'gold', size = 18): string {
  return `<i class="ico" style="${iconStyleFixed(id, size)}"></i>`;
}

/** background-size must be in px of the whole sheet; compute from known sheet widths. */
const SHEET_W: Record<string, number> = {
  'Icons/Outline/Resources_Icons_Outline.png': 96,
  'Crops/Crops.png': 112,
  'Icons/Outline/Food_Icons_Outline.png': 128,
  'Icons/Outline/Tool_Icons_Outline.png': 160,
};

function iconStyleFixed(id: ItemId | 'gold', size: number): string {
  const [path, cols, idx] = ICONS[id];
  const k = size / 16;
  const x = (idx % cols) * 16 * k;
  const y = Math.floor(idx / cols) * 16 * k;
  return `display:inline-block;width:${size}px;height:${size}px;background-image:url('${cf(path)}');background-position:-${x}px -${y}px;background-size:${SHEET_W[path] * k}px auto;background-repeat:no-repeat;image-rendering:pixelated;vertical-align:-4px;`;
}
