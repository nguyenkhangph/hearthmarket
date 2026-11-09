import { ITEMS, NPC_DEFS, type ItemId, type NpcId } from './defs.ts';
import { fmt, g } from './money.ts';
import { bidPrice, midPrice } from './market.ts';
import { dealPairs, negotiateRules } from './deals.ts';
import { ReplayWorld, type WorldDay } from './world.ts';
import { Village } from './engine.ts';
import { createVillage } from './index.ts';
import type { Action, ActionResult } from './types.ts';

/**
 * The 3-day harvest challenge: one seeded, replayable round of 8-10 minutes.
 *
 * A bulletin warns of a wheat blight two days out. Chloe the baker signs a fixed-price
 * contract with the player for wheat, due by the evening of the last day. Buy before the
 * blight and the contract pays; buy after and it costs you. Spare wheat can be sold into the
 * shortage, or kept. At the end: net worth change, contract kept or not, a verdict with its
 * reasons, and the key decisions. Everything runs in the deterministic engine, so the same
 * seed and the same actions always give the same score (`replayChallenge`).
 *
 * The blight is scripted (labelled "scenario" in the game); the world weather is the replayed
 * demo week. Nothing here is live data.
 */
export type ChallengeLevel = 'easy' | 'normal' | 'hard';

export interface ChallengeSpec {
  level: ChallengeLevel;
  seed: number;
  /** game days the round lasts */
  days: number;
  startGold: number;
  contract: { npc: NpcId; item: ItemId; qty: number; premiumBps: number; bonus: number };
  /** the blight: share of the market's and the farmer's wheat lost at this challenge day/hour */
  shock: { day: number; hour: number; item: ItemId; loss: number };
  /** profit (net worth change, gold units ×100) needed to win, on top of keeping the contract */
  target: number;
}

export const CHALLENGES: Record<ChallengeLevel, ChallengeSpec> = {
  easy: { level: 'easy', seed: 101, days: 3, startGold: g(80), contract: { npc: 'chloe', item: 'wheat', qty: 5, premiumBps: 12_500, bonus: g(4) }, shock: { day: 2, hour: 6, item: 'wheat', loss: 0.55 }, target: g(5) },
  normal: { level: 'normal', seed: 202, days: 3, startGold: g(60), contract: { npc: 'chloe', item: 'wheat', qty: 6, premiumBps: 12_000, bonus: g(4) }, shock: { day: 2, hour: 6, item: 'wheat', loss: 0.65 }, target: g(9) },
  hard: { level: 'hard', seed: 303, days: 3, startGold: g(45), contract: { npc: 'chloe', item: 'wheat', qty: 8, premiumBps: 11_500, bonus: g(4) }, shock: { day: 2, hour: 6, item: 'wheat', loss: 0.75 }, target: g(14) },
};

/** One player action, at the tick it happened (enough to replay the round exactly). */
export interface ChallengeMove {
  tick: number;
  action: Action | { type: 'deliver_contract' };
}

export interface ChallengeResult {
  level: ChallengeLevel;
  seed: number;
  startWorth: number;
  endWorth: number;
  profit: number;
  delivered: boolean;
  /** profit in gold, +10 when the contract was kept; rounded to 0.1 */
  score: number;
  verdict: 'win' | 'lose';
  reasons: string[];
  /** the moves that mattered most, best first */
  decisions: string[];
  moves: number;
}

export const PLAYER_ID = 'you';

export class Challenge {
  readonly v: Village;
  readonly spec: ChallengeSpec;
  readonly moves: ChallengeMove[] = [];
  readonly startTick: number;
  readonly endTick: number;
  readonly contractPrice: number;
  readonly startWorth: number;
  delivered: { tick: number; tx?: string } | null = null;
  private shocked = false;
  /** what each buy/sell cost, for the end-of-round analysis */
  private trades: { tick: number; side: 'buy' | 'sell'; item: ItemId; qty: number; price: number }[] = [];

