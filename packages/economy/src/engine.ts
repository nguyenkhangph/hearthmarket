import {
  ITEM_DEFS, ITEMS, NPC_DEFS, NPCS, NEAR_CONFIG, RECIPES, RECIPE_YIELD, RULES, AI_GUILDS, QUESTS,
  type ItemId, type NpcId, type QuestId,
} from './defs.ts';
import { bps, clamp, fmt, g, type Gold } from './money.ts';
import { Rng } from './rng.ts';
import {
  askPrice, bidPrice, emptyInventory, fee, initialMarketStock, midPrice, priceIndex, quoteBuy, quoteSell,
} from './market.ts';
import { checkNpcAction } from './policy.ts';
import { checkPlan, describePlan, type NpcPlan } from './plan.ts';
import { applyWorldDay, initialWorld, SyntheticWorld, type WorldDay } from './world.ts';
import type {
  Action, ActionResult, Actor, DailyStats, DiaryEntry, FeedEvent, FeedKind, Guild, Inventory, NpcState,
  Order, Player, Stall, VillageState,
} from './types.ts';

/** Current game contract (see setContractAccount in defs.ts). */
const contract = () => NEAR_CONFIG.contract;

export interface WorldSource {
  next(): WorldDay;
}

export interface VillageOptions {
  seed?: number;
  world?: WorldSource;
  /** run the 4 AI guilds and their bot members */
  aiGuilds?: boolean;
  /** extra bot players (simulation report uses 50) */
  botPlayers?: number;
}

/**
 * Hook so the server can mirror accepted actions on chain. Returns a placeholder hash that
 * the server patches with the real one, or null when the action stays off chain (shown as
 * "off-chain" in the feed).
 */
export type ChainHook = (signer: string, method: string, args: Record<string, unknown>) => string | null;

/** A badge the village awards to a human player (minted on chain as a soulbound NEP-171 token when online). */
export type BadgeHook = (playerId: string, badge: { kind: string; title: string; description: string; season: number }) => string | null;

const FEED_CAP = 250;
const DIARY_CAP = 200;
const TX_CAP = 400;

/** Tile positions on the village map (apps/client/src/map.ts). */
export const HOME: Record<NpcId, [number, number]> = {
  mike: [44, 13], jack: [17, 21], buba: [10, 22], chloe: [18, 12], theo: [30, 12], bruno: [12, 13],
};
export const MARKET_SPOT: Record<NpcId, [number, number]> = {
  mike: [27, 19], jack: [19, 19], buba: [21, 15], chloe: [17, 15], theo: [29, 15], bruno: [25, 15],
};

export class Village {
  s: VillageState;
  private rng: Rng;
  private world: WorldSource;
  chainHook?: ChainHook;
  badgeHook?: BadgeHook;
  private listeners: ((e: FeedEvent) => void)[] = [];
  private aiTick?: (v: Village) => void;

  constructor(opts: VillageOptions = {}, state?: VillageState) {
    const seed = opts.seed ?? 42;
    this.rng = new Rng(seed);
    this.world = opts.world ?? new SyntheticWorld(seed);
    this.s = state ?? this.freshState(seed);
    if (state) this.rng.state = state.rngState;
    if (!state) {
      this.startDay(); // day 1 world
      if (opts.aiGuilds !== false) this.seedAiGuilds();
      for (let i = 0; i < (opts.botPlayers ?? 0); i++) this.addBotPlayer(i);
    }
  }

  /** AI guild/bot behaviour lives in ai.ts to keep the engine rule-only. */
  setAiDriver(fn: (v: Village) => void) {
    this.aiTick = fn;
  }

  onFeed(fn: (e: FeedEvent) => void) {
    this.listeners.push(fn);
  }

  setWorldSource(w: WorldSource) {
    this.world = w;
  }

  get day() {
    return Math.floor(this.s.tick / RULES.ticksPerDay) + 1;
  }
  get hour() {
    return this.s.tick % RULES.ticksPerDay;
  }
  get seasonDay() {
    return ((this.day - 1) % RULES.seasonDays) + 1;
  }

  // ---------------------------------------------------------------- state
  private freshState(seed: number): VillageState {
    const npcs = {} as Record<NpcId, NpcState>;
    for (const id of NPCS) {
      const stock = emptyInventory();
      stock.bread = 2;
      if (id === 'theo') { stock.ore = 4; stock.timber = 3; }
      if (id === 'chloe') stock.wheat = 6;
      npcs[id] = {
        id, gold: id === 'bruno' ? g(400) : RULES.npcStartGold, stock, hunger: 0, toolUses: RULES.toolUses,
        mineHealth: 1, spentToday: 0, goldAtDayStart: 0, lastProfit: 0, inflowToday: 0, brokeDays: 0, memory: [],
        x: HOME[id][0], y: HOME[id][1],
      };
    }
    const stalls: Stall[] = Array.from({ length: RULES.stallSlots }, (_, slot) => ({
      slot, guild: null, gold: 0, stock: emptyInventory(), buy: {}, sell: {}, profit: 0, funded: 0,
    }));
    const history = Object.fromEntries(ITEMS.map((i) => [i, [] as Gold[]])) as Record<ItemId, Gold[]>;
    return {
      seed, rngState: seed, tick: 0, season: 1, seasonPool: 0,
      npcs,
      market: { stock: initialMarketStock(), treasury: RULES.treasuryStart, history },
      world: initialWorld(),
      orders: [], investments: [], stalls, guilds: {}, players: {},
      ledger: {
        faucets: { exports: 0, adventurers: 0, quests: 0, signup: 0 }, sinks: { feeBurn: 0, imports: 0, upkeep: 0 },
        feesToPool: 0, volume: 0, toolsWorn: 0, breadEaten: 0,
      },
      feed: [], diary: [], txs: [], nextId: 1, dailyStats: [],
    };
  }

  snapshot(): VillageState {
    this.s.rngState = this.rng.state;
    return structuredClone(this.s);
  }

  static restore(state: VillageState, opts: VillageOptions = {}): Village {
    return new Village(opts, structuredClone(state));
  }

  // ---------------------------------------------------------------- feed / tx
  feed(kind: FeedKind, text: string, npc?: NpcId, tx?: string) {
    const e: FeedEvent = { t: this.s.tick, kind, text, npc, tx };
    this.s.feed.push(e);
    if (this.s.feed.length > FEED_CAP) this.s.feed.splice(0, this.s.feed.length - FEED_CAP);
    for (const l of this.listeners) l(e);
  }

  diary(e: Omit<DiaryEntry, 't'>) {
    this.s.diary.push({ t: this.s.tick, ...e });
    if (this.s.diary.length > DIARY_CAP) this.s.diary.splice(0, this.s.diary.length - DIARY_CAP);
  }

  /**
   * Record a transaction. Without a chain hook (guest mode, tests, simulation) the hash is a
   * simulated one marked `sim…`; with a hook, actions the server keeps off chain are marked `local…`.
   */
  private tx(signer: string, method: string, args: Record<string, unknown>, ok = true, reason?: string): string {
    let hash: string | null | undefined = ok ? this.chainHook?.(signer, method, args) : undefined;
    if (!hash) {
      const fake = this.fakeHash();
      hash = (this.chainHook && ok ? 'local' : 'sim') + fake.slice(this.chainHook && ok ? 5 : 3);
    }
    this.s.txs.push({ hash, t: this.s.tick, signer, method, args, ok, reason });
    if (this.s.txs.length > TX_CAP) this.s.txs.splice(0, this.s.txs.length - TX_CAP);
    return hash;
  }

  private fakeHash(): string {
    const a = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let h = '';
    for (let i = 0; i < 44; i++) h += a[Math.floor(this.rng.next() * a.length)];
    return h;
  }

