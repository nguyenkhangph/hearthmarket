import { ITEM_DEFS, NPC_DEFS, RECIPES, type ItemId, type NpcId } from './defs.ts';
import type { Gold } from './money.ts';
import { midPrice } from './market.ts';
import type { Village } from './engine.ts';

/**
 * Deals between NPC agents. A buyer and a seller negotiate a unit price for the day (with
 * an LLM on the server, or by rules); the engine then uses that price when the buyer hires
 * the seller. The money still moves only through `hire`, which the spending guard, the NPC's
 * key and the contract check like any other spend. A deal can only set a price and a
 * quantity, inside bounds around the market price.
 */
export interface DealRound {
  who: NpcId;
  /** what the agent said, in character */
  say: string;
  /** offer (buyer) or counter-offer (seller), centigold per unit */
  price?: Gold;
  accept?: boolean;
}

export interface Deal {
  id: number;
  day: number;
  buyer: NpcId;
  seller: NpcId;
  item: ItemId;
  status: 'agreed' | 'no-deal';
  /** agreed unit price, centigold */
  price?: Gold;
  /** most units the buyer may hire at this price today */
  maxQty: number;
  /** units hired so far under this deal */
  used: number;
  by: string;
  rounds: DealRound[];
  /** what the deal guard changed or refused */
  guard: string[];
}

/** Agreed prices must stay within this band around the market mid price. */
export const DEAL_BAND = { min: 0.6, max: 1.6 } as const;
export const DEAL_MAX_QTY = 12;
export const DEAL_MAX_ROUNDS = 3;

/** Who buys what from whom: crafters buy raw goods from their producers. */
export function dealPairs(): { buyer: NpcId; seller: NpcId; item: ItemId }[] {
  const out: { buyer: NpcId; seller: NpcId; item: ItemId }[] = [];
  const crafters: Record<string, NpcId> = { bread: 'chloe', tools: 'theo', sword: 'theo' };
  const seen = new Set<string>();
  for (const [product, inputs] of Object.entries(RECIPES)) {
    const buyer = crafters[product];
    if (!buyer) continue;
    for (const item of Object.keys(inputs ?? {}) as ItemId[]) {
      const seller = (Object.keys(NPC_DEFS) as NpcId[]).find((id) => NPC_DEFS[id].produces.includes(item));
      const key = `${buyer}:${seller}:${item}`;
      if (seller && seller !== buyer && !seen.has(key)) {
        seen.add(key);
        out.push({ buyer, seller, item });
      }
    }
  }
  return out;
}

/**
 * The deal guard. Turns whatever the negotiators said into a deal the engine can use, or a
 * refusal: integer prices inside the band around the market price, a sane quantity, a
 * buyer and seller that really trade this item.
 */
export function checkDeal(
  input: { buyer: NpcId; seller: NpcId; item: ItemId; price?: number; maxQty?: number; agreed: boolean },
  mid: Gold,
): { ok: true; price: Gold; maxQty: number; notes: string[] } | { ok: false; reason: string } {
  const pair = dealPairs().find((p) => p.buyer === input.buyer && p.seller === input.seller && p.item === input.item);
  if (!pair) return { ok: false, reason: `${input.buyer} does not buy ${input.item} from ${input.seller}` };
  if (!input.agreed) return { ok: false, reason: 'no agreement' };
  const p = Number(input.price);
  if (!Number.isFinite(p) || p <= 0) return { ok: false, reason: 'no valid price' };
  const notes: string[] = [];
  const lo = Math.ceil(mid * DEAL_BAND.min);
  const hi = Math.floor(mid * DEAL_BAND.max);
  let price = Math.round(p);
  if (price < lo || price > hi) {
    return { ok: false, reason: `price ${(price / 100).toFixed(2)} outside ${(lo / 100).toFixed(2)}–${(hi / 100).toFixed(2)} (market ${(mid / 100).toFixed(2)})` };
  }
  let maxQty = Math.floor(Number(input.maxQty ?? DEAL_MAX_QTY));
  if (!Number.isFinite(maxQty) || maxQty < 1) maxQty = 1;
  if (maxQty > DEAL_MAX_QTY) {
    notes.push(`quantity capped at ${DEAL_MAX_QTY}`);
    maxQty = DEAL_MAX_QTY;
  }
  price = Math.max(1, price);
  return { ok: true, price, maxQty, notes };
}

/** Short label of a deal for feeds and diaries. */
export function describeDeal(d: Deal): string {
  const names = `${NPC_DEFS[d.buyer].name} and ${NPC_DEFS[d.seller].name}`;
  return d.status === 'agreed'
    ? `${names} agree ${(d.price! / 100).toFixed(2)} per ${d.item} (up to ${d.maxQty}, ${d.rounds.length} messages, ${d.by})`
    : `${names} find no deal on ${d.item} (${d.by}); ${NPC_DEFS[d.buyer].name} will buy at the market`;
}

/** Raw items a crafter needs per craft of its products, for prompts. */
export function itemUse(item: ItemId): string {
  return Object.entries(RECIPES)
    .filter(([, inputs]) => inputs && item in inputs)
    .map(([p]) => ITEM_DEFS[p as ItemId].name.toLowerCase())
    .join(', ');
}

const c2g = (c: number) => (c / 100).toFixed(2);

/** The same exchange without a model: concessions of 35% per round, templated words. */
export function negotiateRules(v: Village, p: { buyer: NpcId; seller: NpcId; item: ItemId }): { agreed: boolean; price?: number; maxQty?: number; rounds: DealRound[] } {
  const mid = midPrice(p.item, v.s.market.stock[p.item]);
  const seller = v.s.npcs[p.seller];
  const scarcity = p.item === 'ore' ? (1 - seller.mineHealth) * 0.3 : 0;
  let offer = Math.round(mid * 0.92);
  let ask = Math.round(mid * (1.08 + scarcity));
  const rounds: DealRound[] = [];
  const b = NPC_DEFS[p.buyer].name;
  for (let r = 0; r < DEAL_MAX_ROUNDS; r++) {
    rounds.push({ who: p.buyer, price: offer, say: r === 0 ? `${c2g(offer)} a unit for your ${p.item}, ${NPC_DEFS[p.seller].name}?` : `I can go to ${c2g(offer)}.` });
    if (ask - offer <= mid * 0.03) {
      const price = Math.round((offer + ask) / 2);
      rounds.push({ who: p.seller, price, accept: true, say: `Fine, ${c2g(price)} it is.` });
      return { agreed: true, price, maxQty: 12, rounds };
    }
    rounds.push({ who: p.seller, price: ask, say: r === 0 ? `Not under ${c2g(ask)}.` : `${c2g(ask)}, last word.` });
    offer = Math.round(offer + (ask - offer) * 0.35);
    ask = Math.round(ask - (ask - offer) * 0.35);
  }
  const price = Math.round((offer + ask) / 2);
  if (ask - offer <= mid * 0.06) {
    rounds.push({ who: p.buyer, price, accept: true, say: `Meet me in the middle at ${c2g(price)}.` });
    return { agreed: true, price, maxQty: 12, rounds };
  }
  rounds.push({ who: p.buyer, say: `Too steep, ${b} will try the market.` });
  return { agreed: false, rounds };
}

