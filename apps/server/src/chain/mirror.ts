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
  /** a slow or offline chain must not stall the village */
  log?: (line: string) => void;
  now?: () => number;
}

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
const TGAS: Record<string, number> = { reconcile: 200, post_world_data: 30, relay_place_order: 30 };
const DEFAULT_TGAS = 20;

export class ChainMirror {
  /** last call per signer; each new call waits for it */
  private queues = new Map<string, { tail: Promise<unknown>; size: number }>();
  private recent: number[] = [];
  private pendingN = 0;
  private lastDayAt = -Infinity;
  /** engine order id -> on-chain order id, set once the relay landed */
  private orders = new Map<number, number>();
  /** players whose registration landed / is queued */
  private registered = new Set<string>();
  private registrationQueued = new Set<string>();
  /** order ids are unique per server run */
  private readonly orderBase: number;
  readonly stats = { sent: 0, ok: 0, failed: 0, skipped: 0 };
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
    const calls = this.translate(signer, method, args);
    if (!calls) return null;
    return this.enqueue(calls);
  };

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
          const id = this.orders.get(Number(args.order_id));
          return id ? [call('fill_order', { order_id: id, qty, price: args.price })] : null;
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
    const now = (this.opts.now ?? Date.now)();
    if (!this.opts.operator || now - this.lastDayAt < (this.opts.minDayMs ?? 50_000)) return false;
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
    const calls: Call[] = [
      this.op('reconcile', {
        game_day: v.day,
        market_stock: ITEMS.map((i) => [i, s.market.stock[i]]),
        treasury: String(s.market.treasury),
        gold,
        items,
      }),
    ];
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

  private enqueue(calls: Call[], force = false): string | null {
    const signer = calls[0].signer;
    const q = this.queues.get(signer) ?? { tail: Promise.resolve(), size: 0 };
    const now = (this.opts.now ?? Date.now)();
    if (!force && (q.size >= (this.opts.maxQueue ?? 8) || !this.allow(now, calls.length))) {
      this.stats.skipped++;
      for (const c of calls) c.onFail?.();
      return null;
    }
    const placeholder = `pending${(this.pendingN++).toString().padStart(6, '0')}xx`;
    q.size++;
    this.queues.set(signer, q);
    const run = async () => {
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
          throw e;
        }
        c.onOk?.();
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
          this.onSettled(placeholder, hash);
        },
        (e: Error) => {
          this.stats.failed++;
          this.log(`chain FAIL ${signer} ${calls.map((c) => c.method).join('+')}: ${e.message}`);
          this.onSettled(placeholder, `failed:${e.message.replace(/^.*panicked: /, '').slice(0, 60)}`);
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