  private takeFee(amount: Gold) {
    const pool = bps(amount, RULES.feeToPoolBps);
    this.s.seasonPool += pool;
    this.s.ledger.feesToPool += pool;
    this.s.ledger.sinks.feeBurn += amount - pool;
  }

  // ---------------------------------------------------------------- main loop
  step() {
    this.s.tick++;
    const h = this.hour;
    if (h === 0) this.startDay();
    switch (h) {
      case 6: this.allNpcs((n) => this.eat(n)); break;
      case 8: this.buyInputs(); break;
      case 10: this.fillOrders(); break;
      case 12: this.produceAll(); break;
      case 13: this.fillOrders(); break;
      case 15: this.sellSurplus(); break;
      case 17: this.brunoTrade(); break;
      case 19: this.adventurers(); break;
      case 20: this.aiTick?.(this); this.tallyVotes(); break;
      case 23: this.closeDay(); break;
    }
    this.wander();
  }

  /** Advance whole days (used by tests and the simulation report). */
  runDays(n: number) {
    for (let i = 0; i < n * RULES.ticksPerDay; i++) this.step();
  }

  private allNpcs(fn: (n: NpcState) => void) {
    for (const id of NPCS) fn(this.s.npcs[id]);
  }

  private startDay() {
    const day = this.day;
    const prevImpact = Object.fromEntries(this.s.world.regions.map((r) => [r.id, r.impact]));
    this.s.world = applyWorldDay(this.s.world, this.world.next(), day);
    for (const n of Object.values(this.s.npcs)) {
      n.spentToday = 0;
      n.inflowToday = 0;
      n.goldAtDayStart = n.gold;
      // a plan lasts the day it was made for and the next one (the brain is rate-limited)
      if (n.plan && day - n.plan.day > 1) n.plan = undefined;
    }
    // World bulletin: the most unusual region of the day
    const top = [...this.s.world.regions].sort((a, b) => b.severity - a.severity)[0];
    if (top && top.severity > 0.25) {
      const delta = Math.round(top.impact * 100);
      if (top.item === 'shipping') {
        const pct = Math.round((this.s.world.shippingBps / RULES.shippingBps - 1) * 100);
        this.feed('shipping', `Sea lane: ${top.headline} · shipping ${pct >= 0 ? '+' : ''}${pct}%`);
      } else {
        this.feed('world', `World: ${top.headline} in ${top.name} · ${top.item} ${delta >= 0 ? '+' : ''}${delta}%`);
      }
    } else if (day > 1 && Object.values(prevImpact).some((v) => Math.abs(v) > 0.02)) {
      this.feed('world', 'World: calm weather in all five regions · prices drifting back');
    }
    const fc = this.s.world.regions.find((r) => r.forecast && r.severity < 0.25);
    if (fc) this.feed('world', `Forecast: ${fc.forecast} (${fc.name})`);

    // expire orders
    for (const o of this.s.orders) {
      if (o.status === 'open' && day > o.deadlineDay) {
        o.status = 'expired';
        this.refundEscrow(o);
        this.feed('order', `Order #${o.id} for ${o.qty - o.filled} ${o.item} expired · gold refunded`);
      }
    }
    this.s.orders = this.s.orders.filter((o) => o.status === 'open' || day - o.deadlineDay < 3);
    this.settleInvestments();
    if (day > 1 && (day - 1) % RULES.seasonDays === 0) this.closeSeason();
  }

  // ---------------------------------------------------------------- npc spending (guarded)
  /** Every NPC money movement goes through the same guard the signer and contract use. */
  private guarded(n: NpcState, action: Action): boolean {
    const v = checkNpcAction({
      contract: contract(), receiver: contract(), action, spentToday: n.spentToday, dailyBudget: NPC_DEFS[n.id].dailyBudget,
    });
    if (!v.ok) {
      this.tx(NPC_DEFS[n.id].account, v.method, action as unknown as Record<string, unknown>, false, v.reason);
      return false;
    }
    return true;
  }

  private npcBuy(n: NpcState, item: ItemId, qty: number, maxUnit: Gold = Infinity): number {
    if (qty <= 0) return 0;
    // stalls first when cheaper
    let bought = 0;
    for (const st of this.s.stalls) {
      const p = st.sell[item];
      if (!st.guild || p === undefined || st.stock[item] <= 0) continue;
      if (p >= askPrice(item, this.s.market.stock[item]) || p > maxUnit) continue;
      const k = Math.min(qty - bought, st.stock[item], Math.floor(n.gold / Math.ceil(p * 1.02)));
      if (k <= 0) continue;
      const cost = p * k;
      const f = fee(cost);
      const action: Action = { type: 'market_buy', item, qty: k, maxPrice: p };
      if (!this.guarded(n, action)) break;
      n.gold -= cost + f;
      n.spentToday += cost + f;
      st.gold += cost;
      st.stock[item] -= k;
      n.stock[item] += k;
      this.takeFee(f);
      this.s.ledger.volume += cost;
      this.tx(NPC_DEFS[n.id].account, 'stall_buy', { slot: st.slot, item, qty: k, price: p });
      bought += k;
    }
    let k = Math.min(qty - bought, this.s.market.stock[item]);
    while (k > 0) {
      const q = quoteBuy(item, this.s.market.stock[item], k);
      const f = fee(q.total);
      if (q.last <= maxUnit && q.total + f <= n.gold) {
        const action: Action = { type: 'market_buy', item, qty: k, maxPrice: q.last };
        if (!this.guarded(n, action)) return bought;
        n.gold -= q.total + f;
        n.spentToday += q.total + f;
        this.s.market.treasury += q.total;
        this.s.market.stock[item] -= k;
        n.stock[item] += k;
        this.takeFee(f);
        this.s.ledger.volume += q.total;
        this.tx(NPC_DEFS[n.id].account, 'market_buy', { item, qty: k, max_price: q.last });
        return bought + k;
      }
      k--;
    }
    return bought;
  }

  private npcSell(n: NpcState, item: ItemId, qty: number, minUnit: Gold = 0): number {
    qty = Math.min(qty, n.stock[item]);
    if (qty <= 0) return 0;
    let sold = 0;
    for (const st of this.s.stalls) {
      const p = st.buy[item];
      if (!st.guild || p === undefined || p <= bidPrice(item, this.s.market.stock[item]) || p < minUnit) continue;
      const k = Math.min(qty - sold, Math.floor(st.gold / p));
      if (k <= 0) continue;
      const proceeds = p * k;
      const f = fee(proceeds);
      st.gold -= proceeds;
      st.stock[item] += k;
      n.stock[item] -= k;
      n.gold += proceeds - f;
      this.takeFee(f);
      this.s.ledger.volume += proceeds;
      this.tx(NPC_DEFS[n.id].account, 'stall_sell', { slot: st.slot, item, qty: k, price: p });
      sold += k;
    }
    let k = qty - sold;
    while (k > 0) {
      const q = quoteSell(item, this.s.market.stock[item], k);
      if (q.last >= minUnit && q.total <= this.s.market.treasury) {
        const f = fee(q.total);
        this.s.market.treasury -= q.total;
        this.s.market.stock[item] += k;
        n.stock[item] -= k;
        n.gold += q.total - f;
        this.takeFee(f);
        this.s.ledger.volume += q.total;
        this.tx(NPC_DEFS[n.id].account, 'market_sell', { item, qty: k, min_price: q.last });
        return sold + k;
      }
      k--;
    }
    return sold;
  }

  // ---------------------------------------------------------------- daily routine
  private eat(n: NpcState) {
    if (n.stock.bread <= 0) this.npcBuy(n, 'bread', 1);
    if (n.stock.bread > 0) {
      n.stock.bread--;
      this.s.ledger.breadEaten++;
      n.hunger = Math.max(0, n.hunger - 1);
    } else {
      n.hunger++;
      if (n.hunger >= 2) this.feed('hunger', `${NPC_DEFS[n.id].name} is hungry (${n.hunger} days) and works slower`, n.id);
    }
  }

