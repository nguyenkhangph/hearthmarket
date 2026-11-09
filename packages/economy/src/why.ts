import { ITEM_DEFS, ITEMS, NPC_DEFS, RECIPE_YIELD, RULES, type ItemId, type NpcId } from './defs.ts';
import { fmt } from './money.ts';
import { bidPrice, midPrice } from './market.ts';
import { describePlan } from './plan.ts';
import type { Village } from './engine.ts';
import { regardBps } from './regard.ts';

/** Why an NPC asks the price it asks today: the inputs its rules and its brain look at. */
export interface PriceWhy {
  /** one line: what the NPC sells and at what price */
  head: string;
  /** the reasons, most important first */
  lines: string[];
}

const pctTxt = (x: number) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`;

function stockLine(v: Village, item: ItemId): string {
  const st = v.s.market.stock[item];
  const d = ITEM_DEFS[item];
  const vsBase = midPrice(item, st) / d.base - 1;
  const state = st < d.target * 0.85 ? 'scarce' : st > d.target * 1.15 ? 'plentiful' : 'about normal';
  return `Market holds ${st} ${item} (usual ${d.target}): ${state}, so the village price is ${pctTxt(vsBase)} vs normal.`;
}

function worldLine(v: Village, item: ItemId): string | undefined {
  if (!ITEM_DEFS[item].world) return undefined;
  const w = v.s.world.price[item];
  if (!w) return undefined;
  const landed = Math.round(w * (1 + v.s.world.shippingBps / 10_000));
  const region = v.s.world.regions.filter((r) => r.item === item).sort((a, b) => b.severity - a.severity)[0];
  const weather = region ? ` ${region.name}: ${region.severity > 0.25 ? region.headline : 'clear weather'}${region.impact ? ` (${pctTxt(region.impact)})` : ''}.` : '';
  return `World ${item} lands at ${fmt(landed)} with shipping.${weather}`;
}

function dealLines(v: Village, id: NpcId): string[] {
  return (v.s.deals ?? [])
    .filter((d) => d.day === v.day && (d.buyer === id || d.seller === id))
    .map((d) => {
      const other = NPC_DEFS[d.buyer === id ? d.seller : d.buyer].name;
      const role = d.buyer === id ? `buys ${d.item} from ${other}` : `sells ${d.item} to ${other}`;
      return d.status === 'agreed'
        ? `Deal today: ${role} at ${fmt(d.price!, 2)} (market ${fmt(midPrice(d.item, v.s.market.stock[d.item]), 2)}, agreed by ${d.by.replace(/ \(.*$/, '')}).`
        : `No deal today: ${role} fell through, so it goes to the market.`;
    });
}

function planLine(v: Village, id: NpcId): string | undefined {
  const p = v.s.npcs[id].plan;
  if (!p) return undefined;
  return `Today's plan (${p.by.replace(/ \(.*$/, '')}): ${describePlan(p)}${p.why ? `, because "${p.why.slice(0, 90)}"` : ''}.`;
}

/**
 * The price reasoning behind an NPC, in plain words, from the same numbers the engine
 * uses: the market curve, the world price and the weather behind it, the NPC's plan dials
 * and today's agent deals. Shown when the player hovers over the NPC.
 */
export function priceWhy(v: Village, id: NpcId, playerId?: string): PriceWhy {
  const def = NPC_DEFS[id];
  const n = v.s.npcs[id];
  const lines: string[] = [];
  let head: string;

  if (id === 'bruno') {
    const band = (n.plan?.bandBps ?? RULES.brunoBandBps) / 100;
    head = `Bruno trades with the world when the gap is over ${band.toFixed(1)}%.`;
    const gaps = ITEMS.filter((i) => ITEM_DEFS[i].world && v.s.world.price[i]).map((i) => {
      const landed = Math.round(v.s.world.price[i]! * (1 + v.s.world.shippingBps / 10_000));
      const bid = bidPrice(i, v.s.market.stock[i]);
      return { i, landed, bid, gap: bid / landed - 1 };
    }).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
    for (const x of gaps.slice(0, 3)) {
      const verdict = x.gap * 100 > band ? 'imports, the world is cheaper' : -x.gap * 100 > band ? 'exports, the village is cheaper' : 'waits, the gap is too small';
      lines.push(`${ITEM_DEFS[x.i].name}: village ${fmt(x.bid)} vs world ${fmt(x.landed)} landed (${pctTxt(x.gap)}): ${verdict}.`);
    }
    const ship = v.s.world.shippingBps / RULES.shippingBps - 1;
    if (Math.abs(ship) > 0.02) lines.push(`Shipping is ${pctTxt(ship)} today, which moves every landed price.`);
  } else if (def.role === 'baker' || def.role === 'smith') {
    head = `${def.name} prices from the cost of inputs.`;
    for (const item of def.produces) {
      const cost = v.unitInputCost(item);
      const sell = bidPrice(item, v.s.market.stock[item]);
      const margin = cost ? sell / cost - 1 : 0;
      lines.push(`${ITEM_DEFS[item].name}: inputs ${fmt(cost)}${(RECIPE_YIELD[item] ?? 1) > 1 ? ` per unit (one craft makes ${RECIPE_YIELD[item]})` : ''}, sells for ${fmt(sell)}: margin ${pctTxt(margin)}${margin < 0.1 ? ', too thin to make more without an order' : ''}.`);
    }
    lines.push(stockLine(v, def.produces[0]));
  } else {
    const item = def.produces[0];
    head = `${def.name} sells ${item} at about ${fmt(midPrice(item, v.s.market.stock[item]))} gold.`;
    lines.push(stockLine(v, item));
    const w = worldLine(v, item);
    if (w) lines.push(w);
    if (id === 'mike' && n.mineHealth < 0.95) lines.push(`The mine is at ${Math.round(n.mineHealth * 100)}%: Mike asks up to ${Math.round((1 - n.mineHealth) * 30)}% more in deals.`);
    if (id === 'buba') {
      const kansas = v.s.world.regions.find((r) => r.id === 'kansas');
      if (kansas && (kansas.impact > 0.03 || kansas.forecast)) lines.push('Kansas wheat is rising, so Buba holds half his wheat back for a better price.');
    }
    if (!n.plan) lines.push(`No plan from the brain today: sells the surplus, never below ${60}% of the village price.`);
  }
  const p = planLine(v, id);
  if (p) lines.push(p);
  lines.push(...dealLines(v, id));
  if (n.hunger > 0) lines.push(`Hungry: gives a little on price for a loaf of bread.`);
  if (playerId && def.produces.length && id !== 'bruno') lines.push(regardBps(v, id, playerId).why);
  return { head, lines };
}
