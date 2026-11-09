import { ITEM_DEFS, NPC_DEFS, type ItemId } from './defs.ts';
import { askPrice, bidPrice, midPrice } from './market.ts';
import { fmt, type Gold } from './money.ts';
import type { Village } from './engine.ts';
import { netWorth } from './goal.ts';

/**
 * Silas, the AI rival trader. He plays the same game as the player, with the same rules and the
 * same actions: buys goods when the market dips, lists them on the stall board just under the
 * cheapest player listing (so NPCs pick his first), sells to the market when prices run up,
 * snaps up NPC requests he can fill, and takes big orders players leave on the table for a day.
 * Rule-based and deterministic (no random draws), kept off chain, shown beside you on the goal.
 */
export const RIVAL = { id: 'ai-rival', name: 'Silas' } as const;

const TRADED: ItemId[] = ['ore', 'timber', 'wheat', 'bread', 'tools'];
const me = { kind: 'player' as const, id: RIVAL.id };

export const rivalOf = (v: Village) => v.s.players[RIVAL.id];

/** The rival's net worth and its change since a reference point (the player's week start). */
export function rivalWorth(v: Village): Gold {
  return rivalOf(v) ? netWorth(v, RIVAL.id) : 0;
}

/** Called by the engine every hour, after the village's own schedule. */
export function rivalStep(v: Village, hour: number) {
  const r = rivalOf(v);
  if (!r) return;
  switch (hour) {
    case 8: buyTheDip(v); break;
    case 9: listUnderPlayers(v); break;
    case 12: takeBigOrders(v); break;
    case 14: fillRequests(v); break;
    case 15: sellIntoRallies(v); break;
  }
}

const ratio = (v: Village, i: ItemId) => midPrice(i, v.s.market.stock[i]) / ITEM_DEFS[i].base;

/** 8:00: the item furthest under its usual price, a few units, never more than 40% of his gold. */
function buyTheDip(v: Village) {
  const r = rivalOf(v)!;
  const pick = [...TRADED].sort((a, b) => ratio(v, a) - ratio(v, b))[0];
  if (ratio(v, pick) > 0.98 || r.stock[pick] > 10 || r.gold < 2500) return;
  const ask = askPrice(pick, v.s.market.stock[pick]);
  const qty = Math.min(6, Math.floor((r.gold * 0.4) / ask));
  if (qty < 1) return;
  v.act(me, { type: 'market_buy', item: pick, qty, maxPrice: Math.round(ask * 1.05) });
}

/** 9:00: everything he holds goes on the board, 2% under the cheapest player listing of that item. */
function listUnderPlayers(v: Village) {
  const r = rivalOf(v)!;
  // short of cash: what came back unsold goes to the market at 15:00 instead
  if (r.gold < 2000) return;
  const open = v.openListings();
  for (const item of TRADED) {
    const have = Math.min(r.stock[item], 20);
    if (have < 1 || open.some((l) => l.seller === RIVAL.id && l.item === item)) continue;
    const st = v.s.market.stock[item];
    const mid = midPrice(item, st);
    const theirs = open.filter((l) => l.seller !== RIVAL.id && l.item === item).sort((a, b) => a.price - b.price)[0];
    // under the cheapest player, or just under the market's ask for a crafter who needs it
    const price = Math.max(Math.ceil(mid * 0.5), theirs ? Math.round(theirs.price * 0.98) : Math.round(askPrice(item, st) * 0.97));
    // never at a loss to what the market pays right now
    if (price < bidPrice(item, st) * 0.9) continue;
    const res = v.act(me, { type: 'list_item', item, qty: have, price });
    if (res.ok && theirs) {
      const who = v.s.players[theirs.seller]?.name ?? 'a player';
      v.feed('stall', `${RIVAL.name} undercuts ${who}'s ${item}: ${fmt(price, 2)} against ${fmt(theirs.price, 2)}. NPCs take the cheapest first.`);
    }
  }
}

/** 12:00: a big order nobody accepted since yesterday: he takes it and fills it from the market. */
function takeBigOrders(v: Village) {
  const r = rivalOf(v)!;
  for (const o of v.s.requests ?? []) {
    if (o.due === undefined || o.by || o.missed || o.takenBy || v.day > o.due || v.day < o.day + 1) continue;
    const missing = Math.max(0, o.qty - r.stock[o.item]);
    const ask = askPrice(o.item, v.s.market.stock[o.item]);
    if (missing && (missing > v.s.market.stock[o.item] - 2 || ask * missing * 1.1 > r.gold || ask >= o.price)) continue;
    if (!v.act(me, { type: 'accept_request', requestId: o.id }).ok) continue;
    if (missing) v.act(me, { type: 'market_buy', item: o.item, qty: missing, maxPrice: Math.round(ask * 1.1) });
    const done = v.act(me, { type: 'deliver_request', requestId: o.id });
    if (done.ok) v.feed('quest', `${RIVAL.name} took ${NPC_DEFS[o.npc].name}'s big order that nobody wanted and delivered it`);
    return;
  }
}

/** 14:00: one of today's requests he can fill at a profit, before a player does. */
function fillRequests(v: Village) {
  const r = rivalOf(v)!;
  for (const o of v.openRequests()) {
    if (o.due !== undefined) continue;
    const missing = Math.max(0, o.qty - r.stock[o.item]);
    const ask = askPrice(o.item, v.s.market.stock[o.item]);
    if (missing && (ask * 1.03 >= o.price || ask * missing * 1.1 > r.gold * 0.5 || missing > v.s.market.stock[o.item] - 2)) continue;
    if (missing) v.act(me, { type: 'market_buy', item: o.item, qty: missing, maxPrice: Math.round(ask * 1.1) });
    if (v.act(me, { type: 'deliver_request', requestId: o.id }).ok) {
      v.feed('quest', `${RIVAL.name} beat the players to ${NPC_DEFS[o.npc].name}'s request for ${o.qty} ${o.item}`);
      return;
    }
  }
}

/**
 * 15:00: anything he holds (not listed) that now sells well above its usual price goes to the
 * market; and when he is short of cash he sells what came back unsold, at a loss if he must.
 */
function sellIntoRallies(v: Village) {
  const r = rivalOf(v)!;
  const short = r.gold < 2000;
  for (const item of TRADED) {
    if (r.stock[item] < 1 || (!short && ratio(v, item) < 1.06)) continue;
    const bid = bidPrice(item, v.s.market.stock[item]);
    v.act(me, { type: 'market_sell', item, qty: r.stock[item], minPrice: Math.round(bid * 0.95) });
  }
}