  private productivity(n: NpcState) {
    const hunger = Math.max(RULES.minProductivity, 1 - RULES.hungerPenalty * n.hunger);
    const tool = n.toolUses > 0 ? 1 : 0.5;
    return hunger * tool;
  }

  private reservedFor(npc: NpcId, item: ItemId): number {
    return this.s.orders
      .filter((o) => o.status === 'open' && o.item === item && this.producerOf(item) === npc && o.maxPrice >= this.unitInputCost(item) * 1.08)
      .reduce((s, o) => s + (o.qty - o.filled), 0);
  }

  producerOf(item: ItemId): NpcId | undefined {
    return NPCS.find((id) => NPC_DEFS[id].produces.includes(item));
  }

  /** Market cost of the inputs for one unit of a crafted item. */
  unitInputCost(item: ItemId): Gold {
    const r = RECIPES[item];
    if (!r) return 0;
    const cost = Object.entries(r).reduce((s, [i, q]) => s + midPrice(i as ItemId, this.s.market.stock[i as ItemId]) * q!, 0);
    return Math.round(cost / (RECIPE_YIELD[item] ?? 1));
  }

  /** Plan Theo's and Chloe's crafting for today (number of crafts, not units). */
  private craftPlan(n: NpcState): Partial<Record<ItemId, number>> {
    const plan: Partial<Record<ItemId, number>> = {};
    if (n.id === 'chloe') {
      const want = n.plan?.bake ?? (this.s.market.stock.bread < ITEM_DEFS.bread.target * 1.4 ? RULES.bakeMax : 3);
      plan.bread = want + Math.max(0, this.reservedFor('chloe', 'bread') - n.stock.bread);
    }
    if (n.id === 'theo') {
      let slots = RULES.craftMax;
      for (const item of ['sword', 'tools'] as ItemId[]) {
        const need = Math.max(0, this.reservedFor('theo', item) - n.stock[item]);
        const k = Math.min(slots, Math.ceil(need / (RECIPE_YIELD[item] ?? 1)));
        if (k > 0) { plan[item] = k; slots -= k; }
      }
      const order: ItemId[] = n.plan?.focus === 'sword' ? ['sword', 'tools'] : ['tools', 'sword'];
      for (const item of order) {
        if (slots <= 0) break;
        const st = this.s.market.stock[item];
        const inputCost = this.unitInputCost(item);
        if (st < ITEM_DEFS[item].target && bidPrice(item, st) > inputCost * 1.1) {
          const k = Math.min(slots, 1);
          plan[item] = (plan[item] ?? 0) + k;
          slots -= k;
        }
      }
    }
    return plan;
  }

  private buyInputs() {
    for (const id of NPCS) {
      const n = this.s.npcs[id];
      // worn tools
      if (['mike', 'jack', 'buba'].includes(id) && n.toolUses <= 0) {
        const got = n.stock.tools > 0 ? 1 : this.npcBuy(n, 'tools', 1);
        if (got > 0 || n.stock.tools > 0) {
          n.stock.tools--;
          n.toolUses = RULES.toolUses;
          this.s.ledger.toolsWorn++;
        }
      }
      const plan = this.craftPlan(n);
      const need: Partial<Record<ItemId, number>> = {};
      for (const [item, q] of Object.entries(plan) as [ItemId, number][]) {
        for (const [inp, per] of Object.entries(RECIPES[item] ?? {}) as [ItemId, number][]) {
          need[inp] = (need[inp] ?? 0) + per * q;
        }
      }
      for (const [inp, q] of Object.entries(need) as [ItemId, number][]) {
        const missing = q - n.stock[inp];
        if (missing <= 0) continue;
        const got = this.haggle(n, inp, missing);
        if (missing - got > 0) this.npcBuy(n, inp, missing - got, Math.round(midPrice(inp, this.s.market.stock[inp]) * 1.6));
      }
    }
  }

  /**
   * Rule-based haggling between two NPCs (up to 3 rounds). The server's LLM brain
   * may replace the price logic; the money movement still goes through the guard.
   */
  private haggle(buyer: NpcState, item: ItemId, qty: number): number {
    const sellerId = this.producerOf(item);
    if (!sellerId || sellerId === buyer.id) return 0;
    const seller = this.s.npcs[sellerId];
    const avail = Math.min(qty, seller.stock[item] - this.reservedFor(sellerId, item));
    if (avail <= 0) return 0;
    const mid = midPrice(item, this.s.market.stock[item]);
    const scarcity = item === 'ore' ? (1 - seller.mineHealth) * 0.3 : 0;
    let offer = Math.round(mid * 0.92);
    let ask = Math.round(mid * (1.08 + scarcity));
    const ceiling = Math.round(mid * 1.1);
    this.feed('deal', `${NPC_DEFS[buyer.id].name} needs ${avail} ${item}, pays up to ${fmt(ceiling)} gold`, buyer.id);
    let rounds = 0;
    let sweetener: { item: ItemId; qty: number } | undefined;
    while (ask - offer > mid * 0.03 && rounds < 3) {
      offer = Math.min(ceiling, Math.round(offer + (ask - offer) * 0.35));
      ask = Math.round(ask - (ask - offer) * 0.35);
      rounds++;
    }
    if (ask - offer > mid * 0.03 && seller.hunger > 0 && buyer.stock.bread >= 2) {
      sweetener = { item: 'bread', qty: 1 };
      ask = offer;
    }
    if (ask - offer > mid * 0.03) {
      this.feed('deal', `${NPC_DEFS[seller.id].name} refuses ${fmt(offer)} for ${item}; ${NPC_DEFS[buyer.id].name} goes to the market`, buyer.id);
      return 0;
    }
    const price = Math.round((offer + ask) / 2);
    const total = price * avail;
    const f = fee(total);
    if (total + f > buyer.gold) return 0;
    const action: Action = { type: 'hire', seller: seller.id, item, qty: avail, price, sweetener };
    const spentBefore = buyer.spentToday;
    if (!this.guarded(buyer, action)) {
      this.feed('blocked', `${NPC_DEFS[buyer.id].name}'s deal blocked: over daily budget`, buyer.id);
      return 0;
    }
    buyer.gold -= total + f;
    buyer.spentToday += total + f;
    seller.gold += total;
    seller.stock[item] -= avail;
    buyer.stock[item] += avail;
    if (sweetener) {
      buyer.stock.bread -= 1;
      seller.stock.bread += 1;
    }
    this.takeFee(f);
    this.s.ledger.volume += total;
    const tx = this.tx(NPC_DEFS[buyer.id].account, 'hire', { seller: NPC_DEFS[seller.id].account, item, qty: avail, price });
    const sw = sweetener ? ' + 1 bread' : '';
    this.feed('deal', `${NPC_DEFS[seller.id].name} settles at ${fmt(price)}${sw} · tx ${short(tx)}`, seller.id, tx);
    const pct = Math.round((this.s.market.stock[item] / ITEM_DEFS[item].target) * 100);
    const worldDelta = this.s.world.regions.find((r) => r.item === item)?.impact ?? 0;
    const openOrder = this.s.orders.find((o) => o.status === 'open' && this.producerOf(o.item) === buyer.id);
    this.diary({
      npc: buyer.id,
      goal: openOrder ? `deliver ${openOrder.qty - openOrder.filled} ${openOrder.item} for order #${openOrder.id} by day ${openOrder.deadlineDay}` : `keep the ${NPC_DEFS[buyer.id].produces.join('/')} line running`,
      saw: `${item} stock ${pct}% of target, world ${item} ${worldDelta >= 0 ? '+' : ''}${Math.round(worldDelta * 100)}%, ${NPC_DEFS[seller.id].name} asks ${fmt(Math.round(mid * (1.08 + scarcity)))}`,
      think: sweetener ? `${NPC_DEFS[seller.id].name} is short on bread; offer ${fmt(price)} + 1 bread` : `meet in the middle after ${rounds} rounds`,
      act: `hire(${seller.id}, ${avail} ${item}, ${fmt(total)} gold)`,
      tx,
      guard: `spent ${fmt(spentBefore + total + f, 0)}/${fmt(NPC_DEFS[buyer.id].dailyBudget, 0)} today · method allowed`,
    });
    seller.memory = [`${NPC_DEFS[buyer.id].name} paid ${fmt(price)} per ${item} on day ${this.day}`, ...seller.memory].slice(0, 5);
    return avail;
  }

