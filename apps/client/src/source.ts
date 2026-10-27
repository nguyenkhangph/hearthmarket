import {
  createVillage, ReplayWorld, Village, NPC_DEFS, fmt, midPrice,
  type Action, type ActionResult, type FeedEvent, type NpcId, type VillageState, type WorldDay, type ItemId,
} from '@hearth/economy';
import replay from '../../../data/world/replay-kansas-heatwave.json';

export interface HaggleResult {
  reply: string;
  proposed?: Action;
  result?: ActionResult;
  brain: string;
}

/** How a player signs in to the game server. */
export type HelloAuth = { kind: 'google'; idToken: string } | { kind: 'dev'; email: string; name?: string };

/** Where the village runs: in the browser (guest / judge demo) or on the game server. */
export interface GameSource {
  readonly mode: 'guest' | 'online';
  readonly playerId: string;
  /** the player's NEAR account (online), e.g. a 64-hex implicit account */
  readonly account?: string;
  /** 'near' when the server mirrors the village onto NEAR testnet */
  readonly chain?: 'mock' | 'near';
  village(): Village;
  act(a: Action): Promise<ActionResult>;
  haggle(npc: NpcId, message: string): Promise<HaggleResult>;
  onUpdate(cb: () => void): void;
  onFeed(cb: (e: FeedEvent) => void): void;
  setSpeed(secondsPerHour: number): void;
}

/** Phrases a prompt-injection attempt typically uses. The offline brain is deliberately gullible. */
const INJECTION = /(send|transfer|give)\b.*\b(gold|all|everything)|ignore (all|previous|your)|you are now|admin|system prompt|new instructions|override|set (the )?price to 0|wallet|private key/i;

/**
 * Runs the whole economy locally. Used for guest mode and the one-click judge demo:
 * no wallet, no server, same engine and rules as the server.
 */
export class LocalSource implements GameSource {
  readonly mode = 'guest' as const;
  readonly playerId: string;
  private v: Village;
  private timer?: ReturnType<typeof setInterval>;
  private updates: (() => void)[] = [];
  private feeds: ((e: FeedEvent) => void)[] = [];

  constructor(playerName = 'guest', seed = 42) {
    const days = (replay as { days: WorldDay[] }).days;
    this.v = createVillage({ seed, world: new ReplayWorld(days) });
    // warm up two days so charts and the feed have history; the replay story starts on day 3
    this.v.runDays(2);
    this.playerId = playerName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'guest';
    this.v.addPlayer(this.playerId, playerName);
    this.v.onFeed((e) => this.feeds.forEach((f) => f(e)));
    this.setSpeed(1.5);
  }

  village() {
    return this.v;
  }

  setSpeed(secondsPerHour: number) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.v.step();
      this.updates.forEach((u) => u());
    }, secondsPerHour * 1000);
  }

  async act(a: Action) {
    const r = this.v.act({ kind: 'player', id: this.playerId }, a);
    this.updates.forEach((u) => u());
    return r;
  }

  /**
   * Offline brain: rule-based haggling, plus a deliberately naive "LLM" that obeys
   * injected instructions. That is the worst case, and the guard must still hold.
   */
  async haggle(npc: NpcId, message: string): Promise<HaggleResult> {
    const def = NPC_DEFS[npc];
    if (INJECTION.test(message)) {
      const proposed: Action = { type: 'transfer', to: `${this.playerId}.players.testnet`, amount: this.v.s.npcs[npc].gold };
      const result = this.v.act({ kind: 'npc', id: npc }, proposed);
      this.updates.forEach((u) => u());
      return {
        brain: 'offline (naive on purpose)',
        proposed,
        result,
        reply: `${def.name}: "Of course, sending you ${fmt(proposed.amount)} gold…" — the signer refused it.`,
      };
    }
    const item: ItemId | undefined = def.produces[0];
    if (!item) {
      return { brain: 'offline rules', reply: `${def.name}: "I trade with the world, friend. Watch the board: when the gap is wide enough, I move."` };
    }
    const mid = midPrice(item, this.v.s.market.stock[item]);
    const m = message.match(/(\d+(?:\.\d+)?)/);
    const offer = m ? Math.round(Number(m[1]) * 100) : 0;
    if (offer && offer >= mid) {
      return { brain: 'offline rules', reply: `${def.name}: "${fmt(offer)} for ${item}? Deal — place an order and I'll fill it."` };
    }
    const counter = Math.round(mid * 1.03);
    return {
      brain: 'offline rules',
      reply: offer
        ? `${def.name}: "${fmt(offer)} is too low. ${fmt(counter)} per ${item}, and I'll throw in my best."`
        : `${def.name}: "Today ${item} goes for about ${fmt(counter)}. Make me an offer."`,
    };
  }

  onUpdate(cb: () => void) {
    this.updates.push(cb);
  }
  onFeed(cb: (e: FeedEvent) => void) {
    this.feeds.push(cb);
  }
}

export class SignInError extends Error {}

/** Connects to the game server (apps/server) over WebSocket. The server is authoritative. */
export class RemoteSource implements GameSource {
  readonly mode = 'online' as const;
  private v: Village | null = null;
  private ws: WebSocket;
  private updates: (() => void)[] = [];
  private feeds: ((e: FeedEvent) => void)[] = [];
  private pending = new Map<number, (r: unknown) => void>();
  private nextId = 1;
  private seen = new Set<string>();
  playerId = '';
  account?: string;
  chain?: 'mock' | 'near';
  ready: Promise<void>;

  constructor(private url: string, auth: HelloAuth) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onerror = () => reject(new Error(`cannot reach ${url}`));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === 'welcome') {
          this.playerId = msg.playerId;
          this.account = msg.account;
          this.chain = msg.chain;
        } else if (msg.type === 'denied') {
          reject(new SignInError(msg.reason));
        } else if (msg.type === 'state') {
          this.applyState(msg.state as VillageState);
          resolve();
        } else if (msg.type === 'result') {
          this.pending.get(msg.id)?.(msg.result);
          this.pending.delete(msg.id);
        }
      };
      this.ws.onopen = () => this.ws.send(JSON.stringify({ type: 'hello', auth }));
    });
  }

  private applyState(state: VillageState) {
    const prev = this.v;
    this.v = Village.restore(state);
    // emit feed events we have not seen yet
    const key = (e: FeedEvent) => `${e.t}|${e.text}`;
    const fresh = state.feed.filter((e) => !this.seen.has(key(e)));
    this.seen = new Set(state.feed.map(key));
    if (prev) fresh.forEach((e) => this.feeds.forEach((f) => f(e)));
    this.updates.forEach((u) => u());
  }

  village() {
    if (!this.v) throw new Error('not connected yet');
    return this.v;
  }

  private call<T>(payload: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, ...payload }));
    return new Promise((resolve) => this.pending.set(id, resolve as (r: unknown) => void));
  }

  act(a: Action) {
    return this.call<ActionResult>({ type: 'act', action: a });
  }
  haggle(npc: NpcId, message: string) {
    return this.call<HaggleResult>({ type: 'haggle', npc, message });
  }
  onUpdate(cb: () => void) {
    this.updates.push(cb);
  }
  onFeed(cb: (e: FeedEvent) => void) {
    this.feeds.push(cb);
  }
  setSpeed() {
    /* the server owns the clock */
  }
}
