import { ITEM_DEFS, ITEMS, RULES, type ItemId } from './defs.ts';
import { bps, clamp, type Gold } from './money.ts';
import type { Inventory } from './types.ts';

/**
 * Village market maker. The price of an item depends only on how much of it
 * the market holds relative to a target: scarce -> expensive, glut -> cheap.
 * Bruno links this curve to the world price by importing and exporting.
 */
export function midPrice(item: ItemId, stock: number): Gold {
  const d = ITEM_DEFS[item];
  const ratio = (d.target + 5) / (Math.max(0, stock) + 5);
  const f = clamp(Math.pow(ratio, RULES.priceElasticity), RULES.priceFloor, RULES.priceCeil);
  return Math.round(d.base * f);
}

export const askPrice = (item: ItemId, stock: number): Gold => Math.round(midPrice(item, stock - 1) * (1 + RULES.spreadBps / 20_000));
export const bidPrice = (item: ItemId, stock: number): Gold => Math.round(midPrice(item, stock + 1) * (1 - RULES.spreadBps / 20_000));

/** Total cost to buy `qty` units, walking the curve one unit at a time (excluding fee). */
export function quoteBuy(item: ItemId, stock: number, qty: number): { total: Gold; last: Gold } {
  let total = 0;
  let last = 0;
  for (let i = 0; i < qty; i++) {
    last = askPrice(item, stock - i);
    total += last;
  }
  return { total, last };
}

/** Total proceeds for selling `qty` units (excluding fee). */
export function quoteSell(item: ItemId, stock: number, qty: number): { total: Gold; last: Gold } {
  let total = 0;
  let last = 0;
  for (let i = 0; i < qty; i++) {
    last = bidPrice(item, stock + i);
    total += last;
  }
  return { total, last };
}

export const fee = (amount: Gold): Gold => bps(amount, RULES.feeBps);

export function emptyInventory(): Inventory {
  return Object.fromEntries(ITEMS.map((i) => [i, 0])) as Inventory;
}

export function initialMarketStock(): Inventory {
  const inv = emptyInventory();
  for (const i of ITEMS) inv[i] = ITEM_DEFS[i].target;
  return inv;
}

/** Village price index, day-1 reference prices = 100. */
export function priceIndex(prices: Record<ItemId, Gold>): number {
  let s = 0;
  for (const i of ITEMS) s += prices[i] / ITEM_DEFS[i].base;
  return (s / ITEMS.length) * 100;
}
