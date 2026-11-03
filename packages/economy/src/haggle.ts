import { NPC_DEFS, type ItemId, type NpcId } from './defs.ts';
import { fmt, type Gold } from './money.ts';
import { midPrice } from './market.ts';
import type { Village } from './engine.ts';

/**
 * Rule haggling (no model): "3 ore for 5.8" or "5.8 for ore". At or above the market price the
 * NPC sells (as many as asked and held, 1 by default); below it, a counter-offer.
 */
export function rulesHaggle(v: Village, npc: NpcId, message: string): { reply: string; deal?: { item: ItemId; qty: number; price: Gold } } {
  const def = NPC_DEFS[npc];
  const item: ItemId | undefined = def.produces[0];
  if (!item) return { reply: `${def.name}: "I move goods when the world price gap is wide enough."` };
  const mid = midPrice(item, v.s.market.stock[item]);
  const nums = [...message.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const qtyMatch = new RegExp(`(\\d+)\\s*(?:x\\s*)?${item}`, 'i').exec(message);
  const qty = qtyMatch ? Math.max(1, Math.min(12, Number(qtyMatch[1]))) : 1;
  const priceNum = nums.find((n) => !qtyMatch || n !== Number(qtyMatch[1])) ?? 0;
  const offer = Math.round(priceNum * 100);
  const held = v.s.npcs[npc].stock[item];
  if (offer >= Math.round(mid * 0.97) && offer > 0) {
    if (held <= 0) return { reply: `${def.name}: "${fmt(offer)} is fair, but I'm out of ${item} right now. Try me later today."` };
    const q = Math.min(qty, held);
    return { reply: `${def.name}: "${fmt(offer)} for ${q} ${item}? Deal."`, deal: { item, qty: q, price: offer } };
  }
  return {
    reply: offer
      ? `${def.name}: "${fmt(offer)} is too low. ${fmt(Math.round(mid * 1.03))} per ${item}, and it's yours."`
      : `${def.name}: "Today ${item} goes for about ${fmt(Math.round(mid * 1.03))}. Make me an offer, like '3 ${item} for ${fmt(Math.round(mid * 1.03))}'."`,
  };
}

