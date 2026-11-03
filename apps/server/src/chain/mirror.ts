import {
  ITEMS, ITEM_DEFS, NPCS, NPC_DEFS, NPC_KEY_METHODS, OPERATOR_METHODS, PLAYER_SIGNER_SUFFIX, RULES,
  type Village,
} from '@hearth/economy';
import type { ChainAdapter } from './signer.ts';

/**
 * Mirrors the village onto the `hearth` contract.
 *
 * The engine decides first (it has to: eating, upkeep, stalls and guilds are not on chain
 * yet), then every NPC action it accepted is sent to the contract, signed by that NPC's
 * own function-call key, where the daily budget, recipes, order escrow and "NPCs never
 * transfer gold" are checked again. Players without a wallet are relayed by the operator
 * key. Once a game day the operator starts the chain's day with `reconcile` (the drift is
 * logged as events) and posts the world data.
 *
 * One queue per signing key, so a key never has two transactions in flight (nonces).
 */
export interface MirrorOptions {
  contract: string;
  /** operator (oracle) account, normally the contract account; empty = no relays, no reconcile */
  operator: string;
  /** NEAR account of a human player, or null to keep that player off chain */
  playerAccount: (playerId: string) => string | null;
  /** at most this many queued calls per key; more are kept off chain */
  maxQueue?: number;
  /** global cap on calls per minute across all keys */
  maxPerMinute?: number;
  /** minimum real time between two reconcile calls */
  minDayMs?: number;
  /**
   * Gas budget. Each NPC sends at most this many calls per real hour (0 = no cap). Order
   * fills and player relays are never capped: they move escrow. Skipped NPC actions stay
   * in the engine and the next `reconcile` re-anchors the chain.
   */
  npcCallsPerHour?: number;
  /** collect each NPC's production over a game day and send it as one `produce` per item */
  batchProduce?: boolean;
  /** a slow or offline chain must not stall the village */
  log?: (line: string) => void;
  now?: () => number;
}

export interface ChainEvent {
  at: number;
  signer: string;
  method: string;
  ok: boolean;
  hash?: string;
  reason?: string;
  redTeam?: boolean;
}

const RECENT_CAP = 60;

export interface WorldPostInput {
  source: string;
  raw: string;
  sha256: string;
}

interface Call {
  signer: string;
  method: string;
  args: Record<string, unknown>;
  tgas: number;
  onOk?: () => void;
  onFail?: () => void;
}

const RAW = new Set(['ore', 'timber', 'wheat']);
/** NPC methods that spend goods or gold the chain may not have after a skipped call */
const SPENDS_GOODS = new Set(['craft', 'market_sell', 'fill_order', 'world_trade', 'world_import']);

const PROOF_METHODS = new Set(['relay_register_player', 'relay_market_buy', 'relay_market_sell', 'relay_place_order', 'relay_cancel_order', 'relay_deliver_request', 'mint_badge']);

const TGAS: Record<string, number> = { reconcile: 150, post_world_data: 30, relay_place_order: 30 };
const DEFAULT_TGAS = 20;

export class ChainMirror {
  /** last call per signer; each new call waits for it */
  private queues = new Map<string, { tail: Promise<unknown>; size: number }>();
  private recent: number[] = [];
  private pendingN = 0;
  private lastDayAt = -Infinity;
  /** engine order id -> on-chain order id, set once the relay landed */
  private orders = new Map<number, number>();
  /** engine order id -> the operator queue tail that lands its relay (until it has landed) */
  private orderLanding = new Map<number, Promise<unknown>>();
  /** players whose registration landed / is queued */
  private registered = new Set<string>();
  private registrationQueued = new Set<string>();
  /** order ids are unique per server run */
  private readonly orderBase: number;
  /** NPC call times in the last hour, per signer (gas budget) */
  private npcRecent = new Map<string, number[]>();
  /** production collected this game day: signer -> item -> qty, and the feed placeholders it covers */
  private produceBatch = new Map<string, Map<string, { qty: number; placeholders: string[] }>>();
  /** batch placeholder -> member placeholders that settle with it */
  private aliases = new Map<string, string[]>();
  /** false while nobody is playing: NPC actions stay in the engine, no gas is spent */
  private active = true;
  readonly stats = { sent: 0, ok: 0, failed: 0, skipped: 0, budgeted: 0, batched: 0, paused: 0, unsynced: 0 };
  /** landed calls per method since the server started */
  readonly byMethod: Record<string, { ok: number; failed: number }> = {};
  /** relays, badges and red-team refusals, newest last (dashboard "proof" list) */
  readonly proofs: ChainEvent[] = [];
  /** the last calls that reached the chain, newest last (dashboard) */
  readonly events: ChainEvent[] = [];
  /** called with (placeholder, final hash or `failed:...`) */
  onSettled: (placeholder: string, hash: string) => void = () => {};

