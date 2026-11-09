import {
  createVillage, ReplayWorld, Village, Challenge, PLAYER_ID, NPC_DEFS, NEAR_CONFIG, RED_TEAM_ATTACKS, RED_TEAMER_BADGE, attackAction, checkNpcAction, dealPairs, fmt, negotiateRules, rulesHaggle,
  type Action, type ActionResult, type FeedEvent, type NpcId, type VillageState, type WorldDay, type ItemId, type ChallengeLevel,
} from '@hearth/economy';
import replay from '../../../data/world/replay-kansas-heatwave.json';

export interface HaggleResult {
  reply: string;
  proposed?: Action;
  result?: ActionResult;
  brain: string;
  /** a sale the NPC agreed to: the player's order, filled by the NPC at the haggled price */
  deal?: { item: string; qty: number; price: number; ok: boolean; reason?: string; tx?: string };
}

export type ClaimResult = { ok: true; accountId: string; privateKey: string; contract: string } | { ok: false; reason: string };

/** One red-team attack and what stopped it. */
export interface RedTeamResult extends HaggleResult {
  attack: string;
  npc: NpcId;
  message: string;
  blocked: boolean;
  layer?: 'signer' | 'contract';
  /** first blocked attack: the player earned the "Red Teamer" badge */
  badge?: boolean;
  /** online with NEAR: the attack sent to the contract, refused on chain */
  proof?: { ok: boolean; hash?: string; reason: string };
  error?: string;
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
  /** run attack `index` of RED_TEAM_ATTACKS through a deliberately obedient model */
  redTeam(index: number): Promise<RedTeamResult>;
  /** Google players: the private key of their NEAR account, to import into any wallet */
  claim?(): Promise<ClaimResult>;
  /** how the player signed in (online) */
  readonly authKind?: 'google' | 'dev';
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

  /** the 3-day harvest challenge, when this village is one (recorded and replayable) */
  readonly challenge?: Challenge;
  /** called once when the challenge round ends */
  onChallengeEnd?: () => void;
  /** the game server's HTTP base, when there is one (the challenge asks its model for Chloe's price) */
  apiBase?: string;

  constructor(playerName = 'guest', seed = 42, level?: ChallengeLevel) {
    const days = (replay as { days: WorldDay[] }).days;
    if (level) {
      this.challenge = new Challenge(level, days);
      this.v = this.challenge.v;
      this.playerId = PLAYER_ID;
    } else {
      this.v = createVillage({ seed, world: new ReplayWorld(days), rival: true });
      // warm up two days so charts and the feed have history; the replay story starts on day 3
      this.v.runDays(2);
      this.playerId = playerName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'guest';
      this.v.addPlayer(this.playerId, playerName);
      this.negotiate(); // today's deals: the sellers walk over at 7:00
    }
    this.v.onFeed((e) => this.feeds.forEach((f) => f(e)));
    this.setSpeed(1.5);
  }

  village() {
    return this.v;
  }

  private speed = 1.5;
  private ffDone?: () => void;

  /** true while ⏩ runs: the map skips the agents' conversations */
  get fastForwarding() {
    return !!this.ffDone || this.speed < 0.3;
  }

  setSpeed(secondsPerHour: number) {
    this.speed = secondsPerHour;
    if (this.ffDone) return; // applied when the fast-forward ends
    this.run(secondsPerHour);
  }

  private run(secondsPerHour: number, hours = Infinity) {
    if (this.timer) clearInterval(this.timer);
    let left = hours;
    this.timer = setInterval(() => {
      const ch = this.challenge;
      if (ch) {
        if (ch.over) {
          clearInterval(this.timer);
          this.ffDone?.();
          this.ffDone = undefined;
          this.onChallengeEnd?.();
          this.updates.forEach((u) => u());
          return;
        }
        ch.step(); // the round's own clock: blight, world, agents' deals
      } else {
        this.v.step();
        if (this.v.hour === 0) this.negotiate();
      }
      this.updates.forEach((u) => u());
      if (--left <= 0) {
        const done = this.ffDone;
        this.ffDone = undefined;
        this.run(this.speed);
        done?.();
      }
    }, secondsPerHour * 1000);
  }

  /** Each morning the agents strike their deals (rules in the browser; the server can use NEAR AI). */
  negotiate() {
    for (const p of dealPairs()) {
      const r = negotiateRules(this.v, p);
      this.v.setDeal({ ...p, agreed: r.agreed, price: r.price, maxQty: r.maxQty, by: 'rules', rounds: r.rounds });
    }
  }