  private produceAll() {
    for (const id of NPCS) {
      const n = this.s.npcs[id];
      const p = this.productivity(n);
      const def = NPC_DEFS[id];
      if (def.role === 'miner' || def.role === 'lumberjack' || def.role === 'farmer') {
        const item = def.produces[0];
        let base = item === 'ore' ? RULES.oreBase : item === 'timber' ? RULES.timberBase : RULES.wheatBase;
        if (item === 'ore') base *= 0.4 + 0.6 * n.mineHealth;
        const q = Math.max(0, Math.round(base * p));
        n.stock[item] += q;
        if (item === 'ore') n.mineHealth = clamp(n.mineHealth - q * RULES.mineDepletionPerUnit + RULES.mineRegenPerDay, 0.2, 1);
        if (n.toolUses > 0) n.toolUses = Math.max(0, n.toolUses - RULES.toolUsesPerDay);
        this.tx(def.account, 'produce', { item, qty: q });
      } else if (def.role === 'baker' || def.role === 'smith') {
        const plan = this.craftPlan(n);
        for (const [item, want] of Object.entries(plan) as [ItemId, number][]) {
          let made = 0;
          const recipe = RECIPES[item]!;
          const cap = Math.floor(want * (def.role === 'baker' ? p : 1));
          while (made < cap && Object.entries(recipe).every(([i, q]) => n.stock[i as ItemId] >= q!)) {
            for (const [i, q] of Object.entries(recipe)) n.stock[i as ItemId] -= q!;
            n.stock[item] += RECIPE_YIELD[item] ?? 1;
            made += 1;
          }
          if (made > 0) {
            const units = made * (RECIPE_YIELD[item] ?? 1);
            this.tx(def.account, 'craft', { item, crafts: made });
            if (item !== 'bread') this.feed('craft', `${def.name} forged ${units} ${item}`, id);
          }
        }
      }
    }
  }

  private fillOrders() {
    const open = this.s.orders.filter((o) => o.status === 'open').sort((a, b) => b.maxPrice - a.maxPrice);
    for (const o of open) {
      const sellerId = this.producerOf(o.item);
      if (!sellerId) continue;
      const n = this.s.npcs[sellerId];
      const k = Math.min(o.qty - o.filled, n.stock[o.item]);
      if (k <= 0) continue;
      const bid = bidPrice(o.item, this.s.market.stock[o.item]);
      const want = Math.max(Math.round(bid * 1.02), midPrice(o.item, this.s.market.stock[o.item]), Math.round(this.unitInputCost(o.item) * 1.08));
      if (want > o.maxPrice) continue;
      const price = want;
      const pay = price * k;
      const f = fee(pay);
      if (pay + f > o.escrow) continue;
      o.escrow -= pay + f;
      n.gold += pay;
      n.stock[o.item] -= k;
      o.filled += k;
      o.seller = sellerId;
      this.takeFee(f);
      this.s.ledger.volume += pay;
      this.deliver(o.by, o.item, k, price);
      const tx = this.tx(NPC_DEFS[sellerId].account, 'fill_order', { order_id: o.id, qty: k, price });
      const who = this.ownerName(o.by);
      this.feed('order', `${NPC_DEFS[sellerId].name} delivered ${k} ${o.item} to ${who} at ${fmt(price)} · tx ${short(tx)}`, sellerId, tx);
      if (o.filled >= o.qty) {
        o.status = 'filled';
        this.refundEscrow(o);
      }
    }
  }

  private sellSurplus() {
    for (const id of NPCS) {
      if (id === 'bruno') continue;
      const n = this.s.npcs[id];
      for (const item of NPC_DEFS[id].produces) {
        let keep = this.reservedFor(id, item);
        if (item === 'ore') keep += 3;
        if (item === 'wheat') {
          const kansas = this.s.world.regions.find((r) => r.id === 'kansas')!;
          // Buba holds wheat when the world price is rising
          keep += kansas.impact > 0.03 || kansas.forecast ? Math.floor(n.stock.wheat / 2) : 4;
        }
        if (item === 'bread') keep += 3;
        if (item === 'tools' || item === 'sword') keep += 0;
        const surplus = n.stock[item] - keep;
        const qty = n.plan?.sellShare !== undefined ? Math.floor(surplus * n.plan.sellShare) : surplus;
        if (qty > 0) {
          const floor = Math.round(midPrice(item, this.s.market.stock[item] + qty) * ((n.plan?.floorPct ?? 60) / 100));
          this.npcSell(n, item, qty, floor);
        }
      }
      // never hoard more than 4 bread
      if (id !== 'chloe' && n.stock.bread > 4) this.npcSell(n, 'bread', n.stock.bread - 4);
    }
  }

  /** Bruno: the village door to the world market. */
  private brunoTrade() {
    const b = this.s.npcs.bruno;
    const ship = this.s.world.shippingBps;
    for (const item of ITEMS) {
      if (!ITEM_DEFS[item].world) continue;
      const world = this.s.world.price[item]!;
      const landed = Math.round(world * (1 + ship / 10_000));
      const exportRev = Math.round(world * (1 - ship / 10_000));
      const band = 1 + (b.plan?.bandBps ?? RULES.brunoBandBps) / 10_000;
      // import
      let imported = 0;
      while (imported < RULES.brunoDailyCap) {
        const bid = bidPrice(item, this.s.market.stock[item]);
        if (bid < landed * band) break;
        if (b.gold < landed || this.s.market.treasury < bid) break;
        const action: Action = { type: 'market_sell', item, qty: 1, minPrice: bid };
        if (!this.guarded(b, action)) break;
        b.gold -= landed;
        b.spentToday += landed;
        this.s.ledger.sinks.imports += landed;
        const f = fee(bid);
        this.s.market.treasury -= bid;
        this.s.market.stock[item]++;
        b.gold += bid - f;
        this.takeFee(f);
        this.s.ledger.volume += bid;
        imported++;
      }
      if (imported > 0) {
        const tx = this.tx(NPC_DEFS.bruno.account, 'world_trade', { item, qty: imported, side: 'import', market_price: bidPrice(item, this.s.market.stock[item]) });
        this.feed('import', `Bruno imports ${imported} ${item} from the world market · tx ${short(tx)}`, 'bruno', tx);
      }
      // export
      let exported = 0;
      while (exported < RULES.brunoDailyCap && this.s.market.stock[item] > 1) {
        const ask = askPrice(item, this.s.market.stock[item]);
        if (exportRev < ask * band) break;
        const f = fee(ask);
        if (b.gold < ask + f) break;
        const action: Action = { type: 'market_buy', item, qty: 1, maxPrice: ask };
        if (!this.guarded(b, action)) break;
        b.gold -= ask + f;
        b.spentToday += ask + f;
        this.s.market.treasury += ask;
        this.s.market.stock[item]--;
        this.takeFee(f);
        this.s.ledger.volume += ask;
        b.gold += exportRev;
        this.s.ledger.faucets.exports += exportRev;
        exported++;
      }
      if (exported > 0) {
        const tx = this.tx(NPC_DEFS.bruno.account, 'world_trade', { item, qty: exported, side: 'export', market_price: askPrice(item, this.s.market.stock[item] + exported) });
        this.feed('export', `Bruno exports ${exported} ${item} to the world market · tx ${short(tx)}`, 'bruno', tx);
      }
    }
  }