  constructor(level: ChallengeLevel, worldDays: WorldDay[]) {
    this.spec = CHALLENGES[level];
    this.v = createVillage({ seed: this.spec.seed, world: new ReplayWorld(worldDays) });
    this.v.runDays(2); // charts and the feed have some history; day 3 is challenge day 1
    const p = this.v.addPlayer(PLAYER_ID, 'You');
    // the round's own starting purse (the signup faucet books the difference, so gold stays conserved)
    this.v.s.ledger.faucets.signup += this.spec.startGold - p.gold;
    p.gold = this.spec.startGold;
    this.negotiate();
    this.startTick = this.v.s.tick;
    this.endTick = this.startTick + this.spec.days * 24 - 6; // 18:00 on the last day
    const c = this.spec.contract;
    this.contractPrice = Math.round(midPrice(c.item, this.v.s.market.stock[c.item]) * c.premiumBps / 10_000);
    this.startWorth = this.worth();
  }

  get player() {
    return this.v.s.players[PLAYER_ID];
  }

  /** challenge day 1..days */
  get day() {
    return Math.floor((this.v.s.tick - this.startTick) / 24) + 1;
  }

  get over() {
    return this.v.s.tick >= this.endTick;
  }

  /** gold + goods at what the market would pay for them now */
  worth() {
    const p = this.player;
    return p.gold + ITEMS.reduce((s, i) => s + p.stock[i] * bidPrice(i, this.v.s.market.stock[i]), 0);
  }

  private negotiate() {
    for (const p of dealPairs()) {
      const r = negotiateRules(this.v, p);
      this.v.setDeal({ ...p, agreed: r.agreed, price: r.price, maxQty: r.maxQty, by: 'rules', rounds: r.rounds });
    }
  }

  /** One game hour: the blight when it is due, the world, the agents. */
  step() {
    if (this.over) return;
    const sh = this.spec.shock;
    if (!this.shocked && this.day === sh.day && this.v.hour >= sh.hour) this.blight();
    this.v.step();
    if (this.v.hour === 0) this.negotiate();
  }

  private blight() {
    this.shocked = true;
    const sh = this.spec.shock;
    const s = this.v.s;
    const lostMarket = Math.floor(s.market.stock[sh.item] * sh.loss);
    const producer = (Object.keys(NPC_DEFS) as NpcId[]).find((id) => NPC_DEFS[id].produces.includes(sh.item));
    const lostFarm = producer ? Math.floor(s.npcs[producer].stock[sh.item] * sh.loss) : 0;
    s.market.stock[sh.item] -= lostMarket;
    if (producer) s.npcs[producer].stock[sh.item] -= lostFarm;
    this.v.feed('world', `Scenario: blight in the granary · ${lostMarket + lostFarm} ${sh.item} lost, ${sh.item} now ${fmt(midPrice(sh.item, s.market.stock[sh.item]), 2)}`);
  }

  /** A player action, recorded for the replay. */
  act(action: Action): ActionResult {
    if (this.over) return { ok: false, reason: 'the round is over' };
    const before = this.player.gold;
    const r = this.v.act({ kind: 'player', id: PLAYER_ID }, action);
    if (r.ok) {
      this.moves.push({ tick: this.v.s.tick, action });
      if (action.type === 'market_buy' || action.type === 'market_sell') {
        const paid = Math.abs(before - this.player.gold);
        this.trades.push({ tick: this.v.s.tick, side: action.type === 'market_buy' ? 'buy' : 'sell', item: action.item, qty: action.qty, price: Math.round(paid / action.qty) });
      }
    }
    return r;
  }

  /** Hand the contract's goods to the NPC; it pays the agreed price from its own gold. */
  deliver(): ActionResult {
    if (this.over) return { ok: false, reason: 'the round is over' };
    if (this.delivered) return { ok: false, reason: 'already delivered' };
    const c = this.spec.contract;
    const p = this.player;
    const n = this.v.s.npcs[c.npc];
    if (p.stock[c.item] < c.qty) return { ok: false, reason: `you need ${c.qty} ${c.item} (you have ${p.stock[c.item]})` };
    const pay = this.contractPrice * c.qty;
    if (n.gold < pay) return { ok: false, reason: `${NPC_DEFS[c.npc].name} cannot pay right now` };
    p.stock[c.item] -= c.qty;
    n.stock[c.item] += c.qty;
    n.gold -= pay;
    p.gold += pay + c.bonus;
    this.v.s.ledger.faucets.quests += c.bonus;
    this.delivered = { tick: this.v.s.tick };
    this.moves.push({ tick: this.v.s.tick, action: { type: 'deliver_contract' } });
    this.v.feed('quest', `You delivered ${c.qty} ${c.item} to ${NPC_DEFS[c.npc].name} at the contract price ${fmt(this.contractPrice, 2)} · +${fmt(pay + c.bonus)} gold`, c.npc);
    return { ok: true, info: `contract kept: +${fmt(pay + c.bonus)} gold` };
  }