  constructor(private chain: ChainAdapter, private opts: MirrorOptions) {
    const now = (opts.now ?? Date.now)();
    this.orderBase = 1e12 + (Math.floor(now / 1000) % 1e6) * 1e6;
  }

  private get log() {
    return this.opts.log ?? (() => {});
  }

  chainOrderId(engineId: number) {
    return this.orderBase + engineId;
  }

  // ------------------------------------------------------------------ engine hook
  /** `Village.chainHook`: returns a placeholder hash, or null to keep the action off chain. */
  readonly hook = (signer: string, method: string, args: Record<string, unknown>): string | null => {
    const npc = NPCS.some((id) => NPC_DEFS[id].account === signer);
    if (npc && !this.active) {
      this.stats.paused++;
      return null;
    }
    const calls = this.translate(signer, method, args);
    if (!calls) return null;
    if (npc && method === 'produce' && this.opts.batchProduce) return this.collect(calls[0]);
    // an NPC whose earlier call did not reach the chain holds different goods there than in the
    // game: anything that spends goods would fail, so wait for the next reconcile instead
    if (npc && this.outOfSync(signer, method, args)) {
      this.stats.unsynced++;
      return null;
    }
    if (npc && method !== 'fill_order' && method !== 'world_import' && !this.withinBudget(signer)) {
      this.stats.budgeted++;
      this.markDrift(signer);
      return null;
    }
    // goods produced earlier today must be on chain before the NPC sells or hands them over:
    // send this NPC's batch (and the seller's, for a hire) first, and wait for it
    const deps = npc && this.opts.batchProduce
      ? this.flushProduce([signer, ...(method === 'hire' && args.seller ? [String(args.seller)] : [])])
      : [];
    const landing = npc && method === 'fill_order' ? this.orderLanding.get(Number(args.order_id)) : undefined;
    if (landing) deps.push(landing);
    const ph = this.enqueue(calls, false, deps);
    // remember when a player's order relay will have landed, for an NPC fill that follows at once
    if (ph && !npc && method === 'place_order' && this.opts.operator) {
      const tail = this.queues.get(this.opts.operator)?.tail;
      if (tail) {
        const engineId = Number(args.order_id);
        this.orderLanding.set(engineId, tail);
        void tail.finally(() => this.orderLanding.delete(engineId));
      }
    }
    return ph;
  };

  /** NPC accounts whose chain state no longer matches the game, until the next reconcile. */
  private drift = new Map<string, number>();
  private driftN = 0;
  private markDrift(signer: string) {
    this.drift.set(signer, ++this.driftN);
  }

  private isNpc(signer: string) {
    return NPCS.some((id) => NPC_DEFS[id].account === signer);
  }

  /** Calls that spend goods (or rely on a seller's goods) are held back for a drifted NPC. */
  private outOfSync(signer: string, method: string, args: Record<string, unknown>): boolean {
    if (!this.drift.size) return false;
    if (method === 'hire') return this.drift.has(signer) || this.drift.has(String(args.seller));
    return this.drift.has(signer) && SPENDS_GOODS.has(method);
  }

  // ------------------------------------------------------------------ gas budget
  /** Pause NPC mirroring while nobody is connected; resuming re-anchors the chain at the next day start. */
  setActive(active: boolean) {
    if (active && !this.active) {
      this.lastDayAt = -Infinity;
      for (const id of NPCS) this.markDrift(NPC_DEFS[id].account);
    }
    this.active = active;
  }

  get isActive() {
    return this.active;
  }