  /** Travelling adventurers buy swords: outside gold entering the village. */
  private adventurers() {
    const n = this.rng.int(...RULES.adventurerDemand);
    let bought = 0;
    for (let i = 0; i < n; i++) {
      const st = this.s.market.stock.sword;
      if (st <= 0) break;
      const ask = askPrice('sword', st);
      if (ask > RULES.adventurerMaxPrice) break;
      this.s.market.stock.sword--;
      this.s.market.treasury += ask;
      this.s.ledger.faucets.adventurers += ask;
      this.s.ledger.volume += ask;
      bought++;
    }
    if (bought > 0) this.feed('trade', `Travelling adventurers bought ${bought} sword${bought > 1 ? 's' : ''}`);
  }

  private closeDay() {
    for (const id of NPCS) {
      const n = this.s.npcs[id];
      const upkeep = Math.min(n.gold, RULES.upkeepFlat + bps(Math.max(0, n.gold - RULES.upkeepFreeBalance), RULES.upkeepBps));
      n.gold -= upkeep;
      this.s.ledger.sinks.upkeep += upkeep;
      n.lastProfit = n.gold - n.goldAtDayStart - n.inflowToday;
      const active = this.s.investments.filter((i) => !i.settled && i.npc === id);
      if (n.lastProfit > 0 && active.length) {
        const share = bps(n.lastProfit, RULES.investShareBps);
        const total = active.reduce((s, i) => s + i.principal, 0);
        for (const inv of active) {
          const part = Math.floor((share * inv.principal) / total);
          if (part <= 0) continue;
          n.gold -= part;
          inv.paid += part;
          this.credit(inv.investor, part);
        }
      }
      const broke = n.gold < g(1) && NPC_DEFS[id].produces.every((i) => n.stock[i] === 0);
      n.brokeDays = broke ? n.brokeDays + 1 : 0;
    }
    for (const st of this.s.stalls) {
      if (!st.guild) continue;
      st.profit = st.gold + ITEMS.reduce((s, i) => s + st.stock[i] * bidPrice(i, this.s.market.stock[i]), 0) - st.funded;
    }
    const prices = Object.fromEntries(ITEMS.map((i) => [i, midPrice(i, this.s.market.stock[i])])) as Record<ItemId, Gold>;
    for (const i of ITEMS) this.s.market.history[i].push(prices[i]);
    for (const p of Object.values(this.s.players)) if (p.lastActiveDay === this.day) p.daysActive++;
    const L = this.s.ledger;
    const stats: DailyStats = {
      day: this.day,
      goldSupply: this.goldSupply(),
      priceIndex: priceIndex(prices),
      prices,
      world: { ...this.s.world.price },
      faucets: L.faucets.exports + L.faucets.adventurers + L.faucets.quests + L.faucets.signup,
      sinks: L.sinks.feeBurn + L.sinks.imports + L.sinks.upkeep,
      npcGold: Object.fromEntries(NPCS.map((id) => [id, this.s.npcs[id].gold])) as Record<NpcId, Gold>,
      broke: NPCS.filter((id) => this.s.npcs[id].brokeDays > 0),
      ledger: structuredClone(L),
    };
    this.s.dailyStats.push(stats);
    if (this.s.dailyStats.length > 120) this.s.dailyStats.shift();
  }

  /** Sum of every gold balance in the village economy. */
  goldSupply(): Gold {
    const s = this.s;
    let total = s.market.treasury + s.seasonPool;
    for (const n of Object.values(s.npcs)) total += n.gold;
    for (const p of Object.values(s.players)) total += p.gold;
    for (const gl of Object.values(s.guilds)) total += gl.fund;
    for (const o of s.orders) if (o.status === 'open') total += o.escrow;
    for (const st of s.stalls) total += st.gold;
    return total;
  }

  // ---------------------------------------------------------------- investments
  private settleInvestments() {
    for (const inv of this.s.investments) {
      if (inv.settled || this.day < inv.matureDay) continue;
      const n = this.s.npcs[inv.npc];
      const back = Math.min(inv.principal, Math.max(0, n.gold - g(10)));
      n.gold -= back;
      this.credit(inv.investor, back);
      inv.settled = true;
      const ret = inv.principal ? ((back + inv.paid - inv.principal) / inv.principal) * 100 : 0;
      this.feed('invest', `${this.ownerName(inv.investor)}'s investment in ${NPC_DEFS[inv.npc].name} matured · ${ret >= 0 ? '+' : ''}${ret.toFixed(0)}%`, inv.npc);
    }
    this.s.investments = this.s.investments.filter((i) => !i.settled || this.day - i.matureDay < 2);
  }

  private credit(who: { kind: 'player' | 'guild'; id: string }, amount: Gold) {
    if (who.kind === 'player') this.s.players[who.id].gold += amount;
    else this.s.guilds[who.id].fund += amount;
  }

  private deliver(who: { kind: 'player' | 'guild'; id: string }, item: ItemId, qty: number, unitPrice: Gold) {
    if (who.kind === 'player') {
      this.s.players[who.id].stock[item] += qty;
      return;
    }
    const gl = this.s.guilds[who.id];
    const held = gl.stock[item];
    const basis = gl.costBasis[item] ?? 0;
    gl.costBasis[item] = Math.round((basis * held + unitPrice * qty) / (held + qty));
    if (held === 0) gl.stockSince[item] = this.day;
    gl.stock[item] += qty;
  }

  private refundEscrow(o: Order) {
    if (o.escrow > 0) this.credit(o.by, o.escrow);
    o.escrow = 0;
  }

  ownerName(who: { kind: 'player' | 'guild'; id: string }) {
    return who.kind === 'player' ? this.s.players[who.id]?.name ?? who.id : this.s.guilds[who.id]?.name ?? who.id;
  }

  // ---------------------------------------------------------------- season
  guildScore(gl: Guild): number {
    if (gl.contributed <= 0) return 0;
    return (this.guildValue(gl) - gl.contributed) / gl.contributed;
  }

  guildValue(gl: Guild): Gold {
    let v = gl.fund;
    for (const i of ITEMS) v += gl.stock[i] * bidPrice(i, this.s.market.stock[i]);
    for (const inv of this.s.investments) if (!inv.settled && inv.investor.kind === 'guild' && inv.investor.id === gl.id) v += inv.principal;
    for (const o of this.s.orders) if (o.status === 'open' && o.by.kind === 'guild' && o.by.id === gl.id) v += o.escrow;
    for (const st of this.s.stalls) if (st.guild === gl.id) v += st.gold + ITEMS.reduce((s, i) => s + st.stock[i] * bidPrice(i, this.s.market.stock[i]), 0);
    return v;
  }

  eligible(gl: Guild): boolean {
    if (gl.ai) return gl.members.length >= 3;
    const active = gl.members.filter((m) => (this.s.players[m]?.daysActive ?? 0) >= 2);
    return active.length >= 3;
  }

  ranking() {
    return Object.values(this.s.guilds)
      .map((gl) => ({ guild: gl.id, name: gl.name, score: this.guildScore(gl), members: gl.members.length, eligible: this.eligible(gl) }))
      .sort((a, b) => b.score - a.score);
  }

