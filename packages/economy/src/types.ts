import type { ItemId, NpcId, QuestId, GuildStrategy } from './defs.ts';
import type { NpcPlan } from './plan.ts';
import type { Deal } from './deals.ts';
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
  /** working capital lent by the market treasury, repaid from later profits */
  loan?: Gold;
  /** today's plan from the NPC brain (LLM), already checked by the plan guard */
  plan?: NpcPlan;
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
  /** soulbound badges (NEP-171 on chain when the server mirrors them) */
  badges?: { kind: string; title: string; season: number; day: number; tx?: string }[];
  /** Silas, the AI rival trader (rival.ts) */
  rival?: boolean;
  /** the free-play week goal (goal.ts); bots have none */
  goal?: import('./goal.ts').GoalState;
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
  /** exchange rate from a real market (NEAR Intents): world prices are multiplied by `factor` */
  fx?: WorldFx;
}

export interface WorldFx {
  /** multiplier on world prices in village gold, kept within 0.9-1.1 */
  factor: number;
  /** what the factor comes from, e.g. "XAUT 3872.42 USD" */
  quote: string;
  source: string;
  at: string;
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
  /** who decided: a model name, or "rules" (day plans) */
  by?: string;
}

export type FeedKind =
  | 'world' | 'shipping' | 'deal' | 'order' | 'trade' | 'import' | 'export'
  | 'invest' | 'guild' | 'stall' | 'blocked' | 'hunger' | 'season' | 'quest' | 'craft' | 'think';

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

/** A player's listing on the stall board: goods in escrow at a fixed price (whole listing per sale). */
export interface Listing {
  id: number;
  seller: string;
  item: ItemId;
  qty: number;
  /** per unit */
  price: Gold;
  status: 'open' | 'sold' | 'cancelled';
  buyer?: { kind: 'npc' | 'player'; id: string };
  day: number;
  tx?: string;
  saleTx?: string;
  /** listed by an NPC the seller hired to keep the stall (keeper job id) */
  keeper?: number;
}

export type KeeperStrategy = 'hold' | 'quick' | 'wait';

/** A player hired an NPC to sell goods for them on the stall board (commission on sales). */
export interface KeeperJob {
  id: number;
  player: string;
  npc: NpcId;
  item: ItemId;
  /** units not sold yet */
  left: number;
  strategy: KeeperStrategy;
  startDay: number;
  status: 'working' | 'done';
  sold: number;
  /** gold the player got, after commission */
  earned: Gold;
  commission: Gold;
  listingId?: number;
  /** today's sale and price reasoning, folded into the 20:00 report */
  saleNote?: string;
  todayWhy?: string;
  /** the keeper's end-of-day reports, newest last */
  reports: { day: number; text: string }[];
}

export interface VillageState {
  /** the stall board: players' listings (escrowed on chain by the stalls contract when enabled) */
  listings?: Listing[];
  /** haggles in progress today, "npc:player" -> round (haggle.ts) */
  haggles?: Record<string, { day: number; round: number }>;
  /** NPCs hired to keep a player's stall */
  keepers?: KeeperJob[];
  /** what each NPC remembers about each player (regard.ts) */
  regard?: Partial<Record<NpcId, Record<string, { trades: number; volume: Gold; delivered: number; lowballs: number; lastDay: number }>>>;
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
  /** today's (and recent) deals negotiated between NPC agents, newest last */
  deals?: Deal[];
  /** today's requests from NPCs to players ("bring 5 wheat before the storm") */
  requests?: NpcRequest[];
  lastSeasonResult?: { season: number; ranking: { guild: string; score: number; reward: Gold }[] };
}

/** An NPC asks players for goods it needs today; the first player to bring them is paid. */
export interface NpcRequest {
  id: number;
  npc: NpcId;
  item: ItemId;
  qty: number;
  /** what the NPC pays per unit, from its own gold */
  price: Gold;
  /** small reward from the quest faucet on top */
  bonus: Gold;
  day: number;
  text: string;
  /** player who delivered it */
  by?: string;
  tx?: string;
  /** a big order: open until the end of this day (inclusive); a player must accept it first */
  due?: number;
  /** the player who promised to deliver it (big orders) */
  takenBy?: string;
  /** promised and not delivered by the due day */
  missed?: boolean;
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
  | { type: 'list_item'; item: ItemId; qty: number; price: Gold }
  | { type: 'buy_listing'; id: number }
  | { type: 'cancel_listing'; id: number }
  | { type: 'start_goal' }
  | { type: 'accept_request'; requestId: number }
  | { type: 'hire_keeper'; npc: NpcId; item: ItemId; qty: number; strategy: KeeperStrategy }
  | { type: 'dismiss_keeper'; id: number }
  | { type: 'set_stall_prices'; slot: number; item: ItemId; buy: Gold; sell: Gold; fund?: Gold }
  | { type: 'propose_vote'; text: string; action: Action }
  | { type: 'cast_vote'; voteId: number; yes: boolean }
  | { type: 'deliver_request'; requestId: number }
  // NPC-only
  | { type: 'hire'; seller: NpcId; item: ItemId; qty: number; price: Gold; sweetener?: { item: ItemId; qty: number } }
  | { type: 'fill_order'; orderId: number; price: Gold }
  | { type: 'produce' }
  // never allowed for NPC keys; present so the guard can refuse it explicitly
  | { type: 'transfer'; to: string; amount: Gold }
  // any other raw contract call a model might invent (add_full_access_key, deploy, ...)
  | { type: 'call'; method: string; receiver?: string; args?: Record<string, unknown> };

export type ActionResult = { ok: true; tx?: string; info?: string } | { ok: false; reason: string };