  /** The forecast shown at the start, from the scenario and the replayed weather. */
  bulletin(): string[] {
    const c = this.spec.contract;
    const sh = this.spec.shock;
    const mid = midPrice(c.item, this.v.s.market.stock[c.item]);
    const lines = [
      `Forecast: blight risk in the granary early on day ${sh.day} (scenario). ${c.item[0].toUpperCase() + c.item.slice(1)} (today ${fmt(mid, 2)}) should spike when it hits, then ease as the farm and the merchant refill the market.`,
      `${NPC_DEFS[c.npc].name} offers a contract: ${c.qty} ${c.item} at a fixed ${fmt(this.contractPrice, 2)} each + ${fmt(c.bonus, 0)} bonus, due by 18:00 on day ${this.spec.days}.`,
      `Win: keep the contract and end at least ${fmt(this.spec.target, 0)} gold up (goods count at what the market pays).`,
    ];
    const kansas = this.v.s.world.regions.find((r) => r.id === 'kansas');
    if (kansas?.forecast) lines.push(`World: ${kansas.forecast} (replayed demo week).`);
    return lines;
  }

  result(): ChallengeResult {
    const endWorth = this.worth();
    const profit = endWorth - this.startWorth;
    const c = this.spec.contract;
    const reasons: string[] = [];
    if (!this.delivered) reasons.push(`${NPC_DEFS[c.npc].name}'s contract was not kept: ${c.qty} ${c.item} were due by 18:00 on day ${this.spec.days}.`);
    if (profit < this.spec.target) reasons.push(`You ended ${fmt(profit)} gold ${profit >= 0 ? 'up' : 'down'}; the goal was +${fmt(this.spec.target, 0)}.`);
    const win = reasons.length === 0;
    if (win) reasons.push(`Contract kept and ${fmt(profit)} gold up (goal +${fmt(this.spec.target, 0)}).`);
    // each trade against where the price ended: what it was worth to do it when you did
    const endPrice = (i: ItemId) => midPrice(i, this.v.s.market.stock[i]);
    const shockTick = this.startTick + (this.spec.shock.day - 1) * 24 + this.spec.shock.hour;
    const decisions = this.trades
      .map((t) => {
        const when = `day ${Math.floor((t.tick - this.startTick) / 24) + 1} ${String(t.tick % 24).padStart(2, '0')}:00`;
        const edge = (t.side === 'buy' ? endPrice(t.item) - t.price : t.price - endPrice(t.item)) * t.qty;
        const timing = t.tick < shockTick ? 'before the blight' : 'after the blight';
        return { edge, text: `${when}: ${t.side} ${t.qty} ${t.item} at ${fmt(t.price, 2)}, ${timing} (${edge >= 0 ? '+' : ''}${fmt(edge)} vs the closing price ${fmt(endPrice(t.item), 2)})` };
      })
      .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))
      .map((d) => d.text)
      .slice(0, 4);
    if (this.delivered) decisions.push(`day ${Math.floor((this.delivered.tick - this.startTick) / 24) + 1}: contract delivered at ${fmt(this.contractPrice, 2)} each`);
    const score = Math.round((profit / 100 + (this.delivered ? 10 : 0)) * 10) / 10;
    return {
      level: this.spec.level, seed: this.spec.seed, startWorth: this.startWorth, endWorth, profit,
      delivered: !!this.delivered, score, verdict: win ? 'win' : 'lose', reasons, decisions, moves: this.moves.length,
    };
  }
}

/** Plays a recorded round again from its seed: same moves, same score. */
export function replayChallenge(level: ChallengeLevel, worldDays: WorldDay[], moves: ChallengeMove[]): ChallengeResult {
  const c = new Challenge(level, worldDays);
  const queue = [...moves].sort((a, b) => a.tick - b.tick);
  while (!c.over) {
    while (queue.length && queue[0].tick === c.v.s.tick) {
      const m = queue.shift()!;
      if (m.action.type === 'deliver_contract') c.deliver();
      else c.act(m.action as Action);
    }
    c.step();
  }
  return c.result();
}