  closeSeason() {
    const ranked = this.ranking().filter((r) => r.eligible).slice(0, 10);
    const pool = this.s.seasonPool;
    const result = ranked.map((r, i) => {
      const reward = bps(pool, RULES.seasonSplitBps[i]);
      this.s.guilds[r.guild].fund += reward;
      return { guild: r.guild, score: r.score, reward };
    });
    const paid = result.reduce((s, r) => s + r.reward, 0);
    this.s.seasonPool = pool - paid;
    this.s.lastSeasonResult = { season: this.s.season, ranking: result };
    result.slice(0, 3).forEach((r, i) => {
      const gl = this.s.guilds[r.guild];
      for (const m of gl.members) {
        const p = this.s.players[m];
        if (p) this.award(p, { kind: 'season', title: `Season ${this.s.season} · #${i + 1} · ${gl.name}`, description: `Top ${i + 1} guild of Hearthmarket season ${this.s.season}` });
      }
    });
    const tx = this.tx(contract(), 'close_season', { season: this.s.season });
    this.feed('season', `Season ${this.s.season} closed · ${fmt(paid, 0)} gold paid to the top ${result.length} guilds · tx ${short(tx)}`, undefined, tx);
    for (const gl of Object.values(this.s.guilds)) gl.contributed = Math.max(1, this.guildValue(gl));
    this.s.season++;
  }

  // ---------------------------------------------------------------- players & guilds
  addPlayer(id: string, name: string, bot = false): Player {
    if (this.s.players[id]) return this.s.players[id];
    const p: Player = {
      id, name, gold: RULES.playerStartGold, stock: emptyInventory(), guild: null,
      quests: Object.fromEntries(QUESTS.map((q) => [q.id, false])) as Record<QuestId, boolean>,
      bot, daysActive: 0, lastActiveDay: this.day,
    };
    this.s.players[id] = p;
    this.s.ledger.faucets.signup += p.gold;
    return p;
  }

  private addBotPlayer(i: number) {
    const p = this.addPlayer(`bot${i}`, `Bot ${i}`, true);
    const guilds = Object.values(this.s.guilds);
    if (guilds.length) {
      const gl = guilds[i % guilds.length];
      this.act({ kind: 'player', id: p.id }, { type: 'join_guild', guild: gl.id });
      this.act({ kind: 'player', id: p.id }, { type: 'deposit', amount: g(20 + (i % 3) * 5) });
    }
  }

  private seedAiGuilds() {
    for (const def of AI_GUILDS) {
      const leader = `ai-${def.id}-0`;
      const gl = this.newGuild(def.id, def.name, leader, true);
      gl.strategy = def.strategy;
      const size = 6 + (def.name.length % 5);
      for (let m = 0; m < size; m++) {
        const pid = `ai-${def.id}-${m}`;
        const p = this.addPlayer(pid, `${def.name} #${m}`, true);
        p.guild = gl.id;
        if (!gl.members.includes(pid)) gl.members.push(pid);
        const amt = g(40);
        p.gold -= amt;
        gl.fund += amt;
        gl.contributed += amt;
        gl.contributions[pid] = amt;
      }
    }
  }

  private newGuild(id: string, name: string, leader: string, ai: boolean): Guild {
    const gl: Guild = {
      id, name, ai, leader, members: [leader], fund: 0, contributed: 0, contributions: {}, warPoints: 0,
      stock: emptyInventory(), costBasis: {}, stockSince: {},
    };
    this.s.guilds[id] = gl;
    return gl;
  }

  private completeQuest(p: Player, q: QuestId) {
    if (p.quests[q]) return;
    p.quests[q] = true;
    p.gold += RULES.questReward;
    this.s.ledger.faucets.quests += RULES.questReward;
    if (!p.bot) this.feed('quest', `${p.name} completed "${QUESTS.find((x) => x.id === q)!.text}" · +${fmt(RULES.questReward, 0)} gold`);
    if (!p.bot && QUESTS.every((x) => p.quests[x.id])) {
      this.award(p, { kind: 'quest', title: 'First steps', description: 'Finished the four starter quests in Hearthmarket' });
    }
  }

  /** Give a human player a badge; the server mints it on chain through the badge hook. */
  private award(p: Player, b: { kind: string; title: string; description: string }) {
    if (p.bot) return;
    const tx = this.badgeHook?.(p.id, { ...b, season: this.s.season }) ?? undefined;
    (p.badges ??= []).push({ kind: b.kind, title: b.title, season: this.s.season, day: this.day, tx });
    this.feed('quest', `${p.name} earned the badge "${b.title}"${tx ? ` · tx ${short(tx)}` : ''}`, undefined, tx);
  }

  /** Server: patch a badge's placeholder hash once the mint lands. */
  patchTx(placeholder: string, hash: string) {
    const s = this.s;
    for (const t of s.txs) if (t.hash === placeholder) t.hash = hash;
    for (const f of s.feed) {
      if (f.tx === placeholder) {
        f.tx = hash;
        f.text = f.text.replace(short(placeholder), short(hash));
      }
    }
    for (const d of s.diary) if (d.tx === placeholder) d.tx = hash;
    for (const p of Object.values(s.players)) for (const b of p.badges ?? []) if (b.tx === placeholder) b.tx = hash;
  }

  private tallyVotes() {
    for (const gl of Object.values(this.s.guilds)) {
      const v = gl.vote;
      if (!v) continue;
      if (gl.ai) for (const m of gl.members) if (!v.yes.includes(m) && !v.no.includes(m)) v.yes.push(m);
      if (v.yes.length * 2 > gl.members.length) {
        gl.vote = undefined;
        const r = this.act({ kind: 'guild', id: gl.id, by: gl.leader }, v.action as Action);
        this.feed('guild', `${gl.name} vote passed: ${v.text}${r.ok ? '' : ` (failed: ${r.reason})`}`);
      } else if (v.no.length * 2 >= gl.members.length) {
        gl.vote = undefined;
        this.feed('guild', `${gl.name} vote rejected: ${v.text}`);
      }
    }
  }