  private withinBudget(signer: string): boolean {
    const cap = this.opts.npcCallsPerHour ?? 0;
    if (!cap) return true;
    const now = (this.opts.now ?? Date.now)();
    const times = (this.npcRecent.get(signer) ?? []).filter((t) => now - t < 3_600_000);
    if (times.length >= cap) {
      this.npcRecent.set(signer, times);
      return false;
    }
    times.push(now);
    this.npcRecent.set(signer, times);
    return true;
  }

  private collect(c: Call): string {
    const item = String(c.args.item);
    const bySigner = this.produceBatch.get(c.signer) ?? new Map();
    const entry = bySigner.get(item) ?? { qty: 0, placeholders: [] };
    const ph = `pendingb${(this.pendingN++).toString().padStart(6, '0')}x`;
    entry.qty += Number(c.args.qty);
    entry.placeholders.push(ph);
    bySigner.set(item, entry);
    this.produceBatch.set(c.signer, bySigner);
    this.stats.batched++;
    return ph;
  }

  /**
   * Sends the production collected so far: one `produce` per NPC and item (capped at the
   * contract's 12 per call). All NPCs, or only `signers`. Returns the queue tails of the
   * NPCs that had something to send, for calls that must wait for those goods.
   */
  flushProduce(signers?: string[]): Promise<unknown>[] {
    const waits: Promise<unknown>[] = [];
    for (const [signer, items] of [...this.produceBatch]) {
      if (signers && !signers.includes(signer)) continue;
      for (const [item, { qty, placeholders }] of items) {
        const ph = this.enqueue([{ signer, method: 'produce', args: { item, qty: Math.min(qty, 12) }, tgas: DEFAULT_TGAS }], true);
        if (ph) this.aliases.set(ph, placeholders);
        else for (const p of placeholders) this.onSettled(p, 'local-not-sent');
      }
      this.produceBatch.delete(signer);
      const q = this.queues.get(signer);
      if (q) waits.push(q.tail);
    }
    return waits;
  }

  private record(e: Omit<ChainEvent, 'at'>) {
    const m = (this.byMethod[e.method] ??= { ok: 0, failed: 0 });
    if (e.ok) m.ok++;
    else m.failed++;
    const ev = { at: (this.opts.now ?? Date.now)(), ...e };
    this.events.push(ev);
    if (this.events.length > RECENT_CAP) this.events.splice(0, this.events.length - RECENT_CAP);
    // player-facing proof (relays, badges, red-team refusals) is kept apart so routine NPC calls do not push it out
    if (e.hash && (e.redTeam || PROOF_METHODS.has(e.method))) {
      this.proofs.push(ev);
      if (this.proofs.length > 40) this.proofs.splice(0, this.proofs.length - 40);
    }
  }

  private settle(placeholder: string, hash: string) {
    this.onSettled(placeholder, hash);
    for (const p of this.aliases.get(placeholder) ?? []) this.onSettled(p, hash);
    this.aliases.delete(placeholder);
  }

  // ------------------------------------------------------------------ red team
  /**
   * Sends an attack straight to the contract with the NPC's own key, skipping the engine,
   * to show the contract refusing it on chain. The key's method list still applies: a
   * method that is not on the key is never signed. Resolves with the tx hash (a refused
   * call is still a transaction on chain) and the contract's reason.
   */
  async prove(signer: string, method: string, args: Record<string, unknown>): Promise<{ ok: boolean; hash?: string; reason: string }> {
    const npc = NPCS.find((id) => NPC_DEFS[id].account === signer);
    if (!npc || !(NPC_KEY_METHODS[npc] as readonly string[]).includes(method)) return { ok: false, reason: `not on the ${npc ?? 'operator'} key: never signed` };
    this.stats.sent++;
    try {
      const hash = await this.chain.call(signer, this.opts.contract, method, args, DEFAULT_TGAS);
      this.stats.ok++;
      this.record({ signer, method, ok: true, hash, redTeam: true });
      this.log(`red team: contract ACCEPTED ${signer} ${method} tx=${hash}`);
      return { ok: true, hash, reason: 'accepted' };
    } catch (e) {
      this.stats.failed++;
      const err = e as Error & { txHash?: string };
      const reason = err.message.replace(/^.*panicked: /, '').replace(/^Smart contract panicked: /, '').slice(0, 120);
      this.record({ signer, method, ok: false, hash: err.txHash, reason, redTeam: true });
      this.log(`red team: contract refused ${signer} ${method}${err.txHash ? ` tx=${err.txHash}` : ''}: ${reason}`);
      return { ok: false, hash: err.txHash, reason };
    }
  }

