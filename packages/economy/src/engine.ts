import { noteDelivery, notePromise, noteTrade } from './regard.ts';
import type { KeeperJob, KeeperStrategy, Listing } from './types.ts';
import { GOAL, goalTargets, netWorth, starsFor } from './goal.ts';
import { RIVAL, rivalStep, rivalWorth } from './rival.ts';
import { COUNCIL_DAYS, COUNCIL_EVERY, councilInForce, MOTIONS, newMotion, rivalVote, tally } from './council.ts';
import type { CoopOrder } from './types.ts';
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
import type { WorldFx } from './types.ts';
import { checkDeal, describeDeal, DEAL_BAND, DEAL_MAX_QTY, DEAL_MAX_ROUNDS, type Deal, type DealRound } from './deals.ts';
import { applyWorldDay, initialWorld, SyntheticWorld, type WorldDay } from './world.ts';
import type {
  Action, ActionResult, Actor, DailyStats, DiaryEntry, FeedEvent, FeedKind, Guild, Inventory, NpcState,
  NpcRequest, Order, Player, Stall, VillageState,
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
  /** Silas, an AI rival trader who plays the player's game against them (rival.ts) */
  rival?: boolean;
  /** the village council (council.ts) and co-op orders: shared decisions between players and NPCs */
  social?: boolean;
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
  mike: [44, 13], jack: [20, 22], buba: [10, 22], chloe: [18, 12], theo: [30, 12], bruno: [12, 13],
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
      if (opts.rival) this.addRival();
      if (opts.social) this.s.council = [];
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
      case 7: this.settleDeals(); break;
      case 8: this.buyInputs(); break;
      case 9: this.keepersWork(); break;
      case 10: this.fillOrders(); break;
      case 11: this.npcBuyListings(); break;
      case 12: this.produceAll(); break;
      case 13: this.fillOrders(); this.npcCoop(); break;
      case 15: this.sellSurplus(); break;
      case 16: this.npcBuyListings(); this.expireListings(); break;
      case 17: this.brunoTrade(); break;
      case 19: this.adventurers(); break;
      case 20: this.aiTick?.(this); this.tallyVotes(); this.keepersReport(); this.tallyCouncil(); break;
      case 23: this.closeDay(); break;
    }
    rivalStep(this, h);
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
    this.closeGoals(day);
    this.socialDay(day);
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
    this.postRequests();
  }

  // ---------------------------------------------------------------- NPC requests (daily quests)
  /**
   * Each morning two NPCs ask players for goods they need: the baker wants wheat, the
   * smith ore or timber, the others bread for the table. Bad weather where that good is
   * grown makes it urgent. The NPC pays a premium from its own gold; the quest faucet adds
   * a small bonus. The first player to bring the goods gets it.
   */
  private postRequests() {
    const wants: { npc: NpcId; item: ItemId; qty: [number, number]; why: string }[] = [
      { npc: 'chloe', item: 'wheat', qty: [4, 6], why: "for tomorrow's bake" },
      { npc: 'theo', item: 'ore', qty: [2, 4], why: 'for the forge' },
      { npc: 'theo', item: 'timber', qty: [2, 3], why: 'for tool handles' },
      { npc: 'mike', item: 'bread', qty: [2, 3], why: 'for the mine crew' },
      { npc: 'jack', item: 'bread', qty: [2, 3], why: 'for a long day in the woods' },
      { npc: 'buba', item: 'bread', qty: [2, 3], why: 'for the harvest hands' },
    ];
    const picks: typeof wants = [];
    const pool = [...wants];
    while (picks.length < RULES.requestsPerDay && pool.length) {
      const w = pool.splice(Math.floor(this.rng.next() * pool.length), 1)[0];
      if (!picks.some((x) => x.npc === w.npc)) picks.push(w);
    }
    this.checkPromises();
    // delivered ones stay a day for the card; big orders stay open until their due day
    const keep = (this.s.requests ?? []).filter((r) => (r.by && this.day - r.day < 2) || (r.due !== undefined && !r.by && !r.missed && this.day <= r.due) || (r.missed && this.day - r.due! <= 1));
    this.s.requests = [...keep];
    this.postBigOrder();
    for (const w of picks) {
      const n = this.s.npcs[w.npc];
      const qty = w.qty[0] + Math.floor(this.rng.next() * (w.qty[1] - w.qty[0] + 1));
      const price = Math.round(midPrice(w.item, this.s.market.stock[w.item]) * RULES.requestPremiumBps / 10_000);
      if (n.gold < price * qty + g(10)) continue;
      const region = this.s.world.regions.find((r) => r.item === w.item && r.severity > 0.25);
      const text = region
        ? `Bring ${qty} ${w.item} before the ${region.headline.toLowerCase()} in ${region.name} drives the price up`
        : `Bring ${qty} ${w.item} ${w.why}`;
      // council: bonuses up 50% while that motion holds (the contract caps a bonus at 10 gold)
      const bonus = councilInForce(this, 'bonus_up') ? Math.min(g(10), Math.round(RULES.requestBonus * 1.5)) : RULES.requestBonus;
      const r: NpcRequest = { id: this.s.nextId++, npc: w.npc, item: w.item, qty, price, bonus, day: this.day, text };
      this.s.requests.push(r);
      this.feed('quest', `${NPC_DEFS[w.npc].name} asks: "${text}" · pays ${fmt(price)} each + ${fmt(r.bonus, 0)} bonus`, w.npc);
    }
  }

  /**
   * Every other day one NPC posts a big order: more goods, a 35% premium and a bigger bonus,
   * open for a few days. A player accepts it first (only one may); delivering in time counts
   * twice in the NPC's memory, missing the day is remembered and costs 2% on later prices.
   * Picked from the day number, not the random stream, so seeded runs stay the same.
   */
  /** Big orders whose due day passed: a promise not kept is remembered. */
  private checkPromises() {
    const day = this.day;
    for (const r of this.s.requests ?? []) {
      if (r.due === undefined || r.by || r.missed || day <= r.due) continue;
      if (r.takenBy) {
        r.missed = true;
        notePromise(this, r.npc, r.takenBy, false);
        const p = this.s.players[r.takenBy];
        this.feed('quest', `${NPC_DEFS[r.npc].name} waited for ${p?.name ?? 'a player'}'s ${r.qty} ${r.item} and is upset: prices for them go up`, r.npc);
      }
    }
  }

  private postBigOrder() {
    const day = this.day;
    if (day % 2 !== 0 || (this.s.requests ?? []).some((r) => r.due !== undefined && !r.by && !r.missed)) return;
    const orders: { npc: NpcId; item: ItemId; qty: number; why: string }[] = [
      { npc: 'chloe', item: 'wheat', qty: 10, why: 'for the harvest festival bake' },
      { npc: 'theo', item: 'ore', qty: 8, why: 'for a caravan of swords' },
      { npc: 'theo', item: 'timber', qty: 8, why: 'to rebuild the forge roof' },
      { npc: 'chloe', item: 'wheat', qty: 12, why: 'before winter flour runs short' },
    ];
    const o = orders[(day / 2) % orders.length];
    const n = this.s.npcs[o.npc];
    const price = Math.round(midPrice(o.item, this.s.market.stock[o.item]) * RULES.bigOrderPremiumBps / 10_000);
    // the whole order must fit the NPC's daily budget and purse
    const qty = Math.min(o.qty, Math.floor((NPC_DEFS[o.npc].dailyBudget * 0.9) / price));
    if (qty < 4 || n.gold < price * qty + g(10)) return;
    const due = day + RULES.bigOrderDays - 1;
    const text = `Big order: ${qty} ${o.item} ${o.why}, within ${RULES.bigOrderDays} days`;
    const r: NpcRequest = { id: this.s.nextId++, npc: o.npc, item: o.item, qty, price, bonus: RULES.bigOrderBonus, day, text, due };
    (this.s.requests ??= []).push(r);
    this.feed('quest', `${NPC_DEFS[o.npc].name} posts a big order: ${qty} ${o.item} within ${RULES.bigOrderDays} days · pays ${fmt(price)} each + ${fmt(r.bonus, 0)} bonus · accept it to take it on`, o.npc);
  }

  // ---------------------------------------------------------------- council and co-op orders
  /** Day start: a council motion every third day; a co-op order every fourth; old co-ops close. */
  private socialDay(day: number) {
    if (!this.s.council) return;
    if (day % COUNCIL_EVERY === 0) {
      const m = newMotion(this, this.s.nextId++);
      const rival = this.s.players[RIVAL.id];
      if (rival) m.votes.push({ who: RIVAL.id, kind: 'player', name: rival.name, ...rivalVote(this, RIVAL.id, m.kind) });
      this.s.council.push(m);
      if (this.s.council.length > 8) this.s.council.shift();
      const t = tally(m);
      this.feed('quest', `Council: "${m.title}". NPCs so far ${t.yes} yes, ${t.no} no · players vote until 20:00`);
    }
    for (const c of this.s.coops ?? []) if (c.status === 'open' && day > c.due) {
      c.status = 'expired';
      this.feed('quest', `Bruno's caravan left with ${c.qty - this.coopLeft(c)}/${c.qty} ${c.item}: not filled, no bonus`, 'bruno');
    }
    if (day % 4 === 2) this.postCoop(day);
  }

  /** 20:00 on motion day: count every vote; a motion that passes holds for the next two days. */
  private tallyCouncil() {
    const m = this.s.council?.at(-1);
    if (!m || m.status !== 'open' || m.day !== this.day) return;
    const t = tally(m);
    m.status = t.passes ? 'passed' : 'failed';
    if (t.passes) { m.from = this.day + 1; m.to = this.day + COUNCIL_DAYS; }
    const players = m.votes.filter((x) => x.kind === 'player' && x.who !== RIVAL.id).length;
    this.feed('quest', `Council ${t.passes ? 'passes' : 'rejects'} "${m.title}" ${t.yes}–${t.no}${players ? ` (${players} player vote${players === 1 ? '' : 's'})` : ''}${t.passes ? `: ${MOTIONS[m.kind].effect} for ${COUNCIL_DAYS} days` : ''}`);
  }

  private coopLeft(c: CoopOrder) {
    return c.qty - c.parts.reduce((s, p) => s + p.qty, 0);
  }

  /** Bruno's caravan: a large lot of one item at 25% over the market, open for three days. */
  private postCoop(day: number) {
    const item = (['wheat', 'ore', 'timber'] as ItemId[])[Math.floor(day / 4) % 3];
    if ((this.s.coops ?? []).some((c) => c.status === 'open')) return;
    const price = Math.round(midPrice(item, this.s.market.stock[item]) * 1.25);
    const qty = 30;
    if (this.s.npcs.bruno.gold < price * qty + g(40)) return;
    const c: CoopOrder = { id: this.s.nextId++, item, qty, price, bonus: g(10), day, due: day + 2, status: 'open', parts: [] };
    (this.s.coops ??= []).push(c);
    if (this.s.coops.length > 6) this.s.coops.shift();
    this.feed('quest', `Co-op order: Bruno's caravan needs ${qty} ${item} within 3 days · pays ${fmt(price, 2)} each (25% over the market) + ${fmt(c.bonus, 0)} gold split by share when it is full · anyone can chip in`, 'bruno');
  }

  /** Bruno pays for a share of the caravan; the bonus is split when the lot is full. */
  private coopTake(c: CoopOrder, who: { kind: 'npc' | 'player'; id: string }, qty: number, tx?: string) {
    const b = this.s.npcs.bruno;
    const pay = c.price * qty;
    b.gold -= pay;
    b.spentToday += pay;
    b.stock[c.item] += qty;
    this.s.ledger.volume += pay;
    const name = who.kind === 'npc' ? NPC_DEFS[who.id as NpcId].name : this.s.players[who.id]?.name ?? who.id;
    const part = c.parts.find((p) => p.kind === who.kind && p.id === who.id);
    if (part) { part.qty += qty; part.paid += pay; if (tx) part.tx = tx; } else c.parts.push({ ...who, name, qty, paid: pay, ...(tx ? { tx } : {}) });
    this.feed('quest', `${name} adds ${qty} ${c.item} to Bruno's caravan · ${c.qty - this.coopLeft(c)}/${c.qty}${tx ? ` · tx ${short(tx)}` : ''}`, who.kind === 'npc' ? (who.id as NpcId) : 'bruno', tx);
    if (this.coopLeft(c) <= 0) {
      c.status = 'filled';
      // the bonus, by share; rounding leftovers stay with Bruno
      for (const p of c.parts) {
        const share = Math.floor((c.bonus * p.qty) / c.qty);
        if (share <= 0) continue;
        b.gold -= share;
        p.bonus = share;
        if (p.kind === 'npc') this.s.npcs[p.id as NpcId].gold += share;
        else if (this.s.players[p.id]) this.s.players[p.id].gold += share;
      }
      this.feed('quest', `Bruno's caravan is full: ${c.parts.map((p) => `${p.name} ${p.qty}`).join(', ')} · bonus split by share`, 'bruno');
    }
  }

  /**
   * 13:00: the producer of the caravan's item chips in from its surplus (Bruno signs a hire
   * with his own key), at most 40% of the lot over the days; Silas joins when it pays him.
   */
  private npcCoop() {
    const c = (this.s.coops ?? []).find((x) => x.status === 'open');
    if (!c) return;
    const producer = NPCS.find((id) => NPC_DEFS[id].produces[0] === c.item && id !== 'bruno');
    if (producer) {
      const n = this.s.npcs[producer];
      const given = c.parts.find((p) => p.kind === 'npc' && p.id === producer)?.qty ?? 0;
      const spare = n.stock[c.item] - this.reservedFor(producer, c.item) - 2;
      const qty = Math.min(spare, Math.floor(c.qty * 0.4) - given, this.coopLeft(c));
      const b = this.s.npcs.bruno;
      if (qty > 0 && b.gold >= c.price * qty) {
        const action: Action = { type: 'hire', seller: producer, item: c.item, qty, price: c.price };
        if (this.guarded(b, action)) {
          n.stock[c.item] -= qty;
          n.gold += c.price * qty;
          const tx = this.tx(NPC_DEFS.bruno.account, 'hire', { seller: NPC_DEFS[producer].account, item: c.item, qty, price: c.price });
          this.coopTake(c, { kind: 'npc', id: producer }, qty, tx);
          this.diary({
            npc: producer, goal: 'sell my surplus well', saw: `Bruno's caravan pays ${fmt(c.price, 2)} per ${c.item}, the market ${fmt(midPrice(c.item, this.s.market.stock[c.item]), 2)}`,
            think: '25% over the market for goods I would sell anyway', act: `caravan: ${qty} ${c.item}`, tx, guard: 'ok: Bruno buys inside his daily budget', by: 'rules',
          });
        }
      }
    }
    const rival = this.s.players[RIVAL.id];
    if (rival && c.status === 'open') {
      const ask = askPrice(c.item, this.s.market.stock[c.item]);
      const have = rival.stock[c.item];
      const room = Math.min(this.coopLeft(c), Math.floor(c.qty * 0.3) - (c.parts.find((p) => p.id === RIVAL.id)?.qty ?? 0));
      if (room > 0 && (have > 0 || ask < c.price * 0.9)) {
        if (have < room && ask < c.price * 0.9) this.act({ kind: 'player', id: RIVAL.id }, { type: 'market_buy', item: c.item, qty: Math.min(room - have, 8), maxPrice: Math.round(c.price * 0.95) });
        const q = Math.min(room, rival.stock[c.item]);
        if (q > 0) this.act({ kind: 'player', id: RIVAL.id }, { type: 'coop_give', id: c.id, qty: q });
      }
    }
  }

  openCoop(): CoopOrder | undefined {
    return (this.s.coops ?? []).find((c) => c.status === 'open');
  }

  // ---------------------------------------------------------------- free-play goal (goal.ts)
  /** A player's week is over at the start of day startDay + 7: lock the stars. */
  private closeGoals(day: number) {
    for (const p of Object.values(this.s.players)) {
      const st = p.goal;
      if (!st || st.result || day - st.startDay < GOAL.days) continue;
      const worth = netWorth(this, p.id);
      const stars = starsFor(st, worth);
      const rivalGain = st.rivalStart !== undefined && this.s.players[RIVAL.id] ? rivalWorth(this) - st.rivalStart : undefined;
      st.result = { stars, worth, day, ...(rivalGain !== undefined ? { rivalGain } : {}) };
      st.best = Math.max(st.best ?? 0, stars);
      const vs = rivalGain === undefined ? '' : worth - st.startWorth >= rivalGain ? `, ahead of ${RIVAL.name} (${rivalGain >= 0 ? '+' : ''}${fmt(rivalGain)})` : `, behind ${RIVAL.name} (${rivalGain >= 0 ? '+' : ''}${fmt(rivalGain)})`;
      this.feed('quest', `${p.name} finished the week with ${fmt(worth)} gold: ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}${vs}`);
    }
  }

  // ---------------------------------------------------------------- stall board (player listings)
  openListings() {
    return (this.s.listings ?? []).filter((l) => l.status === 'open');
  }

  /** Goods from the seller into escrow (the same relay whether the player or their keeper lists). */
  private newListing(seller: string, item: ItemId, qty: number, price: Gold, keeper?: KeeperJob): Listing {
    const p = this.s.players[seller];
    p.stock[item] -= qty;
    const l: Listing = { id: this.s.nextId++, seller, item, qty, price, status: 'open', day: this.day, ...(keeper ? { keeper: keeper.id } : {}) };
    (this.s.listings ??= []).push(l);
    l.tx = this.tx(playerSigner(seller), 'list_item', { listing_id: l.id, item, qty, price });
    const by = keeper ? `${NPC_DEFS[keeper.npc].name}, keeping ${p.name}'s stall,` : p.name;
    this.feed('stall', `${by} lists ${qty} ${item} on the stall board at ${fmt(price, 2)} each`, keeper?.npc, l.tx);
    return l;
  }

  /** The buyer has paid `price × qty` already; the seller gets it, the listing closes. */
  private sellListing(l: Listing, buyer: { kind: 'npc' | 'player'; id: string }, tx: string) {
    const seller = this.s.players[l.seller];
    const total = l.price * l.qty;
    if (seller) seller.gold += total;
    l.status = 'sold';
    l.buyer = buyer;
    l.saleTx = tx;
    this.s.ledger.volume += total;
    const job = l.keeper !== undefined ? this.s.keepers?.find((k) => k.id === l.keeper) : undefined;
    if (job && seller) {
      // the keeper's commission, paid by the seller out of the sale
      const c = Math.round((total * RULES.keeperCommissionBps) / 10_000);
      seller.gold -= c;
      this.s.npcs[job.npc].gold += c;
      this.s.npcs[job.npc].inflowToday += c;
      job.left -= l.qty;
      job.sold += l.qty;
      job.earned += total - c;
      job.commission += c;
      job.listingId = undefined;
      job.saleNote = `sold ${l.qty} ${l.item} at ${fmt(l.price, 2)} to ${buyer.kind === 'npc' ? NPC_DEFS[buyer.id as NpcId].name : this.s.players[buyer.id]?.name ?? 'a player'}`;
      if (job.left <= 0) job.status = 'done';
    }
    const who = buyer.kind === 'npc' ? NPC_DEFS[buyer.id as NpcId].name : this.s.players[buyer.id]?.name ?? buyer.id;
    if (buyer.kind === 'npc' && seller) noteTrade(this, buyer.id as NpcId, seller.id, total);
    this.feed('stall', `${who} bought ${seller?.name ?? 'a player'}'s ${l.qty} ${l.item} from the stall board at ${fmt(l.price, 2)} · +${fmt(total)} gold`, buyer.kind === 'npc' ? (buyer.id as NpcId) : undefined, tx);
  }

  /** Goods back to the seller (their cancel, or the board clearing old listings). */
  private cancelListing(l: Listing, why: 'cancelled' | 'expired' | 'repriced'): string {
    const seller = this.s.players[l.seller];
    if (seller) seller.stock[l.item] += l.qty;
    l.status = 'cancelled';
    const tx = this.tx(playerSigner(l.seller), 'cancel_listing', { listing_id: l.id });
    const job = l.keeper !== undefined ? this.s.keepers?.find((k) => k.id === l.keeper) : undefined;
    if (job && job.listingId === l.id) job.listingId = undefined;
    if (why !== 'repriced') this.feed('stall', `${seller?.name ?? 'A player'}'s ${l.qty} ${l.item} ${why === 'expired' ? `went back home after ${RULES.listingDays} days on the board` : 'came off the stall board'}`, job?.npc, tx);
    return tx;
  }

  private expireListings() {
    for (const l of this.openListings()) if (l.keeper === undefined && this.day - l.day >= RULES.listingDays) this.cancelListing(l, 'expired');
  }

  // ---------------------------------------------------------------- hired stall keepers
  /**
   * The keeper's price for today, and why. quick: just under what Bruno pays, so it sells at
   * 11:00; hold: the market price, for a crafter who needs it; wait: holds out above the market
   * while the world says the price is rising, then sells like hold. The last day sells quickly.
   */
  keeperPrice(job: KeeperJob): { price: Gold; why: string } {
    const st = this.s.market.stock[job.item];
    const mid = midPrice(job.item, st);
    const bid = bidPrice(job.item, st);
    const lo = Math.ceil(mid * 0.5), hi = Math.floor(mid * 2);
    const clampP = (x: number) => Math.max(lo, Math.min(hi, Math.round(x)));
    const lastDay = this.day - job.startDay >= RULES.keeperDays - 1;
    const rising = this.s.world.regions.find((r) => r.item === job.item && (r.impact > 0.02 || (r.forecast && r.severity > 0.2)));
    if (job.strategy === 'quick' || (lastDay && job.strategy !== 'hold')) {
      return { price: clampP(bid * 0.93), why: lastDay && job.strategy !== 'quick' ? 'last day, so priced to sell to Bruno' : `just under what Bruno pays (${fmt(bid, 2)}), so it goes at 11:00` };
    }
    if (job.strategy === 'wait' && rising) {
      return { price: clampP(mid * 1.12), why: `${rising.name}: ${rising.headline || rising.forecast}; holding out 12% above the market` };
    }
    return { price: clampP(mid), why: `at the market price (${fmt(mid, 2)}), for a crafter who needs it` };
  }

  /** 9:00: each keeper (re)prices its listing before the NPCs look at the board. */
  private keepersWork() {
    for (const job of this.s.keepers ?? []) {
      if (job.status !== 'working') continue;
      const p = this.s.players[job.player];
      if (!p) { job.status = 'done'; continue; }
      if (this.day - job.startDay >= RULES.keeperDays) { this.endKeeper(job, `${RULES.keeperDays} days are up`); continue; }
      const { price, why } = this.keeperPrice(job);
      const cur = job.listingId !== undefined ? this.s.listings?.find((l) => l.id === job.listingId && l.status === 'open') : undefined;
      if (cur && Math.abs(cur.price - price) <= cur.price * 0.03) { job.todayWhy = `kept ${fmt(cur.price, 2)}: ${why}`; continue; }
      if (cur) this.cancelListing(cur, 'repriced');
      const qty = Math.min(job.left, p.stock[job.item], RULES.listingMaxQty);
      if (qty <= 0) { this.endKeeper(job, 'nothing left to sell'); continue; }
      job.listingId = this.newListing(p.id, job.item, qty, price, job).id;
      job.todayWhy = `${cur ? 'repriced' : 'listed'} at ${fmt(price, 2)}: ${why}`;
    }
  }

  private endKeeper(job: KeeperJob, why: string) {
    const cur = job.listingId !== undefined ? this.s.listings?.find((l) => l.id === job.listingId && l.status === 'open') : undefined;
    if (cur) this.cancelListing(cur, 'cancelled');
    job.status = 'done';
    const name = NPC_DEFS[job.npc].name;
    const text = `${name} closed your stall (${why}): sold ${job.sold} ${job.item}, you got ${fmt(job.earned)} gold after ${fmt(job.commission)} commission${job.left > 0 ? `; ${job.left} came back to you` : ''}.`;
    job.reports.push({ day: this.day, text });
    this.feed('stall', text, job.npc);
  }

  /** 20:00: what each keeper sold today, and why it priced that way. */
  private keepersReport() {
    for (const job of this.s.keepers ?? []) {
      if (job.status !== 'working' && !job.saleNote) continue;
      const name = NPC_DEFS[job.npc].name;
      const parts = [job.saleNote ? `${job.saleNote}.` : 'No sale today.', job.todayWhy ? `Price: ${job.todayWhy}.` : ''];
      if (job.status === 'done' && job.left <= 0) parts.push(`All sold: ${fmt(job.earned)} gold for you, ${fmt(job.commission)} for me.`);
      else parts.push(`${job.left} ${job.item} left.`);
      job.reports.push({ day: this.day, text: `${name}: ${parts.filter(Boolean).join(' ')}` });
      if (job.reports.length > 8) job.reports.shift();
      job.saleNote = undefined;
    }
  }

  /**
   * 11:00 and 16:00: NPCs look at the stall board. A crafter buys inputs it needs today when a
   * listing beats the market's ask; Bruno buys anything priced at least 5% under what the market
   * pays, to resell. Whole listings only, inside the same spending guard as every NPC trade.
   */
  private npcBuyListings() {
    for (const l of [...this.openListings()].sort((a, b) => a.price / midPrice(a.item, this.s.market.stock[a.item]) - b.price / midPrice(b.item, this.s.market.stock[b.item]))) {
      const total = l.price * l.qty;
      const ask = askPrice(l.item, this.s.market.stock[l.item]);
      const bid = bidPrice(l.item, this.s.market.stock[l.item]);
      const crafter = NPCS.find((id) => {
        if (id === 'bruno') return false;
        const n = this.s.npcs[id];
        const missing = (this.inputNeed(n)[l.item] ?? 0) - n.stock[l.item];
        return missing > 0 && l.qty <= missing + 2 && l.price < ask && n.gold - total >= RULES.npcListingReserve;
      });
      const brunoBuys = l.price <= bid * 0.95 && this.s.npcs.bruno.gold - total >= g(60);
      let id = crafter ?? (brunoBuys ? 'bruno' : undefined);
      // a keeper never buys the stall it keeps
      if (id && l.keeper !== undefined && this.s.keepers?.find((k) => k.id === l.keeper)?.npc === id) id = brunoBuys ? 'bruno' : undefined;
      if (!id) continue;
      const n = this.s.npcs[id];
      if (!this.guarded(n, { type: 'market_buy', item: l.item, qty: l.qty, maxPrice: l.price })) continue;
      n.gold -= total;
      n.spentToday += total;
      n.stock[l.item] += l.qty;
      const tx = this.tx(NPC_DEFS[id].account, 'npc_stall_buy', { listing_id: l.id, amount: total });
      this.sellListing(l, { kind: 'npc', id }, tx);
      this.diary({
        npc: id, goal: id === 'bruno' ? 'buy cheap, resell to the market' : `inputs for today's ${NPC_DEFS[id].produces[0]}`,
        saw: `${this.s.players[l.seller]?.name ?? 'A player'} lists ${l.qty} ${l.item} at ${fmt(l.price, 2)}; market ask ${fmt(ask, 2)}, bid ${fmt(bid, 2)}`,
        think: id === 'bruno' ? 'cheaper than the market pays: a safe resale' : 'cheaper than buying from the market',
        act: `npc_stall_buy listing #${l.id} for ${fmt(total)}`, tx, guard: 'ok: market_buy within the daily budget', by: 'rules',
      });
    }
  }

  /** Open requests a player can still fill today (big orders until their due day). */
  openRequests(): NpcRequest[] {
    return (this.s.requests ?? [])
      .filter((r) => !r.by && !r.missed && (r.due !== undefined ? this.day <= r.due : r.day === this.day))
      .sort((a, b) => Number(a.due !== undefined) - Number(b.due !== undefined)); // today's requests first, then big orders
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

  /** Inputs a crafter needs for today's crafting plan (units, before what it already holds). */
  private inputNeed(n: NpcState): Partial<Record<ItemId, number>> {
    const need: Partial<Record<ItemId, number>> = {};
    for (const [item, q] of Object.entries(this.craftPlan(n)) as [ItemId, number][]) {
      for (const [inp, per] of Object.entries(RECIPES[item] ?? {}) as [ItemId, number][]) {
        need[inp] = (need[inp] ?? 0) + per * q;
      }
    }
    return need;
  }

  /**
   * 7:00: the agents who struck a deal this morning meet at the buyer's workshop (see
   * `meetings`) and settle the first delivery on the spot, at the agreed price. The money
   * still moves through `hire`, so the spending guard, the NPC key and the contract apply.
   */
  private settleDeals() {
    for (const d of (this.s.deals ?? []).filter((x) => x.day === this.day && x.status === 'agreed' && x.used < x.maxQty)) {
      const buyer = this.s.npcs[d.buyer];
      const seller = this.s.npcs[d.seller];
      const missing = (this.inputNeed(buyer)[d.item] ?? 0) - buyer.stock[d.item];
      if (missing <= 0) continue;
      const qty = Math.min(missing, seller.stock[d.item] - this.reservedFor(d.seller, d.item), d.maxQty - d.used);
      if (qty > 0) this.hireUnderDeal(buyer, seller, d.item, qty, d, midPrice(d.item, this.s.market.stock[d.item]));
    }
  }

  /** 6:00-10:59: each seller with a deal today walks over to the buyer's workshop (they settle at 7:00). */
  meetings(): Map<NpcId, [number, number]> {
    const out = new Map<NpcId, [number, number]>();
    if (this.hour < 6 || this.hour > 10) return out;
    const spots: [number, number][] = [[1, 1], [-1, 1], [2, 0]];
    const used = new Map<NpcId, number>();
    for (const d of (this.s.deals ?? []).filter((x) => x.day === this.day)) {
      if (out.has(d.seller)) continue;
      const k = used.get(d.buyer) ?? 0;
      if (k >= spots.length) continue;
      used.set(d.buyer, k + 1);
      const [hx, hy] = HOME[d.buyer];
      out.set(d.seller, [hx + spots[k][0], hy + spots[k][1]]);
    }
    return out;
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
      const need = this.inputNeed(n);
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
    const deal = this.dealFor(buyer.id, sellerId, item);
    if (deal?.status === 'no-deal') return 0; // the agents could not agree today: market instead
    if (deal) return this.hireUnderDeal(buyer, seller, item, Math.min(avail, deal.maxQty - deal.used), deal, mid);
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

  // ---------------------------------------------------------------- world exchange rate
  /**
   * A real-market exchange rate for world prices (the server reads it from NEAR Intents).
   * The factor is clamped to 0.9-1.1 so an outside quote can nudge the world, never upend it.
   */
  setWorldFx(input: { factor: number; quote: string; source: string; at: string }): WorldFx {
    const factor = Math.round(clamp(Number.isFinite(input.factor) ? input.factor : 1, 0.9, 1.1) * 1000) / 1000;
    const w = this.s.world;
    const old = w.fx?.factor ?? 1;
    for (const i of ITEMS) if (w.price[i]) w.price[i] = Math.round((w.price[i]! / old) * factor);
    w.fx = { factor, quote: input.quote.slice(0, 80), source: input.source.slice(0, 120), at: input.at };
    if (Math.abs(factor - old) >= 0.001) {
      this.feed('world', `World money: ${w.fx.quote} via ${w.fx.source} · world goods ×${factor.toFixed(3)} in village gold`);
    }
    return w.fx;
  }

  // ---------------------------------------------------------------- agent deals
  /** Today's deal between two agents for an item, if they negotiated one. */
  dealFor(buyer: NpcId, seller: NpcId, item: ItemId): Deal | undefined {
    return (this.s.deals ?? []).filter((d) => d.day === this.day && d.buyer === buyer && d.seller === seller && d.item === item).at(-1);
  }

  /**
   * Records a negotiation between two agents (LLM or rules). The deal guard decides what
   * the engine may use: a price inside the band around the market, a capped quantity.
   * A deal never moves gold by itself; the buyer's `hire` later does, through the guard.
   */
  setDeal(input: { buyer: NpcId; seller: NpcId; item: ItemId; agreed: boolean; price?: number; maxQty?: number; by: string; rounds: DealRound[] }): Deal {
    const mid = midPrice(input.item, this.s.market.stock[input.item]);
    const v = checkDeal(input, mid);
    const deal: Deal = {
      id: this.s.nextId++, day: this.day, buyer: input.buyer, seller: input.seller, item: input.item,
      status: v.ok ? 'agreed' : 'no-deal', price: v.ok ? v.price : undefined, maxQty: v.ok ? v.maxQty : 0, used: 0,
      by: input.by, rounds: input.rounds.slice(0, DEAL_MAX_ROUNDS * 2 + 1).map((r) => ({ ...r, say: String(r.say ?? '').slice(0, 240) })),
      guard: v.ok ? v.notes : input.agreed ? [`refused: ${v.reason}`] : [],
    };
    const deals = (this.s.deals ??= []);
    deals.push(deal);
    if (deals.length > 40) deals.splice(0, deals.length - 40);
    const sellerWords = deal.rounds.filter((r) => r.who === input.seller).at(-1)?.say;
    if (sellerWords && !/^rules/.test(input.by)) this.feed('think', `${NPC_DEFS[input.seller].name} to ${NPC_DEFS[input.buyer].name}: "${sellerWords.slice(0, 140)}"`, input.seller);
    this.feed('deal', describeDeal(deal) + (deal.guard.length ? ` · deal guard: ${deal.guard.join('; ')}` : ''), input.buyer);
    const last = deal.rounds.filter((r) => r.who === input.buyer).at(-1)?.say ?? '';
    this.diary({
      npc: input.buyer,
      goal: `buy ${input.item} from ${NPC_DEFS[input.seller].name} for today`,
      saw: `market ${fmt(mid)} per ${input.item}, ${NPC_DEFS[input.seller].name} holds ${this.s.npcs[input.seller].stock[input.item]}`,
      think: last || '(no words)',
      act: deal.status === 'agreed' ? `deal: ${fmt(deal.price!)} per ${input.item}, up to ${deal.maxQty}` : 'no deal: buy at the market',
      guard: deal.guard.length ? `deal guard: ${deal.guard.join('; ')}` : `deal guard: price within ${DEAL_BAND.min * 100}–${DEAL_BAND.max * 100}% of market · deals never move gold`,
    });
    return deal;
  }

  private hireUnderDeal(buyer: NpcState, seller: NpcState, item: ItemId, qty: number, deal: Deal, mid: Gold): number {
    if (qty <= 0) return 0;
    const price = deal.price!;
    const total = price * qty;
    const f = fee(total);
    if (total + f > buyer.gold) return 0;
    const action: Action = { type: 'hire', seller: seller.id, item, qty, price };
    const spentBefore = buyer.spentToday;
    if (!this.guarded(buyer, action)) {
      this.feed('blocked', `${NPC_DEFS[buyer.id].name}'s deal blocked: over daily budget`, buyer.id);
      return 0;
    }
    buyer.gold -= total + f;
    buyer.spentToday += total + f;
    seller.gold += total;
    seller.stock[item] -= qty;
    buyer.stock[item] += qty;
    deal.used += qty;
    this.takeFee(f);
    this.s.ledger.volume += total;
    const tx = this.tx(NPC_DEFS[buyer.id].account, 'hire', { seller: NPC_DEFS[seller.id].account, item, qty, price });
    this.feed('deal', `${NPC_DEFS[seller.id].name} delivers ${qty} ${item} at the agreed ${fmt(price)} · tx ${short(tx)}`, seller.id, tx);
    this.diary({
      npc: buyer.id,
      goal: `get ${item} for today's work`,
      saw: `market ${fmt(mid)}, deal with ${NPC_DEFS[seller.id].name} at ${fmt(price)} (${deal.by})`,
      think: deal.rounds.filter((r) => r.who === buyer.id).at(-1)?.say || 'use the agreed price',
      act: `hire(${seller.id}, ${qty} ${item}, ${fmt(total)} gold)`,
      tx,
      guard: `spent ${fmt(spentBefore + total + f, 0)}/${fmt(NPC_DEFS[buyer.id].dailyBudget, 0)} today · method allowed`,
    });
    seller.memory = [`${NPC_DEFS[buyer.id].name} paid the agreed ${fmt(price)} per ${item} on day ${this.day}`, ...seller.memory].slice(0, 5);
    return qty;
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
      const left = o.qty - o.filled;
      const k = Math.min(left, n.stock[o.item]);
      const bid = bidPrice(o.item, this.s.market.stock[o.item]);
      const want = Math.max(Math.round(bid * 1.02), midPrice(o.item, this.s.market.stock[o.item]), Math.round(this.unitInputCost(o.item) * 1.08));
      // swarm: for raw goods Bruno bids too, importing from the world market; the cheaper ask wins
      const bruno = this.brunoAsk(o.item, left);
      const local = k > 0 && want <= o.maxPrice;
      if (bruno && bruno.ask <= o.maxPrice && (!local || bruno.ask < want)) {
        const human = this.isHuman(o.by);
        if (human) {
          this.feed('order', `Auction for ${this.ownerName(o.by)}'s ${left} ${o.item}: ${NPC_DEFS[sellerId].name} asks ${k > 0 ? fmt(want) : '(out of stock)'}, Bruno asks ${fmt(bruno.ask)} landed from the world · Bruno wins`, 'bruno');
        }
        if (this.brunoImportFor(o, left, bruno.landed, bruno.ask)) continue;
      } else if (local && bruno && bruno.ask <= o.maxPrice && this.isHuman(o.by)) {
        this.feed('order', `Auction for ${this.ownerName(o.by)}'s ${left} ${o.item}: ${NPC_DEFS[sellerId].name} asks ${fmt(want)}, Bruno asks ${fmt(bruno.ask)} · ${NPC_DEFS[sellerId].name} wins`, sellerId);
      }
      if (local) this.fillOne(o, sellerId, k, want);
    }
  }

  private isHuman(by: Order['by']) {
    return by.kind === 'player' ? !this.s.players[by.id]?.bot : !this.s.guilds[by.id]?.ai;
  }

  /** Bruno's ask for raw goods he would import for an order: landed world price plus 5%. */
  private brunoAsk(item: ItemId, qty: number): { ask: Gold; landed: Gold } | null {
    const world = this.s.world.price[item];
    if (!ITEM_DEFS[item].world || !world || this.producerOf(item) === 'bruno' || RECIPES[item]) return null;
    const landed = Math.round(world * (1 + this.s.world.shippingBps / 10_000));
    const b = this.s.npcs.bruno;
    const cost = landed * qty;
    if (b.gold < cost + g(20) || b.spentToday + cost > NPC_DEFS.bruno.dailyBudget) return null;
    return { ask: Math.round(landed * 1.05), landed };
  }

  /** Bruno won the auction: import the goods (gold burned at the landed price), then fill the order. */
  private brunoImportFor(o: Order, qty: number, landed: Gold, ask: Gold): boolean {
    const b = this.s.npcs.bruno;
    const cost = landed * qty;
    b.gold -= cost;
    b.spentToday += cost;
    this.s.ledger.sinks.imports += cost;
    b.stock[o.item] += qty;
    const imp = this.tx(NPC_DEFS.bruno.account, 'world_import', { item: o.item, qty });
    this.feed('import', `Bruno imports ${qty} ${o.item} for ${this.ownerName(o.by)}'s order · tx ${short(imp)}`, 'bruno', imp);
    return !!this.fillOne(o, 'bruno', qty, ask, 'auction');
  }

  /** One NPC fills (part of) an order at a price; escrow pays the seller, the buyer gets the goods. */
  private fillOne(o: Order, sellerId: NpcId, k: number, price: Gold, how = ''): string | null {
    const n = this.s.npcs[sellerId];
    const pay = price * k;
    const f = fee(pay);
    if (pay + f > o.escrow || n.stock[o.item] < k || k <= 0) return null;
    o.escrow -= pay + f;
    n.gold += pay;
    n.stock[o.item] -= k;
    o.filled += k;
    o.seller = sellerId;
    this.takeFee(f);
    this.s.ledger.volume += pay;
    this.deliver(o.by, o.item, k, price);
    if (o.by.kind === 'player') noteTrade(this, sellerId, o.by.id, pay);
    const tx = this.tx(NPC_DEFS[sellerId].account, 'fill_order', { order_id: o.id, qty: k, price });
    const who = this.ownerName(o.by);
    this.feed('order', `${NPC_DEFS[sellerId].name} delivered ${k} ${o.item} to ${who} at ${how ? `the ${how} ` : ''}${fmt(price)} · tx ${short(tx)}`, sellerId, tx);
    if (o.filled >= o.qty) {
      o.status = 'filled';
      this.refundEscrow(o);
    }
    return tx;
  }

  /**
   * A player and an NPC agreed a price by haggling (the NPC's brain proposed it). The sale
   * goes through the normal rails: the player's order locks the gold in escrow, then the NPC
   * fills it with its own key at the agreed price. Only the producer of an item sells it, from
   * what it holds, at a price inside the deal band around the market.
   */
  sellToPlayer(npc: NpcId, playerId: string, item: ItemId, qty: number, price: Gold): ActionResult & { placeTx?: string } {
    if (this.producerOf(item) !== npc) return { ok: false, reason: `${NPC_DEFS[npc].name} does not sell ${item}` };
    if (!Number.isInteger(qty) || qty < 1 || qty > DEAL_MAX_QTY) return { ok: false, reason: `quantity must be 1-${DEAL_MAX_QTY}` };
    if (this.s.npcs[npc].stock[item] < qty) return { ok: false, reason: `${NPC_DEFS[npc].name} has only ${this.s.npcs[npc].stock[item]} ${item}` };
    const mid = midPrice(item, this.s.market.stock[item]);
    const p = Math.round(price);
    if (!(p >= Math.ceil(mid * DEAL_BAND.min) && p <= Math.floor(mid * DEAL_BAND.max))) {
      return { ok: false, reason: `price ${fmt(p)} is outside the deal band around the market (${fmt(mid)})` };
    }
    const placed = this.act({ kind: 'player', id: playerId }, { type: 'place_order', item, qty, maxPrice: p, deadlineDays: 1 });
    if (!placed.ok) return placed;
    const o = this.s.orders.filter((x) => x.by.kind === 'player' && x.by.id === playerId && x.status === 'open').at(-1)!;
    const tx = this.fillOne(o, npc, qty, p, 'haggled');
    if (!tx) return { ok: false, reason: 'the sale did not go through', placeTx: placed.tx };
    this.s.npcs[npc].memory = [`sold ${qty} ${item} to ${this.s.players[playerId]?.name ?? 'a player'} at ${fmt(p)} after haggling`, ...this.s.npcs[npc].memory].slice(0, 5);
    return { ok: true, tx, placeTx: placed.tx, info: `${qty} ${item} at ${fmt(p)}` };
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
    this.unstick();
  }

  /**
   * A crafter that is nearly broke and holds inputs it cannot use (ore but no timber) would
   * wait forever: no gold to buy the missing input, no product to sell. It sells the loose
   * inputs back to the market to get working capital again.
   */
  private unstick() {
    for (const id of NPCS) {
      const n = this.s.npcs[id];
      const recipes = NPC_DEFS[id].produces.map((i) => RECIPES[i]).filter((r): r is Partial<Record<ItemId, number>> => !!r);
      if (!recipes.length || n.gold >= g(15)) continue;
      const canCraft = recipes.some((r) => (Object.entries(r) as [ItemId, number][]).every(([i, q]) => n.stock[i] >= q));
      if (canCraft) continue;
      const inputs = new Set(recipes.flatMap((r) => Object.keys(r) as ItemId[]));
      for (const i of inputs) {
        if (n.stock[i] > 0) {
          const sold = this.npcSell(n, i, n.stock[i]);
          if (sold > 0) this.feed('trade', `${NPC_DEFS[id].name} is short of gold and sells ${sold} spare ${i} back to the market`, id);
        }
      }
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
      // import (unless the council protects this item)
      let imported = 0;
      const noImport = item === 'ore' && councilInForce(this, 'no_ore_import');
      while (!noImport && imported < RULES.brunoDailyCap) {
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
      const noExport = item === 'wheat' && councilInForce(this, 'no_wheat_export');
      while (!noExport && exported < RULES.brunoDailyCap && this.s.market.stock[item] > 1) {
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

  /**
   * An NPC with no gold and nothing to sell cannot buy inputs or bread, so it would stop for
   * good. The market treasury lends it a little working capital (gold moves, none is created)
   * and takes it back once the NPC has more than 100 gold.
   */
  private workingCapital(n: NpcState) {
    const loan = n.loan ?? 0;
    if (loan > 0 && n.gold > RULES.loanRepayAbove) {
      const back = Math.min(loan, n.gold - RULES.loanRepayAbove);
      n.gold -= back;
      this.s.market.treasury += back;
      n.loan = loan - back;
      if (!n.loan) this.feed('trade', `${NPC_DEFS[n.id].name} repaid the market's loan`, n.id);
      return;
    }
    const sellable = ITEMS.some((i) => n.stock[i] > 0 && i !== 'bread');
    if (n.gold < g(5) && !sellable && loan < g(90) && this.s.market.treasury > g(300)) {
      n.gold += RULES.loanAmount;
      this.s.market.treasury -= RULES.loanAmount;
      n.loan = loan + RULES.loanAmount;
      this.feed('trade', `${NPC_DEFS[n.id].name} is broke; the market lends ${fmt(RULES.loanAmount, 0)} gold of working capital`, n.id);
    }
  }

  /** Travelling adventurers buy swords: outside gold entering the village. */
  private adventurers() {
    const n = this.rng.int(...RULES.adventurerDemand);
    // they sleep at Bruno's inn: outside gold for the merchant, whose world trade alone
    // does not cover his bread and upkeep in a calm, well-supplied village
    if (n > 0 && RULES.innLodging > 0) {
      const pay = n * RULES.innLodging;
      this.s.npcs.bruno.gold += pay;
      this.s.npcs.bruno.inflowToday += pay;
      this.s.ledger.faucets.adventurers += pay;
    }
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
    if (n > 0) this.feed('trade', `${n} travelling adventurer${n > 1 ? 's' : ''} stayed at Bruno's inn${bought > 0 ? ` and bought ${bought} sword${bought > 1 ? 's' : ''}` : ''}`, 'bruno');
  }

  private closeDay() {
    for (const id of NPCS) {
      const n = this.s.npcs[id];
      this.workingCapital(n);
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
      // the NPC keeps working capital; a shortfall is the investor's loss
      const back = Math.min(inv.principal, Math.max(0, n.gold - RULES.investKeepGold));
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
    if (!bot) p.goal = { startDay: this.day, startWorth: p.gold, ...(this.s.players[RIVAL.id] ? { rivalStart: rivalWorth(this) } : {}) };
    this.s.players[id] = p;
    this.s.ledger.faucets.signup += p.gold;
    return p;
  }

  /** The rival plays as a player (same rules, same actions), without quests or a goal of its own. */
  private addRival() {
    const p = this.addPlayer(RIVAL.id, RIVAL.name, true);
    p.rival = true;
    for (const q of QUESTS) p.quests[q.id] = true;
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

  /** A badge earned outside the engine's own rules (the red team). Once per title. */
  awardBadge(playerId: string, b: { kind: string; title: string; description: string }): boolean {
    const p = this.s.players[playerId];
    if (!p || p.bot || p.badges?.some((x) => x.title === b.title)) return false;
    this.award(p, b);
    return true;
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
    for (const r of s.requests ?? []) if (r.tx === placeholder) r.tx = hash;
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
      case 'list_item': {
        // goods go into escrow at a fixed price; an NPC or another player buys the whole listing
        if (!ITEMS.includes(a.item)) return { ok: false, reason: 'unknown item' };
        if (!Number.isInteger(a.price)) return { ok: false, reason: 'price in whole centigold' };
        if (!Number.isInteger(a.qty) || a.qty < 1 || a.qty > RULES.listingMaxQty) return { ok: false, reason: `list 1-${RULES.listingMaxQty} units` };
        const mid = midPrice(a.item, this.s.market.stock[a.item]);
        if (!(a.price >= Math.ceil(mid * 0.5) && a.price <= mid * 2)) return { ok: false, reason: `price must be 50-200% of the market (${fmt(mid, 2)})` };
        if (p.stock[a.item] < a.qty) return { ok: false, reason: `you have ${p.stock[a.item]} ${a.item}` };
        const mine = (this.s.listings ?? []).filter((l) => l.seller === p.id && l.status === 'open').length;
        if (mine >= RULES.listingsPerPlayer) return { ok: false, reason: `at most ${RULES.listingsPerPlayer} open listings` };
        const l = this.newListing(p.id, a.item, a.qty, a.price);
        return { ok: true, tx: l.tx, info: `listed: ${a.qty} ${a.item} at ${fmt(a.price, 2)}` };
      }
      case 'buy_listing': {
        const l = (this.s.listings ?? []).find((x) => x.id === a.id);
        if (!l || l.status !== 'open') return { ok: false, reason: 'that listing is gone' };
        if (l.seller === p.id) return { ok: false, reason: 'you cannot buy your own listing' };
        const total = l.price * l.qty;
        if (p.gold < total) return { ok: false, reason: `you need ${fmt(total)} gold` };
        p.gold -= total;
        const tx = this.tx(signer, 'buy_listing', { listing_id: l.id, amount: total });
        this.sellListing(l, { kind: 'player', id: p.id }, tx);
        p.stock[l.item] += l.qty;
        return { ok: true, tx, info: `bought ${l.qty} ${l.item} for ${fmt(total)}` };
      }
      case 'cancel_listing': {
        const l = (this.s.listings ?? []).find((x) => x.id === a.id);
        if (!l || l.status !== 'open') return { ok: false, reason: 'that listing is not open' };
        if (l.seller !== p.id) return { ok: false, reason: 'not your listing' };
        return { ok: true, tx: this.cancelListing(l, 'cancelled') };
      }
      case 'hire_keeper': {
        if (!NPCS.includes(a.npc) || a.npc === 'bruno') return { ok: false, reason: 'Bruno buys from the board; hire another NPC' };
        if (!ITEMS.includes(a.item)) return { ok: false, reason: 'unknown item' };
        if (!(['hold', 'quick', 'wait'] as KeeperStrategy[]).includes(a.strategy)) return { ok: false, reason: 'strategy: hold, quick or wait' };
        if (!Number.isInteger(a.qty) || a.qty < 1 || a.qty > RULES.listingMaxQty) return { ok: false, reason: `1-${RULES.listingMaxQty} units` };
        if (p.stock[a.item] < a.qty) return { ok: false, reason: `you have ${p.stock[a.item]} ${a.item}` };
        if ((this.s.keepers ?? []).some((k) => k.player === p.id && k.status === 'working')) return { ok: false, reason: 'you already have a stall keeper working' };
        const mine = this.openListings().filter((l) => l.seller === p.id).length;
        if (mine >= RULES.listingsPerPlayer) return { ok: false, reason: `at most ${RULES.listingsPerPlayer} open listings` };
        const job: KeeperJob = {
          id: this.s.nextId++, player: p.id, npc: a.npc, item: a.item, left: a.qty, strategy: a.strategy, startDay: this.day,
          status: 'working', sold: 0, earned: 0, commission: 0, reports: [],
        };
        (this.s.keepers ??= []).push(job);
        const { price, why } = this.keeperPrice(job);
        job.listingId = this.newListing(p.id, a.item, a.qty, price, job).id;
        job.todayWhy = `listed at ${fmt(price, 2)}: ${why}`;
        const name = NPC_DEFS[a.npc].name;
        job.reports.push({ day: this.day, text: `${name}: I'll keep your stall for ${RULES.keeperDays} days, ${a.strategy === 'quick' ? 'selling fast' : a.strategy === 'wait' ? 'waiting for a better price when the world says it is rising' : 'at the market price'}. ${RULES.keeperCommissionBps / 100}% of each sale is mine. Listed at ${fmt(price, 2)}: ${why}.` });
        noteTrade(this, a.npc, p.id, 0);
        return { ok: true, info: `${name} keeps your stall: ${a.qty} ${a.item} at ${fmt(price, 2)}` };
      }
      case 'dismiss_keeper': {
        const job = (this.s.keepers ?? []).find((k) => k.id === a.id && k.player === p.id && k.status === 'working');
        if (!job) return { ok: false, reason: 'no stall keeper working for you' };
        this.endKeeper(job, 'you sent them home');
        return { ok: true, info: 'Stall keeper dismissed, goods back' };
      }
      case 'council_vote': {
        const m = (this.s.council ?? []).find((x) => x.id === a.id);
        if (!m || m.status !== 'open') return { ok: false, reason: 'the council is not voting on that now' };
        if (p.bot && !p.rival) return { ok: false, reason: 'players only' };
        const prev = m.votes.find((x) => x.kind === 'player' && x.who === p.id);
        if (prev) { prev.vote = a.yes ? 'yes' : 'no'; prev.why = 'changed their vote'; }
        else m.votes.push({ who: p.id, kind: 'player', name: p.name, vote: a.yes ? 'yes' : 'no', why: '' });
        const t = tally(m);
        return { ok: true, info: `You vote ${a.yes ? 'yes' : 'no'} · now ${t.yes} yes, ${t.no} no · counted at 20:00` };
      }
      case 'coop_give': {
        const c = (this.s.coops ?? []).find((x) => x.id === a.id);
        if (!c || c.status !== 'open') return { ok: false, reason: 'that caravan is not open' };
        if (!Number.isInteger(a.qty) || a.qty < 1) return { ok: false, reason: 'give at least 1' };
        const qty = Math.min(a.qty, this.coopLeft(c));
        if (p.stock[c.item] < qty) return { ok: false, reason: `you have ${p.stock[c.item]} ${c.item}` };
        const b = this.s.npcs.bruno;
        const pay = c.price * qty;
        if (b.gold < pay + g(5)) return { ok: false, reason: 'Bruno is short of gold right now' };
        p.stock[c.item] -= qty;
        p.gold += pay;
        // on chain: a delivery to Bruno at the caravan price (the bonus stays in the game and is reconciled)
        const tx = this.tx(signer, 'deliver_request', { request_id: c.id, npc: NPC_DEFS.bruno.account, item: c.item, qty, price: c.price, bonus: 0 });
        this.coopTake(c, { kind: 'player', id: p.id }, qty, tx);
        return { ok: true, tx, info: `+${fmt(pay)} gold for ${qty} ${c.item}${(c.status as string) === 'filled' ? ' · caravan full, bonus paid' : ''}` };
      }
      case 'start_goal': {
        const best = Math.max(p.goal?.best ?? 0, p.goal?.result?.stars ?? 0);
        p.goal = { startDay: this.day, startWorth: netWorth(this, p.id), ...(best ? { best } : {}), ...(this.s.players[RIVAL.id] ? { rivalStart: rivalWorth(this) } : {}) };
        return { ok: true, info: `New week: grow your purse to ${fmt(goalTargets(p.goal)[2], 0)} gold by day ${this.day + GOAL.days - 1}` };
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
      case 'accept_request': {
        if (p.bot && !p.rival) return { ok: false, reason: 'only players take big orders' };
        const r = (this.s.requests ?? []).find((x) => x.id === a.requestId);
        if (!r || r.due === undefined || r.by || r.missed || this.day > r.due) return { ok: false, reason: 'that order is not open' };
        if (r.takenBy) return { ok: false, reason: r.takenBy === p.id ? 'you already took it' : `${this.s.players[r.takenBy]?.name ?? 'someone'} took it first` };
        r.takenBy = p.id;
        const left = r.due - this.day;
        this.feed('quest', `${p.name} promised ${NPC_DEFS[r.npc].name} ${r.qty} ${r.item} ${left ? `within ${left + 1} days` : 'by tonight'}`, r.npc);
        return { ok: true, info: `${NPC_DEFS[r.npc].name} counts on you: ${r.qty} ${r.item} ${left ? `in ${left + 1} days` : 'by tonight'}. Late = they remember.` };
      }
      case 'deliver_request': {
        if (actor.kind !== 'player' || (p.bot && !p.rival)) return { ok: false, reason: 'only players deliver requests' };
        const r = (this.s.requests ?? []).find((x) => x.id === a.requestId);
        if (!r || r.missed || (r.due !== undefined ? this.day > r.due : r.day !== this.day)) return { ok: false, reason: 'that request has expired' };
        if (r.by) return { ok: false, reason: `${this.s.players[r.by]?.name ?? 'someone'} already delivered it` };
        if (r.due !== undefined && r.takenBy !== p.id) return { ok: false, reason: r.takenBy ? `${this.s.players[r.takenBy]?.name ?? 'someone'} took this order` : 'accept the big order first' };
        if (p.stock[r.item] < r.qty) return { ok: false, reason: `you need ${r.qty} ${r.item} (you have ${p.stock[r.item]})` };
        const n = this.s.npcs[r.npc];
        const pay = r.price * r.qty;
        if (n.gold < pay) return { ok: false, reason: `${NPC_DEFS[r.npc].name} cannot pay right now` };
        if (n.spentToday + pay > NPC_DEFS[r.npc].dailyBudget) return { ok: false, reason: `${NPC_DEFS[r.npc].name} is over the daily budget` };
        p.stock[r.item] -= r.qty;
        n.stock[r.item] += r.qty;
        n.gold -= pay;
        n.spentToday += pay;
        p.gold += pay + r.bonus;
        this.s.ledger.faucets.quests += r.bonus;
        r.by = p.id;
        noteDelivery(this, r.npc, p.id);
        if (r.due !== undefined) notePromise(this, r.npc, p.id, true);
        const tx = this.tx(signer, 'deliver_request', {
          request_id: r.id, npc: NPC_DEFS[r.npc].account, item: r.item, qty: r.qty, price: r.price, bonus: r.bonus,
        });
        r.tx = tx;
        this.feed('quest', `${p.name} brought ${NPC_DEFS[r.npc].name} ${r.qty} ${r.item} · +${fmt(pay + r.bonus)} gold · tx ${short(tx)}`, r.npc, tx);
        const title = `Friend of ${NPC_DEFS[r.npc].name}`;
        if (!p.badges?.some((b) => b.title === title)) {
          this.award(p, { kind: 'request', title, description: `Brought ${NPC_DEFS[r.npc].name} the ${r.item} they asked for in Hearthmarket` });
        }
        return { ok: true, tx, info: `delivered ${r.qty} ${r.item} for ${fmt(pay)} + ${fmt(r.bonus, 0)} bonus` };
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
    // the agent's own reasoning, in the feed and as a thought bubble on the map
    this.feed('think', `${NPC_DEFS[id].name} thinks (${by.replace(/ \(.*$/, '')}): "${(plan.why || 'routine day').slice(0, 140)}" → ${describePlan(plan)}`, id);
    this.diary({
      npc: id,
      goal: `plan day ${this.day}`,
      saw: saw || `village and world prices at ${String(this.hour).padStart(2, '0')}:00`,
      think: plan.why || '(no reason given)',
      act: `plan: ${describePlan(plan)}`,
      guard: notes.length ? `plan guard: ${notes.join('; ')}` : 'plan guard: all dials in range · plans never move gold',
      by,
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
  /** NPCs stay home, sellers visit their buyers in the morning, everyone walks to the plaza for the afternoon market. The client animates the walk. */
  private wander() {
    const atMarket = this.hour >= 14 && this.hour <= 17;
    const meet = this.meetings();
    for (const id of NPCS) {
      const n = this.s.npcs[id];
      const [x, y] = meet.get(id) ?? (atMarket ? MARKET_SPOT[id] : HOME[id]);
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

/**
 * Where a transaction stands, in five honest states:
 * - simulated: the guest village (or a server without chain); nothing was sent
 * - queued: signed or waiting to be signed; no hash yet
 * - finalized: executed on NEAR testnet (final within about 2 s), with a hash to check
 * - failed: refused by the contract or the RPC (a red-team call on purpose, or drift)
 * - reconciled: kept in the game (nobody online, gas budget, chain behind); the operator's
 *   daily `reconcile` writes the resulting balances to the chain
 */
export type TxState = 'simulated' | 'queued' | 'finalized' | 'failed' | 'reconciled';
export function txState(tx: string): TxState {
  switch (txKind(tx)) {
    case 'pending': return 'queued';
    case 'failed': return 'failed';
    case 'local': return 'reconciled';
    case 'sim': return 'simulated';
    default: return 'finalized';
  }
}
export const TX_STATE_HINT: Record<TxState, string> = {
  simulated: 'simulated: guest village, nothing sent',
  queued: 'queued: on its way to NEAR',
  finalized: 'on NEAR testnet: executed, final within about 2 s',
  failed: 'failed: refused on chain',
  reconciled: 'kept in the game; the daily reconcile writes the balances to the chain',
};

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