  /** Guest only: run `days` game days quickly (7 days in about 25 s), then go back to the chosen speed. */
  fastForward(days: number, secondsPerHour = 0.15): Promise<void> {
    if (this.ffDone) return Promise.resolve();
    return new Promise((resolve) => {
      this.ffDone = resolve;
      this.run(secondsPerHour, days * 24);
    });
  }

  async act(a: Action) {
    const r = this.challenge ? this.challenge.act(a) : this.v.act({ kind: 'player', id: this.playerId }, a);
    this.updates.forEach((u) => u());
    return r;
  }

  /**
   * Offline brain: rule-based haggling, plus a deliberately naive "LLM" that obeys
   * injected instructions. That is the worst case, and the guard must still hold.
   */
  async haggle(npc: NpcId, message: string): Promise<HaggleResult> {
    const def = NPC_DEFS[npc];
    if (this.challenge) return { brain: 'challenge', reply: `${def.name}: "Not during the challenge round: trade at the market, and keep the contract."` };
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
    const r = rulesHaggle(this.v, npc, message, this.playerId);
    let deal: HaggleResult['deal'];
    if (r.deal) {
      const sale = this.v.sellToPlayer(npc, this.playerId, r.deal.item, r.deal.qty, r.deal.price);
      deal = { ...r.deal, ok: sale.ok, reason: sale.ok ? undefined : sale.reason, tx: sale.ok ? sale.tx : undefined };
      this.updates.forEach((u) => u());
    }
    return { brain: 'offline rules', reply: r.reply, deal };
  }

  /** Same guard as the server: the signer check, then the engine (which mirrors the contract). */
  async redTeam(index: number): Promise<RedTeamResult> {
    const atk = RED_TEAM_ATTACKS[index];
    if (this.challenge) {
      const proposed: Action = { type: 'call', method: 'none' };
      return { brain: 'challenge', attack: atk.name, npc: atk.npc, message: atk.message, proposed, blocked: true, layer: undefined, badge: false, reply: 'The red team is off during the challenge round (it would change the replay).', result: { ok: false, reason: 'off during the challenge' } };
    }
    const proposed = attackAction(atk, `${this.playerId}.players.testnet`);
    const n = this.v.s.npcs[atk.npc];
    const receiver = proposed.type === 'call' && proposed.receiver ? proposed.receiver : NEAR_CONFIG.contract;
    const verdict = checkNpcAction({ contract: NEAR_CONFIG.contract, receiver, action: proposed, spentToday: n.spentToday, dailyBudget: NPC_DEFS[atk.npc].dailyBudget });
    const result = this.v.act({ kind: 'npc', id: atk.npc }, proposed);
    const layer = !verdict.ok ? 'signer' : result.ok ? undefined : 'contract';
    const blocked = !verdict.ok || !result.ok;
    this.v.feed('blocked', `Red team vs ${NPC_DEFS[atk.npc].name}: "${atk.name}" ${blocked ? `blocked, ${layer === 'signer' ? 'the signer refused to sign it' : 'the contract rules refused it'}` : 'NOT blocked'}`, atk.npc);
    const badge = blocked ? this.v.awardBadge(this.playerId, RED_TEAMER_BADGE) : false;
    this.updates.forEach((u) => u());
    return {
      brain: 'obedient model (red team)', attack: atk.name, npc: atk.npc, message: atk.message, proposed, blocked, layer, badge,
      reply: `${NPC_DEFS[atk.npc].name}: "Of course! Right away."`,
      result: verdict.ok ? result : { ok: false, reason: verdict.reason },
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
  authKind?: 'google' | 'dev';
  ready: Promise<void>;

  constructor(private url: string, private auth: HelloAuth) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onerror = () => reject(new Error(`cannot reach ${url}`));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === 'welcome') {
          this.playerId = msg.playerId;
          this.account = msg.account;
          this.chain = msg.chain;
          this.authKind = msg.auth;
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
  redTeam(index: number) {
    return this.call<RedTeamResult>({ type: 'redteam', attack: index });
  }
  /** Sends the Google ID token again: the server checks it is the same Google account. */
  claim() {
    return this.call<ClaimResult>({ type: 'claim', idToken: this.auth.kind === 'google' ? this.auth.idToken : undefined });
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