  // ------------------------------------------------------------------ balances
  /**
   * Spendable NEAR per signing account (balance minus storage), and a warning for any
   * account below `min` NEAR. Needs an adapter that can read balances.
   */
  async checkBalances(min = 0.1): Promise<Record<string, number>> {
    const read = this.chain.balance?.bind(this.chain);
    if (!read) return {};
    const out: Record<string, number> = {};
    const accounts = [...NPCS.map((id) => NPC_DEFS[id].account), ...(this.opts.operator ? [this.opts.operator] : [])];
    for (const a of accounts) {
      try {
        out[a] = await read(a);
        if (out[a] < min) this.log(`LOW BALANCE ${a}: ${out[a].toFixed(3)} NEAR spendable. Top it up (docs/testnet.md, "Gas").`);
      } catch (e) {
        this.log(`balance check ${a} failed: ${(e as Error).message}`);
      }
    }
    this.balances = out;
    return out;
  }

  balances: Record<string, number> = {};
  /** contract `get_version`, read at startup; 4+ settles NPC requests on chain */
  contractVersion = 0;

  /** `Village.badgeHook`: mints a soulbound badge for a human player. */
  readonly badgeHook = (playerId: string, b: { kind: string; title: string; description: string }): string | null => {
    const account = this.opts.playerAccount(playerId);
    if (!account || !this.opts.operator) return null;
    return this.enqueue([this.op('mint_badge', { owner_id: account, kind: b.kind, title: b.title, description: b.description })]);
  };

  private op(method: string, args: Record<string, unknown>): Call {
    return { signer: this.opts.operator, method, args, tgas: TGAS[method] ?? DEFAULT_TGAS };
  }

  /** Engine transaction -> contract calls (in order). null = stays off chain. */
  translate(signer: string, method: string, args: Record<string, unknown>): Call[] | null {
    const { operator } = this.opts;
    const npc = NPCS.find((id) => NPC_DEFS[id].account === signer);
    if (npc) {
      const call = (m: string, a: Record<string, unknown>): Call => ({ signer, method: m, args: a, tgas: TGAS[m] ?? DEFAULT_TGAS });
      const qty = Number(args.qty);
      switch (method) {
        case 'produce':
          return RAW.has(String(args.item)) && qty > 0 ? [call('produce', { item: args.item, qty: Math.min(qty, 12) })] : null;
        case 'craft':
          return Number(args.crafts) > 0 ? [call('craft', { item: args.item, crafts: Math.min(Number(args.crafts), 12) })] : null;
        case 'hire':
          return [call('hire', { seller: args.seller, item: args.item, qty, price: args.price })];
        case 'market_buy':
          return [call('market_buy', { item: args.item, qty, max_price: lenientMax(Number(args.max_price)) })];
        case 'market_sell':
          return [call('market_sell', { item: args.item, qty, min_price: lenientMin(Number(args.min_price)) })];
        case 'fill_order': {
          // a relayed order still on its way (a haggled sale) has its chain id already; the fill waits for it
          const oid = Number(args.order_id);
          const id = this.orders.get(oid) ?? (this.orderLanding.has(oid) ? this.chainOrderId(oid) : undefined);
          return id ? [call('fill_order', { order_id: id, qty, price: args.price })] : null;
        }
        case 'world_import': {
          const item = String(args.item);
          return ITEM_DEFS[item as keyof typeof ITEM_DEFS]?.world && qty > 0 ? [call('world_trade', { item, qty: Math.min(qty, 12), import: true })] : null;
        }
        case 'world_trade': {
          const item = String(args.item);
          if (!ITEM_DEFS[item as keyof typeof ITEM_DEFS]?.world) return null;
          const p = Number(args.market_price) || 0;
          return args.side === 'import'
            ? [call('world_trade', { item, qty, import: true }), call('market_sell', { item, qty, min_price: lenientMin(p) })]
            : [call('market_buy', { item, qty, max_price: lenientMax(p) }), call('world_trade', { item, qty, import: false })];
        }
        default:
          return null; // stall trades and the like stay in the engine
      }
    }
    if (!signer.endsWith(PLAYER_SIGNER_SUFFIX) || !operator || args.guild) return null;
    const player = this.opts.playerAccount(signer.slice(0, -PLAYER_SIGNER_SUFFIX.length));
    if (!player) return null;
    const qty = Number(args.qty);
    let relay: Call | null = null;
    switch (method) {
      case 'market_buy':
        relay = this.op('relay_market_buy', { player, item: args.item, qty, max_price: lenientMax(Number(args.max_price)) });
        break;
      case 'market_sell':
        relay = this.op('relay_market_sell', { player, item: args.item, qty, min_price: lenientMin(Number(args.min_price)) });
        break;
      case 'place_order': {
        const engineId = Number(args.order_id);
        const chainId = this.chainOrderId(engineId);
        relay = this.op('relay_place_order', { player, order_id: chainId, item: args.item, qty, max_price: args.max_price, deadline_days: args.deadline_days });
        relay.onOk = () => this.orders.set(engineId, chainId);
        break;
      }
      case 'cancel_order': {
        const id = this.orders.get(Number(args.order_id));
        if (id) relay = this.op('relay_cancel_order', { player, order_id: id });
        break;
      }
      case 'deliver_request':
        if (this.contractVersion >= 4) {
          relay = this.op('relay_deliver_request', { player, npc: args.npc, item: args.item, qty, price: args.price, bonus: String(args.bonus) });
        }
        break;
    }
    if (!relay) return null;
    return this.registrationQueued.has(player) ? [relay] : [this.registration(player), relay];
  }

