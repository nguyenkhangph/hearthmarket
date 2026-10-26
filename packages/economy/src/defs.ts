import { g, type Gold } from './money.ts';

export const ITEMS = ['ore', 'timber', 'wheat', 'bread', 'tools', 'sword'] as const;
export type ItemId = (typeof ITEMS)[number];

export interface ItemDef {
  id: ItemId;
  name: string;
  /** reference price, centigold */
  base: Gold;
  /** village market stock the price curve is centred on */
  target: number;
  /** traded on the world market through Bruno */
  world: boolean;
}

export const ITEM_DEFS: Record<ItemId, ItemDef> = {
  ore: { id: 'ore', name: 'Iron ore', base: g(6), target: 40, world: true },
  timber: { id: 'timber', name: 'Timber', base: g(2.7), target: 40, world: true },
  wheat: { id: 'wheat', name: 'Wheat', base: g(2), target: 60, world: true },
  bread: { id: 'bread', name: 'Bread', base: g(3.3), target: 24, world: false },
  tools: { id: 'tools', name: 'Tools', base: g(9.4), target: 10, world: true },
  sword: { id: 'sword', name: 'Sword', base: g(18), target: 8, world: false },
};

export const NPCS = ['mike', 'jack', 'buba', 'chloe', 'theo', 'bruno'] as const;
export type NpcId = (typeof NPCS)[number];

export type Role = 'miner' | 'lumberjack' | 'farmer' | 'baker' | 'smith' | 'merchant';

export interface NpcDef {
  id: NpcId;
  name: string;
  role: Role;
  title: string;
  account: string;
  produces: ItemId[];
  personality: string;
  /** daily spending limit enforced by policy + contract */
  dailyBudget: Gold;
}

export const NPC_DEFS: Record<NpcId, NpcDef> = {
  mike: {
    id: 'mike', name: 'Mike', role: 'miner', title: 'Miner', account: 'mike.hearth.testnet',
    produces: ['ore'], dailyBudget: g(60),
    personality: 'Gruff, honest, asks more when the mine runs low, has a weakness for fresh bread.',
  },
  jack: {
    id: 'jack', name: 'Jack', role: 'lumberjack', title: 'Lumberjack', account: 'jack.hearth.testnet',
    produces: ['timber'], dailyBudget: g(60),
    personality: 'Cheerful and talkative, sells fast, hates holding stock.',
  },
  buba: {
    id: 'buba', name: 'Buba', role: 'farmer', title: 'Farmer', account: 'buba.hearth.testnet',
    produces: ['wheat'], dailyBudget: g(60),
    personality: 'Patient, watches the weather, holds wheat when the world price is rising.',
  },
  chloe: {
    id: 'chloe', name: 'Chloe', role: 'baker', title: 'Baker', account: 'chloe.hearth.testnet',
    produces: ['bread'], dailyBudget: g(80),
    personality: 'Precise and thrifty, knows the whole village must eat.',
  },
  theo: {
    id: 'theo', name: 'Theo', role: 'smith', title: 'Smith', account: 'theo.hearth.testnet',
    produces: ['tools', 'sword'], dailyBudget: g(80),
    personality: 'Proud craftsman, prioritises guild orders, haggles hard on ore.',
  },
  bruno: {
    id: 'bruno', name: 'Bruno', role: 'merchant', title: 'Merchant', account: 'bruno.hearth.testnet',
    produces: [], dailyBudget: g(400),
    personality: 'Worldly trader, the village door to the world market, never takes a losing trade.',
  },
};

/**
 * The game contract account. NPC accounts are its sub-accounts (`theo.<contract>`).
 * Change it with `setContractAccount` (server: HEARTH_CONTRACT, client: VITE_HEARTH_CONTRACT).
 */
export const NEAR_CONFIG = { contract: 'hearth.testnet' };

export function setContractAccount(contract: string) {
  if (!/^[a-z0-9._-]{2,64}$/.test(contract)) throw new Error(`invalid NEAR account id: ${contract}`);
  NEAR_CONFIG.contract = contract;
  for (const id of NPCS) NPC_DEFS[id].account = `${id}.${contract}`;
}

/** Crafting recipes. Raw producers have no inputs. */
export const RECIPES: Partial<Record<ItemId, Partial<Record<ItemId, number>>>> = {
  bread: { wheat: 1 },
  tools: { ore: 1, timber: 1 },
  sword: { ore: 2, timber: 1 },
};

/** Units produced per craft. A smith hammers out a set of two tools from one ore and one timber. */
export const RECIPE_YIELD: Partial<Record<ItemId, number>> = { bread: 1, tools: 2, sword: 1 };

/** Tunable economy constants. Changing these is a design change: rerun `npm run sim`. */
export const RULES = {
  ticksPerDay: 24,
  seasonDays: 14,

  // market
  feeBps: 150, // 1.5% per trade
  feeToPoolBps: 5000, // half of the fee goes to the season pool, half is burned
  spreadBps: 200, // market maker spread around mid
  priceElasticity: 0.6,
  priceFloor: 0.4,
  priceCeil: 2.5,
  treasuryStart: g(2500),

  // npc
  npcStartGold: g(80),
  toolUses: 20,
  toolUsesPerDay: 4,
  hungerPenalty: 0.2,
  minProductivity: 0.4,

  // production per day at full productivity
  oreBase: 7,
  timberBase: 7,
  wheatBase: 10,
  bakeMax: 8,
  craftMax: 3,
  mineDepletionPerUnit: 0.012,
  mineRegenPerDay: 0.035,

  // Bruno
  brunoBandBps: 400, // trade only when the gap exceeds 4%
  brunoDailyCap: 18, // units per item per day
  shippingBps: 600, // base shipping cost, 6% of world price

  // world
  worldImpactCap: 0.08,
  worldImpactDecay: 0.7,

  // investing
  investShareBps: 2500, // NPC pays 25% of its daily profit to investors
  investDays: 7,

  // players
  playerStartGold: g(50),
  questReward: g(5),

  // stalls
  stallSlots: 4,
  stallRent: g(20),

  // adventurers buy swords from the world side (a faucet)
  adventurerDemand: [0, 2] as [number, number],
  adventurerMaxPrice: g(22),

  // upkeep: every NPC pays 1 gold a day plus 3% of its balance above 120 gold (burned)
  upkeepFlat: g(1),
  upkeepFreeBalance: g(120),
  upkeepBps: 300,

  // season pool split for top 10, basis points
  seasonSplitBps: [2500, 1800, 1300, 1000, 800, 700, 600, 500, 400, 400],
};

export const AI_GUILDS = [
  { id: 'black-cats', name: 'Black Cats', strategy: 'trader' },
  { id: 'night-smiths', name: 'Night Smiths', strategy: 'orderer' },
  { id: 'golden-wheat', name: 'Golden Wheat', strategy: 'investor' },
  { id: 'red-river', name: 'Red River', strategy: 'stallkeeper' },
] as const;

export type GuildStrategy = (typeof AI_GUILDS)[number]['strategy'];

export const QUESTS = [
  { id: 'buy-wheat', text: 'Buy 3 wheat' },
  { id: 'order-sword', text: 'Order a sword from Theo' },
  { id: 'invest-buba', text: 'Invest 10 gold in Buba' },
  { id: 'join-guild', text: 'Join a guild' },
] as const;
export type QuestId = (typeof QUESTS)[number]['id'];
