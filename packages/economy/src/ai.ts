import { ITEMS, NPCS, RULES, type ItemId, type NpcId } from './defs.ts';
import { g, type Gold } from './money.ts';
import { askPrice, bidPrice, midPrice } from './market.ts';
import { Rng } from './rng.ts';
import type { Village } from './engine.ts';
import type { Guild } from './types.ts';

/**
 * Four AI guilds play like people so the market and the ranking are never empty.
 * They use only the public actions a human player has, through `village.act`.
 * Bot players (simulation report) do small, plausible things every day.
 */
export function aiDriver(seed = 7) {
  const rng = new Rng(seed);
  return (v: Village) => {
    for (const gl of Object.values(v.s.guilds)) {
      if (!gl.ai) continue;
      const actor = { kind: 'guild' as const, id: gl.id, by: gl.leader };
      try {
        switch (gl.strategy) {
          case 'trader': trader(v, gl, actor); break;
          case 'orderer': orderer(v, gl, actor, rng); break;
          case 'investor': investor(v, gl, actor); break;
          case 'stallkeeper': stallkeeper(v, gl, actor); break;
        }
      } catch {
        /* an AI guild never crashes the village */
      }
    }
    for (const p of Object.values(v.s.players)) {
      if (!p.bot || p.id.startsWith('ai-')) continue;
      if (!rng.chance(0.3)) continue;
      botPlayer(v, p.id, rng);
    }
  };
}

type GuildActor = { kind: 'guild'; id: string; by: string };

/** Buys what the world says will get scarce, sells when the village catches up. */
function trader(v: Village, gl: Guild, actor: GuildActor) {
  const st = v.s.market.stock;
  for (const item of ITEMS) {
    const held = gl.stock[item];
    if (held > 0) {
      const bid = bidPrice(item, st[item]);
      const basis = gl.costBasis[item] ?? bid;
      const age = v.day - (gl.stockSince[item] ?? v.day);
      if (bid > basis * 1.04 || age >= 3) v.act(actor, { type: 'market_sell', item, qty: held, minPrice: 0 });
    }
  }
  for (const r of v.s.world.regions) {
    if (r.item === 'shipping') continue;
    const item = r.item as ItemId;
    const world = v.s.world.price[item] ?? 0;
    const ask = askPrice(item, st[item]);
    const rising = r.impact > 0.02 || !!r.forecast;
    if (rising && world > ask && gl.stock[item] === 0 && gl.fund > g(60)) {
      const qty = Math.min(10, Math.floor((gl.fund * 0.25) / ask), st[item] - 5);
      if (qty > 0) v.act(actor, { type: 'market_buy', item, qty, maxPrice: Math.round(ask * 1.1) });
    }
  }
}

/** Orders swords and tools below market, resells what arrives. */
function orderer(v: Village, gl: Guild, actor: GuildActor, rng: Rng) {
  const st = v.s.market.stock;
  for (const item of ['sword', 'tools'] as ItemId[]) {
    const held = gl.stock[item];
    if (held > 0) {
      const bid = bidPrice(item, st[item]);
      if (bid >= (gl.costBasis[item] ?? 0) * 1.03 || v.day - (gl.stockSince[item] ?? v.day) >= 4) {
        v.act(actor, { type: 'market_sell', item, qty: held, minPrice: 0 });
      }
    }
  }
  const open = v.s.orders.filter((o) => o.status === 'open' && o.by.id === gl.id).length;
  if (open < 2 && gl.fund > g(80)) {
    const item: ItemId = rng.chance(0.6) ? 'sword' : 'tools';
    const maxPrice = Math.round(midPrice(item, st[item]) * 1.0);
    v.act(actor, { type: 'place_order', item, qty: rng.int(2, 4), maxPrice, deadlineDays: 2 });
  }
}

/** Invests in the NPC with the best recent profit, every 3 days. */
function investor(v: Village, gl: Guild, actor: GuildActor) {
  if (v.day % 3 !== 1) return;
  const best = (NPCS.filter((n) => n !== 'bruno') as NpcId[])
    .map((id) => ({ id, p: v.s.npcs[id].lastProfit }))
    .sort((a, b) => b.p - a.p)[0];
  if (best && best.p > 0 && gl.fund > g(50)) {
    v.act(actor, { type: 'invest', npc: best.id, amount: Math.round(gl.fund * 0.2) });
  }
}

/** Runs a bread and wheat stall just inside the market spread. */
function stallkeeper(v: Village, gl: Guild, actor: GuildActor) {
  let st = v.s.stalls.find((s) => s.guild === gl.id);
  if (!st) {
    const free = v.s.stalls.find((s) => !s.guild);
    if (!free) return;
    if (!v.act(actor, { type: 'rent_stall', slot: free.slot }).ok) return;
    st = free;
  }
  const ms = v.s.market.stock;
  for (const item of ['bread', 'wheat'] as ItemId[]) {
    const ask = askPrice(item, ms[item]);
    const bid = bidPrice(item, ms[item]);
    const fund: Gold = st.funded < g(120) && gl.fund > g(80) ? g(40) : 0;
    v.act(actor, {
      type: 'set_stall_prices', slot: st.slot, item,
      buy: Math.round(bid * 1.01), sell: Math.round(ask * 0.985), fund,
    });
  }
}

function botPlayer(v: Village, id: string, rng: Rng) {
  const p = v.s.players[id];
  const actor = { kind: 'player' as const, id };
  const st = v.s.market.stock;
  const roll = rng.next();
  if (roll < 0.3) {
    const item: ItemId = rng.pick(['wheat', 'bread', 'ore', 'timber'] as ItemId[]);
    const qty = rng.int(1, 3);
    if (st[item] > qty + 3) v.act(actor, { type: 'market_buy', item, qty, maxPrice: Math.round(askPrice(item, st[item]) * 1.2) });
  } else if (roll < 0.55) {
    const held = ITEMS.filter((i) => p.stock[i] > 0);
    if (held.length) {
      const item = rng.pick(held);
      v.act(actor, { type: 'market_sell', item, qty: p.stock[item], minPrice: 0 });
    }
  } else if (roll < 0.7) {
    const item: ItemId = rng.pick(['sword', 'tools', 'bread'] as ItemId[]);
    v.act(actor, { type: 'place_order', item, qty: 1, maxPrice: Math.round(midPrice(item, st[item]) * 1.05), deadlineDays: 2 });
  } else if (roll < 0.8) {
    const npc = rng.pick(['mike', 'jack', 'buba', 'chloe', 'theo'] as NpcId[]);
    if (p.gold > g(15)) v.act(actor, { type: 'invest', npc, amount: g(rng.int(5, 10)) });
  } else if (p.guild && p.gold > g(20)) {
    v.act(actor, { type: 'deposit', amount: g(5) });
  }
}

export const DEFAULT_RULES = RULES;