  /** Start gold once per player; the contract ignores repeats. */
  private registration(player: string): Call {
    this.registrationQueued.add(player);
    const c = this.op('relay_register_player', { player, start_gold: String(RULES.playerStartGold) });
    c.onOk = () => this.registered.add(player);
    c.onFail = () => this.registrationQueued.delete(player);
    return c;
  }

  /** Register a player as soon as they log in, so their first trade is not delayed. */
  registerPlayer(playerId: string): string | null {
    const account = this.opts.playerAccount(playerId);
    if (!account || !this.opts.operator || this.registrationQueued.has(account)) return null;
    return this.enqueue([this.registration(account)], true);
  }

  // ------------------------------------------------------------------ operator: day start
  /**
   * Start of a game day: reconcile the chain to the engine and post the world data.
   * Rate-limited by real time (`minDayMs`), so a very fast clock does not flood the chain.
   */
  startDay(v: Village, world?: WorldPostInput): boolean {
    if (this.opts.batchProduce) this.flushProduce();
    const now = (this.opts.now ?? Date.now)();
    if (!this.active || !this.opts.operator) return false;
    if (now - this.lastDayAt < (this.opts.minDayMs ?? 50_000)) {
      // no full reconcile yet, but the contract's day (NPC daily budgets, order deadlines)
      // must still turn with the game's, or budgets add up over several game days
      this.enqueue([this.op('advance_day', {})], true);
      return false;
    }
    this.lastDayAt = now;
    const s = v.s;
    const gold: [string, string][] = NPCS.map((id) => [NPC_DEFS[id].account, String(s.npcs[id].gold)]);
    const items: [string, string, number][] = [];
    for (const id of NPCS) for (const i of ITEMS) items.push([NPC_DEFS[id].account, i, s.npcs[id].stock[i]]);
    for (const p of Object.values(s.players).filter((x) => !x.bot).sort((a, b) => b.lastActiveDay - a.lastActiveDay).slice(0, 8)) {
      const acct = this.opts.playerAccount(p.id);
      if (!acct || !this.registered.has(acct)) continue;
      gold.push([acct, String(p.gold)]);
      for (const i of ITEMS) items.push([acct, i, p.stock[i]]);
    }
    const builtAt = this.driftN;
    const reconcile = this.op('reconcile', {
      game_day: v.day,
      market_stock: ITEMS.map((i) => [i, s.market.stock[i]]),
      treasury: String(s.market.treasury),
      gold,
      items,
    });
    // the chain now holds the game's numbers again: NPCs that drifted before this point are clean
    reconcile.onOk = () => {
      for (const [k, n] of this.drift) if (n <= builtAt) this.drift.delete(k);
    };
    const calls: Call[] = [reconcile];
    if (world) {
      const prices = ITEMS.filter((i) => ITEM_DEFS[i].world && s.world.price[i]).map((i) => [i, s.world.price[i]]);
      calls.push(this.op('post_world_data', {
        source: world.source.slice(0, 512), raw: world.raw.slice(0, 2048), sha256: world.sha256, ts: Date.now(),
        prices, shipping_bps: s.world.shippingBps,
      }));
    }
    for (const c of calls) {
      const ph = this.enqueue([c], true);
      if (ph) this.log(`chain day ${v.day}: ${c.method} queued`);
    }
    return true;
  }

