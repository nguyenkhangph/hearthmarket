import { NPC_DEFS, type ItemId, type NpcId } from './defs.ts';
import { fmt, type Gold } from './money.ts';
import { midPrice } from './market.ts';
import type { Village } from './engine.ts';
import { noteLowball, regardBps } from './regard.ts';

/** Rounds an NPC haggles before its last word for the day. */
export const HAGGLE_ROUNDS = 3;
/** what the NPC accepts in round 1, 2, 3, as a share of its price for this player */
const ACCEPT = [1.0, 0.97, 0.94];
/** what it asks in round 1, 2, 3 */
const ASK = [1.06, 1.02, 0.97];

export interface HaggleRound {
  round: number;
  /** this round's counter, per unit */
  ask: Gold;
  /** the lowest offer it takes this round */
  floor: Gold;
  final: boolean;
  item: ItemId;
}

/**
 * Where a haggle with this NPC stands today, and the next round. Kept in the village state so it
 * is the same online and in the browser; a new day, or a deal, starts again at round 1.
 */
export function haggleRound(v: Village, npc: NpcId, playerId: string | undefined, advance: boolean | 'peek' = true): HaggleRound | undefined {
  const item = NPC_DEFS[npc].produces[0];
  if (!item) return undefined;
  const reg = playerId ? regardBps(v, npc, playerId) : { bps: 0 };
  const base = midPrice(item, v.s.market.stock[item]) * (1 + reg.bps / 10_000);
  const key = `${npc}:${playerId ?? '-'}`;
  const cur = v.s.haggles?.[key]?.day === v.day ? v.s.haggles[key] : undefined;
  // 'peek': what the next round would be, without moving to it
  const round = Math.min(HAGGLE_ROUNDS, (cur?.round ?? 0) + (advance ? 1 : 0)) || 1;
  if (advance === true) (v.s.haggles ??= {})[key] = { day: v.day, round };
  return { round, ask: Math.round(base * ASK[round - 1]), floor: Math.round(base * ACCEPT[round - 1]), final: round >= HAGGLE_ROUNDS, item };
}

/** A deal closes the haggle: the next one starts at round 1. */
export function closeHaggle(v: Village, npc: NpcId, playerId: string | undefined) {
  if (v.s.haggles) delete v.s.haggles[`${npc}:${playerId ?? '-'}`];
}

/**
 * Rule haggling (no model): "3 ore for 5.8" or "5.8 for ore". The NPC opens high and comes down
 * over three rounds (its counter and the lowest offer it takes both fall); round 3 is its last
 * word for the day. A lowball (under 85% of the market) gets no concession.
 */
export function rulesHaggle(v: Village, npc: NpcId, message: string, playerId?: string): { reply: string; deal?: { item: ItemId; qty: number; price: Gold } } {
  const def = NPC_DEFS[npc];
  const item: ItemId | undefined = def.produces[0];
  if (!item) return { reply: `${def.name}: "I move goods when the world price gap is wide enough."` };
  // what this NPC remembers about the player moves its price: regulars pay less, lowballers more
  const reg = playerId ? regardBps(v, npc, playerId) : { bps: 0, why: '' };
  const mid = Math.round(midPrice(item, v.s.market.stock[item]) * (1 + reg.bps / 10_000));
  const market = midPrice(item, v.s.market.stock[item]);
  const nums = [...message.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const qtyMatch = new RegExp(`(\\d+)\\s*(?:x\\s*)?${item}`, 'i').exec(message);
  const qty = qtyMatch ? Math.max(1, Math.min(12, Number(qtyMatch[1]))) : 1;
  const priceNum = nums.find((n) => !qtyMatch || n !== Number(qtyMatch[1])) ?? 0;
  const offer = Math.round(priceNum * 100);
  const held = v.s.npcs[npc].stock[item];
  const lowball = offer > 0 && offer < Math.round(market * 0.85);
  const remark = reg.bps < 0 ? ' For you, a regular, a little off.' : reg.bps > 0 ? " After those lowball offers, I'm not giving you a discount." : '';
  if (!offer) {
    const r = haggleRound(v, npc, playerId, false)!;
    return { reply: `${def.name}: "Today ${item} goes for about ${fmt(r.ask)} per ${item}. Make me an offer, like '3 ${item} for ${fmt(r.ask)}'."` };
  }
  // a lowball does not move the NPC: it stays on the round it was on (and is remembered after this reply)
  const r = haggleRound(v, npc, playerId, !lowball)!;
  if (playerId && lowball) noteLowball(v, npc, playerId);
  if (offer >= r.floor) {
    if (held <= 0) return { reply: `${def.name}: "${fmt(offer)} is fair, but I'm out of ${item} right now. Try me later today."` };
    const q = Math.min(qty, held);
    closeHaggle(v, npc, playerId);
    return { reply: `${def.name}: "${fmt(offer)} for ${q} ${item}? Deal."`, deal: { item, qty: q, price: offer } };
  }
  const tag = r.final ? ` That's my last word today.` : r.round === 2 ? ` I'll come down a little: ` : '';
  return {
    reply: lowball
      ? `${def.name}: "${fmt(offer)}? Not even close. ${fmt(r.ask)} per ${item}.${remark}"`
      : r.final
        ? `${def.name}: "${fmt(offer)} is too low. ${fmt(r.ask)} per ${item}, and it's yours.${tag}${remark}"`
        : `${def.name}: "${fmt(offer)} is too low.${tag || ' '}${fmt(r.ask)} per ${item}, and it's yours.${remark}"`,
  };
}

/** A model-driven haggle notes a lowball offer the same way the rules do. */
export function noteOfferFrom(v: Village, npc: NpcId, playerId: string, message: string) {
  const item = NPC_DEFS[npc].produces[0];
  if (!item) return;
  const mid = midPrice(item, v.s.market.stock[item]);
  const qtyMatch = new RegExp(`(\\d+)\\s*(?:x\\s*)?${item}`, 'i').exec(message);
  const nums = [...message.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const offer = Math.round((nums.find((n) => !qtyMatch || n !== Number(qtyMatch[1])) ?? 0) * 100);
  if (offer > 0 && offer < Math.round(mid * 0.85)) noteLowball(v, npc, playerId);
}

