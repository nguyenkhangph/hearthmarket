import {
  DEAL_MAX_ROUNDS, NPC_DEFS, dealPairs, fmt, itemUse, midPrice,
  type DealRound, type ItemId, type NpcId, type Village,
} from '@hearth/economy';
import type { ChatMessage, LlmClient } from './llm.ts';

/**
 * Agent-to-agent negotiation. Each morning (at most once per `everyMs` per pair) a buyer and
 * a seller agree on a unit price for the day: with an LLM, each agent gets its own prompt
 * (its personality, its books, its memory) and they exchange offers for up to three rounds;
 * without one, a rule negotiator does the same with templated words. The engine then uses the
 * agreed price for the buyer's `hire`, which still goes through the guard, the NPC key and the
 * contract. The deal guard (`checkDeal`) keeps prices within a band around the market.
 */
export interface NegotiationResult {
  agreed: boolean;
  price?: number;
  maxQty?: number;
  rounds: DealRound[];
}

interface Pair {
  buyer: NpcId;
  seller: NpcId;
  item: ItemId;
}

const c2g = (c: number) => (c / 100).toFixed(2);
const g2c = (x: unknown) => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : undefined;
};

/** JSON object from a model reply (prose and code fences tolerated). */
export function parseTurn(raw: string): { price?: number; accept: boolean; qty?: number; say: string } {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { accept: false, say: raw.slice(0, 200) };
  try {
    const j = JSON.parse(m[0]) as { price?: unknown; offer?: unknown; counter?: unknown; accept?: unknown; qty?: unknown; say?: unknown };
    return {
      price: g2c(j.price ?? j.offer ?? j.counter),
      accept: j.accept === true,
      qty: Number.isFinite(Number(j.qty)) ? Math.floor(Number(j.qty)) : undefined,
      say: typeof j.say === 'string' ? j.say : '',
    };
  } catch {
    return { accept: false, say: raw.slice(0, 200) };
  }
}

function situation(v: Village, id: NpcId, item: ItemId) {
  const n = v.s.npcs[id];
  const def = NPC_DEFS[id];
  return [
    `You are ${def.name}, the ${def.title.toLowerCase()} of Hearthmarket. Personality: ${def.personality}`,
    `You hold ${fmt(n.gold)} gold, ${n.stock[item]} ${item}. Spent today ${fmt(n.spentToday)} of a ${fmt(def.dailyBudget)} gold budget.`,
    `Village market price for ${item}: ${c2g(midPrice(item, v.s.market.stock[item]))} gold; world price: ${v.s.world.price[item] ? c2g(v.s.world.price[item]!) : 'n/a'}.`,
    `Your memory: ${n.memory.join(' | ') || 'none'}`,
  ].join('\n');
}

export async function negotiateLlm(llm: LlmClient, v: Village, p: Pair): Promise<NegotiationResult> {
  const buyerName = NPC_DEFS[p.buyer].name;
  const sellerName = NPC_DEFS[p.seller].name;
  const rounds: DealRound[] = [];
  const transcript = () => rounds.map((r) => `${NPC_DEFS[r.who].name}: ${r.say}${r.price ? ` [${c2g(r.price)} gold]` : ''}${r.accept ? ' [accepts]' : ''}`).join('\n') || '(nothing yet)';
  const ask = async (who: NpcId, role: string) => {
    const messages: ChatMessage[] = [
      { role: 'system', content: `${situation(v, who, p.item)}\n${role}\nReply with JSON only: {"accept": true|false, "price": <gold per unit, a number>, "qty": <units, buyer only>, "say": "<one short sentence, in character>"}` },
      { role: 'user', content: `Negotiation so far:\n${transcript()}` },
    ];
    return parseTurn(await llm.complete(messages));
  };
  const buyerRole = `You need ${p.item} to make ${itemUse(p.item)}. You are buying from ${sellerName} for today. Offer a price per unit; accept the seller's last price if it is fair. You may not pay more than you can afford.`;
  const sellerRole = `${buyerName} wants to buy your ${p.item} for today. Accept their last offer if it is fair, or counter with your price per unit.`;

  let lastOffer: number | undefined;
  let lastCounter: number | undefined;
  let qty: number | undefined;
  for (let r = 0; r < DEAL_MAX_ROUNDS; r++) {
    const b = await ask(p.buyer, buyerRole);
    qty = b.qty ?? qty;
    if (b.accept && lastCounter) {
      rounds.push({ who: p.buyer, say: b.say, price: lastCounter, accept: true });
      return { agreed: true, price: lastCounter, maxQty: qty, rounds };
    }
    lastOffer = b.price ?? lastOffer;
    rounds.push({ who: p.buyer, say: b.say, price: lastOffer });
    if (!lastOffer) break;
    const s = await ask(p.seller, sellerRole);
    if (s.accept) {
      rounds.push({ who: p.seller, say: s.say, price: lastOffer, accept: true });
      return { agreed: true, price: lastOffer, maxQty: qty, rounds };
    }
    lastCounter = s.price ?? lastCounter;
    rounds.push({ who: p.seller, say: s.say, price: lastCounter });
  }
  return { agreed: false, rounds };
}

/** The same exchange without a model: concessions of 35% per round, templated words. */
export function negotiateRules(v: Village, p: Pair): NegotiationResult {
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

export class Negotiator {
  private last = new Map<string, number>();
  private running = false;
  calls = 0;
  failures = 0;

  constructor(
    private llm: LlmClient | null,
    private opts: { everyMs: number; log?: (line: string) => void; now?: () => number; useModel?: () => boolean },
  ) {}

  /** the model, unless the caller says not now (nobody online: rules are free) */
  private get model(): LlmClient | null {
    return this.llm && (this.opts.useModel?.() ?? true) ? this.llm : null;
  }

  get name() {
    return this.llm ? this.llm.name : 'rules';
  }

  /** Start of a game day: negotiate the pairs that are due. Resolves when done (tests). */
  onNewDay(v: Village): Promise<void> {
    if (this.running) return Promise.resolve();
    const now = (this.opts.now ?? Date.now)();
    const due = dealPairs().filter((p) => {
      const k = `${p.buyer}:${p.seller}:${p.item}`;
      // rules are free: every day; the model only every `everyMs`
      if (this.model && now - (this.last.get(k) ?? -Infinity) < this.opts.everyMs) return false;
      this.last.set(k, now);
      return true;
    });
    if (!due.length) return Promise.resolve();
    this.running = true;
    return this.run(v, due).finally(() => {
      this.running = false;
    });
  }

  private async run(v: Village, pairs: Pair[]) {
    for (const p of pairs) {
      let res: NegotiationResult;
      const model = this.model;
      let by = model ? model.name : 'rules';
      try {
        if (model) {
          this.calls++;
          res = await negotiateLlm(model, v, p);
        } else res = negotiateRules(v, p);
      } catch (e) {
        this.failures++;
        this.opts.log?.(`negotiation ${p.buyer}/${p.seller} ${p.item} failed, using rules: ${(e as Error).message}`);
        res = negotiateRules(v, p);
        by = 'rules (model unavailable)';
      }
      v.setDeal({ ...p, agreed: res.agreed, price: res.price, maxQty: res.maxQty, by, rounds: res.rounds });
    }
  }
}