  /**
   * Apply an action from a player, a guild or an NPC brain. NPC actions are
   * checked by the guard first; everything else is checked here like the contract would.
   */
  act(actor: Actor, a: Action): ActionResult {
    try {
      return this.actInner(actor, a);
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  private actInner(actor: Actor, a: Action): ActionResult {
    if (actor.kind === 'npc') return this.npcAct(actor.id, a);
    if (actor.kind === 'system') return { ok: false, reason: 'system actor cannot act' };

    const playerId = actor.kind === 'player' ? actor.id : actor.by;
    const p = this.s.players[playerId];
    if (!p) return { ok: false, reason: 'unknown player' };
    p.lastActiveDay = this.day;
    const signer = playerSigner(playerId);

    const guildOf = (): Guild | undefined => (p.guild ? this.s.guilds[p.guild] : undefined);
    const payerIsGuild = actor.kind === 'guild' || ('fromGuild' in a && a.fromGuild);
    const payer = () => {
      if (payerIsGuild) {
        const gl = actor.kind === 'guild' ? this.s.guilds[actor.id] : guildOf();
        if (!gl) throw new Error('not in a guild');
        if (actor.kind !== 'guild' && gl.leader !== p.id) throw new Error('only the guild leader can spend the fund (or pass a vote)');
        return { who: { kind: 'guild' as const, id: gl.id }, balance: () => gl.fund, take: (x: Gold) => { gl.fund -= x; } };
      }
      return { who: { kind: 'player' as const, id: p.id }, balance: () => p.gold, take: (x: Gold) => { p.gold -= x; } };
    };

    switch (a.type) {
      case 'market_buy': {
        if (a.qty <= 0 || a.qty > this.s.market.stock[a.item]) return { ok: false, reason: 'not enough stock' };
        const q = quoteBuy(a.item, this.s.market.stock[a.item], a.qty);
        const f = fee(q.total);
        if (q.last > a.maxPrice) return { ok: false, reason: `price moved to ${fmt(q.last)}` };
        const pay = payer();
        if (pay.balance() < q.total + f) return { ok: false, reason: 'not enough gold' };
        pay.take(q.total + f);
        this.s.market.treasury += q.total;
        this.s.market.stock[a.item] -= a.qty;
        this.takeFee(f);
        this.s.ledger.volume += q.total;
        this.deliver(pay.who, a.item, a.qty, Math.round(q.total / a.qty));
        const tx = this.tx(signer, 'market_buy', { item: a.item, qty: a.qty, max_price: a.maxPrice, ...(pay.who.kind === 'guild' ? { guild: pay.who.id } : {}) });
        if (a.item === 'wheat' && pay.who.kind === 'player' && p.stock.wheat >= 3) this.completeQuest(p, 'buy-wheat');
        return { ok: true, tx, info: `bought ${a.qty} ${a.item} for ${fmt(q.total + f)}` };
      }
      case 'market_sell': {
        const holder = payerIsGuild ? (actor.kind === 'guild' ? this.s.guilds[actor.id] : guildOf()) : p;
        if (!holder || holder.stock[a.item] < a.qty || a.qty <= 0) return { ok: false, reason: 'not enough stock' };
        const q = quoteSell(a.item, this.s.market.stock[a.item], a.qty);
        if (q.last < a.minPrice) return { ok: false, reason: `price moved to ${fmt(q.last)}` };
        if (q.total > this.s.market.treasury) return { ok: false, reason: 'market treasury is short' };
        const f = fee(q.total);
        holder.stock[a.item] -= a.qty;
        this.s.market.treasury -= q.total;
        this.s.market.stock[a.item] += a.qty;
        if ('fund' in holder) holder.fund += q.total - f;
        else holder.gold += q.total - f;
        this.takeFee(f);
        this.s.ledger.volume += q.total;
        const tx = this.tx(signer, 'market_sell', { item: a.item, qty: a.qty, min_price: a.minPrice, ...('fund' in holder ? { guild: holder.id } : {}) });
        return { ok: true, tx, info: `sold ${a.qty} ${a.item} for ${fmt(q.total - f)}` };
      }
      case 'place_order': {
        if (!this.producerOf(a.item)) return { ok: false, reason: `${a.item} cannot be ordered` };
        if (a.qty <= 0 || a.qty > 50) return { ok: false, reason: 'quantity must be 1-50' };
        if (a.deadlineDays < 1 || a.deadlineDays > 7) return { ok: false, reason: 'deadline must be 1-7 days' };
        const pay = payer();
        const escrow = a.qty * a.maxPrice + fee(a.qty * a.maxPrice);
        if (pay.balance() < escrow) return { ok: false, reason: 'not enough gold for escrow' };
        pay.take(escrow);
        const o: Order = {
          id: this.s.nextId++, by: pay.who, item: a.item, qty: a.qty, filled: 0, maxPrice: a.maxPrice,
          escrow, deadlineDay: this.day + a.deadlineDays, status: 'open',
        };
        this.s.orders.push(o);
        const tx = this.tx(signer, 'place_order', {
          order_id: o.id, item: a.item, qty: a.qty, max_price: a.maxPrice, deadline_day: o.deadlineDay, deadline_days: a.deadlineDays,
          ...(pay.who.kind === 'guild' ? { guild: pay.who.id } : {}),
        });
        const seller = NPC_DEFS[this.producerOf(a.item)!].name;
        this.feed('order', `${this.ownerName(pay.who)} ordered ${a.qty} ${a.item} from ${seller} · max ${fmt(a.maxPrice)} each`, this.producerOf(a.item), tx);
        if (a.item === 'sword' && pay.who.kind === 'player') this.completeQuest(p, 'order-sword');
        return { ok: true, tx, info: `order #${o.id} placed, ${fmt(escrow)} gold locked` };
      }
      case 'cancel_order': {
        const o = this.s.orders.find((x) => x.id === a.orderId && x.status === 'open');
        if (!o) return { ok: false, reason: 'no such open order' };
        const owner = o.by.kind === 'player' ? o.by.id === p.id : this.s.guilds[o.by.id]?.leader === p.id || actor.kind === 'guild';
        if (!owner) return { ok: false, reason: 'not your order' };
        o.status = 'cancelled';
        this.refundEscrow(o);
        return { ok: true, tx: this.tx(signer, 'cancel_order', { order_id: o.id, ...(o.by.kind === 'guild' ? { guild: o.by.id } : {}) }) };
      }
      case 'invest': {
        if (a.amount < g(1)) return { ok: false, reason: 'minimum investment is 1 gold' };
        const pay = payer();
        if (pay.balance() < a.amount) return { ok: false, reason: 'not enough gold' };
        const n = this.s.npcs[a.npc];
        if (!n || a.npc === 'bruno') return { ok: false, reason: 'cannot invest in this NPC' };
        pay.take(a.amount);
        n.gold += a.amount;
        n.inflowToday += a.amount;
        this.s.investments.push({
          id: this.s.nextId++, investor: pay.who, npc: a.npc, principal: a.amount, paid: 0,
          startDay: this.day, matureDay: this.day + RULES.investDays, settled: false,
        });
        const tx = this.tx(signer, 'guild_invest', { npc: NPC_DEFS[a.npc].account, amount: a.amount });
        this.feed('invest', `${this.ownerName(pay.who)} invest${pay.who.kind === 'guild' ? '' : 's'} ${fmt(a.amount, 0)} gold in ${NPC_DEFS[a.npc].name}`, a.npc, tx);
        if (a.npc === 'buba' && pay.who.kind === 'player' && a.amount >= g(10)) this.completeQuest(p, 'invest-buba');
        return { ok: true, tx };
      }
      case 'create_guild': {
        if (p.guild) return { ok: false, reason: 'already in a guild this season' };
        const name = a.name.trim().slice(0, 32);
        if (name.length < 2) return { ok: false, reason: 'name too short' };
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (this.s.guilds[id]) return { ok: false, reason: 'name taken' };
        this.newGuild(id, name, p.id, false);
        p.guild = id;
        const tx = this.tx(signer, 'create_guild', { name });
        this.feed('guild', `${p.name} founded the guild ${name}`, undefined, tx);
        this.completeQuest(p, 'join-guild');
        return { ok: true, tx };
      }
      case 'join_guild': {
        if (p.guild) return { ok: false, reason: 'already in a guild this season' };
        const gl = this.s.guilds[a.guild];
        if (!gl) return { ok: false, reason: 'no such guild' };
        if (gl.members.length >= 20) return { ok: false, reason: 'guild is full (20)' };
        gl.members.push(p.id);
        p.guild = gl.id;
        const tx = this.tx(signer, 'join_guild', { guild: gl.id });
        if (!p.bot) this.feed('guild', `${p.name} joined ${gl.name}`, undefined, tx);
        this.completeQuest(p, 'join-guild');
        return { ok: true, tx };
      }
      case 'deposit': {
        const gl = guildOf();
        if (!gl) return { ok: false, reason: 'join a guild first' };
        const cap = g(500);
        if ((gl.contributions[p.id] ?? 0) + a.amount > cap) return { ok: false, reason: 'per-member contribution cap is 500 gold' };
        if (p.gold < a.amount || a.amount <= 0) return { ok: false, reason: 'not enough gold' };
        p.gold -= a.amount;
        gl.fund += a.amount;
        gl.contributed += a.amount;
        gl.contributions[p.id] = (gl.contributions[p.id] ?? 0) + a.amount;
        return { ok: true, tx: this.tx(signer, 'deposit', { guild: gl.id, amount: a.amount }) };
      }
      case 'rent_stall': {
        const gl = actor.kind === 'guild' ? this.s.guilds[actor.id] : guildOf();
        if (!gl) return { ok: false, reason: 'join a guild first' };
        const st = this.s.stalls[a.slot];
        if (!st) return { ok: false, reason: 'no such stall' };
        if (st.guild) return { ok: false, reason: 'stall already rented this season' };
        if (this.s.stalls.some((x) => x.guild === gl.id)) return { ok: false, reason: 'one stall per guild' };
        if (gl.fund < RULES.stallRent) return { ok: false, reason: 'guild fund too low for rent' };
        gl.fund -= RULES.stallRent;
        this.s.seasonPool += RULES.stallRent;
        st.guild = gl.id;
        const tx = this.tx(signer, 'rent_stall', { slot: a.slot, guild: gl.id });
        this.feed('stall', `${gl.name} rented market stall ${a.slot + 1}`, undefined, tx);
        return { ok: true, tx };
      }
      case 'set_stall_prices': {
        const gl = actor.kind === 'guild' ? this.s.guilds[actor.id] : guildOf();
        const st = this.s.stalls[a.slot];
        if (!gl || !st || st.guild !== gl.id) return { ok: false, reason: 'not your stall' };
        if (a.buy >= a.sell) return { ok: false, reason: 'buy price must be below sell price' };
        if (a.fund && a.fund > 0) {
          if (gl.fund < a.fund) return { ok: false, reason: 'guild fund too low' };
          gl.fund -= a.fund;
          st.gold += a.fund;
          st.funded += a.fund;
        }
        st.buy[a.item] = a.buy;
        st.sell[a.item] = a.sell;
        return { ok: true, tx: this.tx(signer, 'set_stall_prices', { slot: a.slot, item: a.item, buy: a.buy, sell: a.sell }) };
      }
      case 'propose_vote': {
        const gl = guildOf();
        if (!gl) return { ok: false, reason: 'join a guild first' };
        if (gl.vote) return { ok: false, reason: 'a vote is already open' };
        gl.vote = { id: this.s.nextId++, text: a.text, yes: [p.id], no: [], action: a.action };
        this.feed('guild', `${p.name} opened a vote in ${gl.name}: ${a.text}`);
        return { ok: true };
      }
      case 'cast_vote': {
        const gl = guildOf();
        if (!gl?.vote || gl.vote.id !== a.voteId) return { ok: false, reason: 'no such vote' };
        const v = gl.vote;
        v.yes = v.yes.filter((x) => x !== p.id);
        v.no = v.no.filter((x) => x !== p.id);
        (a.yes ? v.yes : v.no).push(p.id);
        this.tallyVotes();
        return { ok: true };
      }
      default:
        return { ok: false, reason: `players cannot call ${a.type}` };
    }
  }

  /**
   * A day plan from the NPC brain. The plan guard keeps only this NPC's dials and clamps
   * them; the result is written to the diary. Plans tune thresholds, they never move gold.
   */
  setPlan(id: NpcId, proposal: Record<string, unknown>, by: string, why = '', saw = ''): NpcPlan {
    const { plan, notes } = checkPlan(id, proposal, this.day, by, why);
    this.s.npcs[id].plan = plan;
    this.diary({
      npc: id,
      goal: `plan day ${this.day}`,
      saw: saw || `village and world prices at ${String(this.hour).padStart(2, '0')}:00`,
      think: plan.why || '(no reason given)',
      act: `plan: ${describePlan(plan)}`,
      guard: notes.length ? `plan guard: ${notes.join('; ')}` : 'plan guard: all dials in range · plans never move gold',
    });
    return plan;
  }

  /** Action proposed by an NPC brain (LLM). Guard first, then a narrow set of effects. */
  npcAct(id: NpcId, a: Action): ActionResult {
    const n = this.s.npcs[id];
    const def = NPC_DEFS[id];
    const receiver = a.type === 'call' && a.receiver ? a.receiver : contract();
    const v = checkNpcAction({ contract: contract(), receiver, action: a, spentToday: n.spentToday, dailyBudget: def.dailyBudget });
    if (!v.ok) {
      const tx = this.tx(def.account, v.method, a as unknown as Record<string, unknown>, false, v.reason);
      this.feed('blocked', `${def.name}: ${v.method} BLOCKED · ${v.reason}`, id, tx);
      return { ok: false, reason: v.reason };
    }
    switch (a.type) {
      case 'market_buy': {
        const got = this.npcBuy(n, a.item, a.qty, a.maxPrice);
        return got ? { ok: true, info: `bought ${got}` } : { ok: false, reason: 'no fill' };
      }
      case 'market_sell': {
        const got = this.npcSell(n, a.item, a.qty, a.minPrice);
        return got ? { ok: true, info: `sold ${got}` } : { ok: false, reason: 'no fill' };
      }
      case 'hire': {
        const seller = this.s.npcs[a.seller];
        if (!seller || seller.stock[a.item] < a.qty) return { ok: false, reason: 'seller lacks stock' };
        const total = a.price * a.qty;
        const f = fee(total);
        if (n.gold < total + f) return { ok: false, reason: 'not enough gold' };
        n.gold -= total + f;
        n.spentToday += total + f;
        seller.gold += total;
        seller.stock[a.item] -= a.qty;
        n.stock[a.item] += a.qty;
        this.takeFee(f);
        const tx = this.tx(def.account, 'hire', { seller: NPC_DEFS[a.seller].account, item: a.item, qty: a.qty, price: a.price });
        return { ok: true, tx };
      }
      default:
        return { ok: false, reason: `${a.type} is handled by the rule engine` };
    }
  }

  // ---------------------------------------------------------------- cosmetic movement
  /** NPCs stay home, walk to the plaza for the afternoon market, then go home. The client animates the walk. */
  private wander() {
    const atMarket = this.hour >= 14 && this.hour <= 17;
    for (const id of NPCS) {
      const n = this.s.npcs[id];
      const [x, y] = atMarket ? MARKET_SPOT[id] : HOME[id];
      n.x = x;
      n.y = y;
    }
  }
}

/** Engine signer string for a player; the server maps it to the player's NEAR account. */
export const PLAYER_SIGNER_SUFFIX = '.players.hearth';
export const playerSigner = (playerId: string) => `${playerId}${PLAYER_SIGNER_SUFFIX}`;

/** Kind of a tx hash as recorded by the engine. */
export function txKind(tx: string): 'chain' | 'pending' | 'failed' | 'local' | 'sim' {
  if (tx.startsWith('pending')) return 'pending';
  if (tx.startsWith('failed:')) return 'failed';
  if (tx.startsWith('local')) return 'local';
  if (tx.startsWith('sim')) return 'sim';
  return 'chain';
}

/** Short label for a tx hash in the feed: `5irr…1Q`, `pending…`, `failed`, `off-chain`, `sim`. */
export function short(tx: string): string {
  switch (txKind(tx)) {
    case 'pending': return 'pending…';
    case 'failed': return 'failed';
    case 'local': return 'off-chain';
    case 'sim': return 'sim';
    default: return `${tx.slice(0, 4)}…${tx.slice(-2)}`;
  }
}

export function marketView(v: Village) {
  const st = v.s.market.stock;
  return ITEMS.map((i) => {
    const h = v.s.market.history[i];
    const prev = h.length > 1 ? h[h.length - 2] : h[0] ?? midPrice(i, st[i]);
    const mid = midPrice(i, st[i]);
    return {
      item: i,
      name: ITEM_DEFS[i].name,
      village: mid,
      ask: askPrice(i, st[i]),
      bid: bidPrice(i, st[i]),
      world: v.s.world.price[i],
      change24h: prev ? (mid - prev) / prev : 0,
      spark: h.slice(-7),
      stock: st[i],
      target: ITEM_DEFS[i].target,
    };
  });
}

export type MarketRow = ReturnType<typeof marketView>[number];
export type { Inventory };
