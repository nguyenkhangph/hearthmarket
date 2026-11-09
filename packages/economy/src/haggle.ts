import { NPC_DEFS, type ItemId, type NpcId } from './defs.ts';
import { fmt, type Gold } from './money.ts';
import { midPrice } from './market.ts';
import type { Village } from './engine.ts';
import { noteLowball, regardBps } from './regard.ts';

/**
 * Rule haggling (no model): "3 ore for 5.8" or "5.8 for ore". At or above the market price the
 * NPC sells (as many as asked and held, 1 by default); below it, a counter-offer.
 */
export function rulesHaggle(v: Village, npc: NpcId, message: string, playerId?: string): { reply: string; deal?: { item: ItemId; qty: number; price: Gold } } {
  const def = NPC_DEFS[npc];
  const item: ItemId | undefined = def.produces[0];
  if (!item) return { reply: `${def.name}: "I move goods when the world price gap is wide enough."` };
  // what this NPC remembers about the player moves its price: regulars pay less, lowballers more
  const reg = playerId ? regardBps(v, npc, playerId) : { bps: 0, why: '' };
  const mid = Math.round(midPrice(item, v.s.market.stock[item]) * (1 + reg.bps / 10_000));
  const nums = [...message.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const qtyMatch = new RegExp(`(\\d+)\\s*(?:x\\s*)?${item}`, 'i').exec(message);
  const qty = qtyMatch ? Math.max(1, Math.min(12, Number(qtyMatch[1]))) : 1;
  const priceNum = nums.find((n) => !qtyMatch || n !== Number(qtyMatch[1])) ?? 0;
  const offer = Math.round(priceNum * 100);
  const held = v.s.npcs[npc].stock[item];
  if (playerId && offer > 0 && offer < Math.round(mid * 0.85)) noteLowball(v, npc, playerId);
  const remark = reg.bps < 0 ? ' For you, a regular, a little off.' : reg.bps > 0 ? " After those lowball offers, I'm not giving you a discount." : '';
  if (offer >= Math.round(mid * 0.97) && offer > 0) {
    if (held <= 0) return { reply: `${def.name}: "${fmt(offer)} is fair, but I'm out of ${item} right now. Try me later today."` };
    const q = Math.min(qty, held);
    return { reply: `${def.name}: "${fmt(offer)} for ${q} ${item}? Deal."`, deal: { item, qty: q, price: offer } };
  }
  return {
    reply: offer
      ? `${def.name}: "${fmt(offer)} is too low. ${fmt(Math.round(mid * 1.03))} per ${item}, and it's yours.${remark}"`
      : `${def.name}: "Today ${item} goes for about ${fmt(Math.round(mid * 1.03))}. Make me an offer, like '3 ${item} for ${fmt(Math.round(mid * 1.03))}'."`,
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