  // ------------------------------------------------------------------ queues
  private allow(now: number, n: number) {
    const max = this.opts.maxPerMinute ?? 90;
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length + n > max) return false;
    for (let i = 0; i < n; i++) this.recent.push(now);
    return true;
  }

  private enqueue(calls: Call[], force = false, after: Promise<unknown>[] = []): string | null {
    const signer = calls[0].signer;
    const q = this.queues.get(signer) ?? { tail: Promise.resolve(), size: 0 };
    const now = (this.opts.now ?? Date.now)();
    if (!force && (q.size >= (this.opts.maxQueue ?? 8) || !this.allow(now, calls.length))) {
      this.stats.skipped++;
      if (this.isNpc(signer)) this.markDrift(signer);
      for (const c of calls) c.onFail?.();
      return null;
    }
    const placeholder = `pending${(this.pendingN++).toString().padStart(6, '0')}xx`;
    q.size++;
    this.queues.set(signer, q);
    const run = async () => {
      if (after.length) await Promise.all(after.map((p) => p.catch(() => {})));
      let last = '';
      for (const c of calls) {
        this.stats.sent++;
        // the signer half of the guard: a key only ever signs the methods on that key
        const npc = NPCS.find((id) => NPC_DEFS[id].account === c.signer);
        const allowed: readonly string[] = npc ? NPC_KEY_METHODS[npc] : c.signer === this.opts.operator ? OPERATOR_METHODS : [];
        if (!allowed.includes(c.method)) throw new Error(`refused to sign ${c.method}: not on the ${npc ?? 'operator'} key`);
        try {
          last = await this.chain.call(c.signer, this.opts.contract, c.method, c.args, c.tgas);
        } catch (e) {
          for (const r of calls.slice(calls.indexOf(c))) r.onFail?.();
          const err = e as Error & { txHash?: string };
          this.record({ signer: c.signer, method: c.method, ok: false, hash: err.txHash, reason: err.message.replace(/^.*panicked: /, '').slice(0, 80) });
          throw e;
        }
        c.onOk?.();
        this.record({ signer: c.signer, method: c.method, ok: true, hash: last });
        this.log(`chain ok   ${c.signer} ${c.method} tx=${last}`);
      }
      return last;
    };
    q.tail = q.tail
      .catch(() => {})
      .then(run)
      .then(
        (hash) => {
          this.stats.ok++;
          this.settle(placeholder, hash);
        },
        (e: Error) => {
          this.stats.failed++;
          if (this.isNpc(signer)) this.markDrift(signer);
          this.log(`chain FAIL ${signer} ${calls.map((c) => c.method).join('+')}: ${e.message}`);
          this.settle(placeholder, `failed:${e.message.replace(/^.*panicked: /, '').slice(0, 60)}`);
        },
      )
      .finally(() => {
        q.size--;
      });
    return placeholder;
  }

  /** Resolves when every queued call has settled (tests, shutdown). */
  async idle() {
    await Promise.all([...this.queues.values()].map((q) => q.tail.catch(() => {})));
  }
}

/** The engine's price, plus room for the chain's market to have drifted a little. */
export const lenientMax = (p: number) => Math.max(1, Math.ceil((p || 0) * 1.3));
export const lenientMin = (p: number) => Math.max(1, Math.floor((p || 0) * 0.7));
