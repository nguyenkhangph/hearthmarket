import type { ItemId, NpcId, QuestId, GuildStrategy } from './defs.ts';
import type { Gold } from './money.ts';

export type Inventory = Record<ItemId, number>;

/** Who is acting. Mirrors NEAR accounts: players, guild funds, NPC sub-accounts. */
export type Actor =
  | { kind: 'player'; id: string }
  | { kind: 'guild'; id: string; by: string }
  | { kind: 'npc'; id: NpcId }
  | { kind: 'system' };

export interface NpcState {
  id: NpcId;
  gold: Gold;
  stock: Inventory;
  hunger: number; // 0 = fed
  toolUses: number;
  mineHealth: number; // only Mike
  spentToday: Gold;
  goldAtDayStart: Gold;
  lastProfit: Gold;
  inflowToday: Gold; // investment money received today, excluded from profit
  brokeDays: number;
  memory: string[]; // short facts the brain keeps
  x: number; // tile position for the client
  y: number;
}

export interface Investment {
  id: number;
  investor: { kind: 'player' | 'guild'; id: string };
  npc: NpcId;
  principal: Gold;
  paid: Gold;
  startDay: number;
  matureDay: number;
  settled: boolean;
}

export interface Order {
  id: number;
  by: { kind: 'player' | 'guild'; id: string };
  item: ItemId;
  qty: number;
  filled: number;
  maxPrice: Gold; // per unit
  escrow: Gold;
  deadlineDay: number;
  status: 'open' | 'filled' | 'expired' | 'cancelled';
  seller?: NpcId;
}

export interface Stall {
  slot: number;
  guild: string | null;
  gold: Gold;
  stock: Inventory;
  /** price the stall pays when NPCs sell to it */
  buy: Partial<Record<ItemId, Gold>>;
  /** price the stall asks when NPCs buy from it */
  sell: Partial<Record<ItemId, Gold>>;
  profit: Gold;
  funded: Gold;
}

export interface Guild {
  id: string;
  name: string;
  ai: boolean;
  strategy?: GuildStrategy;
  leader: string;
  members: string[];
  fund: Gold;
  contributed: Gold;
  contributions: Record<string, Gold>;
  warPoints: number;
  stock: Inventory;
  costBasis: Partial<Record<ItemId, Gold>>; // average cost per unit held
  stockSince: Partial<Record<ItemId, number>>; // day the position was opened
  vote?: { id: number; text: string; yes: string[]; no: string[]; action: unknown };
}

export interface Player {
  id: string;
  name: string;
  gold: Gold;
  stock: Inventory;
  guild: string | null;
  quests: Record<QuestId, boolean>;
  bot: boolean;
  daysActive: number;
  lastActiveDay: number;
}

export interface RegionState {
  id: string;
  name: string;
  item: ItemId | 'shipping';
  /** latest weather deviation score, 0 = normal, 1 = severe */
  severity: number;
  headline: string;
  /** current price impact on the world price, signed fraction (capped) */
  impact: number;
  forecast: string;
}

export interface WorldState {
  day: number;
  source: string;
  regions: RegionState[];
  /** world price per unit before shipping, centigold */
  price: Partial<Record<ItemId, Gold>>;
  shippingBps: number;
}

export interface MarketState {
  stock: Inventory;
  treasury: Gold;
  history: Record<ItemId, Gold[]>; // daily close mid price
}

export interface Ledger {
  // cumulative gold flows (faucets add to supply, sinks remove)
  faucets: { exports: Gold; adventurers: Gold; quests: Gold; signup: Gold };
  sinks: { feeBurn: Gold; imports: Gold; upkeep: Gold };
  feesToPool: Gold;
  volume: Gold;
  // goods sinks
  toolsWorn: number;
  breadEaten: number;
}

export interface DiaryEntry {
  t: number;
  npc: NpcId;
  goal: string;
  saw: string;
  think: string;
  act: string;
  tx?: string;
  guard: string;
}

export type FeedKind =
  | 'world' | 'shipping' | 'deal' | 'order' | 'trade' | 'import' | 'export'
  | 'invest' | 'guild' | 'stall' | 'blocked' | 'hunger' | 'season' | 'quest' | 'craft';

export interface FeedEvent {
  t: number;
  kind: FeedKind;
  text: string;
  npc?: NpcId;
  tx?: string;
}

export interface TxRecord {
  hash: string;
  t: number;
  signer: string;
  method: string;
  args: Record<string, unknown>;
  ok: boolean;
  reason?: string;
}

export interface VillageState {
  seed: number;
  rngState: number;
  tick: number;
  season: number;
  seasonPool: Gold;
  npcs: Record<NpcId, NpcState>;
  market: MarketState;
  world: WorldState;
  orders: Order[];
  investments: Investment[];
  stalls: Stall[];
  guilds: Record<string, Guild>;
  players: Record<string, Player>;
  ledger: Ledger;
  feed: FeedEvent[];
  diary: DiaryEntry[];
  txs: TxRecord[];
  nextId: number;
  dailyStats: DailyStats[];
  lastSeasonResult?: { season: number; ranking: { guild: string; score: number; reward: Gold }[] };
}

export interface DailyStats {
  day: number;
  goldSupply: Gold;
  priceIndex: number;
  prices: Record<ItemId, Gold>;
  world: Partial<Record<ItemId, Gold>>;
  faucets: Gold;
  sinks: Gold;
  npcGold: Record<NpcId, Gold>;
  broke: NpcId[];
  /** cumulative ledger at the end of the day; diff two days for daily flows */
  ledger: Ledger;
}

/** Every state change goes through an Action, checked by the policy (and on-chain by the contract). */
export type Action =
  | { type: 'market_buy'; item: ItemId; qty: number; maxPrice: Gold }
  | { type: 'market_sell'; item: ItemId; qty: number; minPrice: Gold }
  | { type: 'place_order'; item: ItemId; qty: number; maxPrice: Gold; deadlineDays: number; fromGuild?: boolean }
  | { type: 'cancel_order'; orderId: number }
  | { type: 'invest'; npc: NpcId; amount: Gold; fromGuild?: boolean }
  | { type: 'create_guild'; name: string }
  | { type: 'join_guild'; guild: string }
  | { type: 'deposit'; amount: Gold }
  | { type: 'rent_stall'; slot: number }
  | { type: 'set_stall_prices'; slot: number; item: ItemId; buy: Gold; sell: Gold; fund?: Gold }
  | { type: 'propose_vote'; text: string; action: Action }
  | { type: 'cast_vote'; voteId: number; yes: boolean }
  // NPC-only
  | { type: 'hire'; seller: NpcId; item: ItemId; qty: number; price: Gold; sweetener?: { item: ItemId; qty: number } }
  | { type: 'fill_order'; orderId: number; price: Gold }
  | { type: 'produce' }
  // never allowed for NPC keys; present so the guard can refuse it explicitly
  | { type: 'transfer'; to: string; amount: Gold }
  // any other raw contract call a model might invent (add_full_access_key, deploy, ...)
  | { type: 'call'; method: string; receiver?: string; args?: Record<string, unknown> };

export type ActionResult = { ok: true; tx?: string; info?: string } | { ok: false; reason: string };
