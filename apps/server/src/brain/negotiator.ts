import {
  DEAL_MAX_ROUNDS, NPC_DEFS, dealPairs, fmt, itemUse, midPrice, negotiateRules,
  type DealRound, type ItemId, type NpcId, type Village,
} from '@hearth/economy';
import { extractJson, shortReason, type ChatMessage, type LlmClient } from './llm.ts';

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
  const parsed = extractJson(raw);
  if (!parsed) return { accept: false, say: raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().slice(0, 200) };
  try {
    const j = parsed as { price?: unknown; offer?: unknown; counter?: unknown; accept?: unknown; qty?: unknown; say?: unknown };
    return {
      price: g2c(j.price ?? j.offer ?? j.counter),
      accept: j.accept === true,
      qty: Number.isFinite(Number(j.qty)) ? Math.floor(Number(j.qty)) : undefined,
      say: typeof j.say === 'string' ? j.say.trim().slice(0, 200) : '',
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
      { role: 'system', content: `${situation(v, who, p.item)}\n${role}\nReply with JSON only: {"accept": true|false, "price": <gold per unit, a number>, "qty": <units, buyer only>, "say": "<one short sentence, in character>"}. "say" is required and must not be empty.` },
      { role: 'user', content: `Negotiation so far:\n${transcript()}` },
    ];
    const t = parseTurn(await llm.complete(messages));
    // a silent turn still shows what was offered, marked as such (never invented words)
    if (!t.say) t.say = t.accept ? '(accepts, no words)' : t.price ? `(offers ${c2g(Math.round(t.price))}, no words)` : '(no words)';
    return t;
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

export { negotiateRules } from '@hearth/economy';

/** Where each deal's words came from, since the server started (dashboard: "llm vs rules"). */
export interface DealSources {
  model: number;
  rules: number;
  /** the model failed or timed out, rules stepped in (labelled "rules (model unavailable)") */
  fallback: number;
}

export class Negotiator {
  /** last time each pair negotiated with the model (rules days do not count) */
  private lastModel = new Map<string, number>();
  private running = false;
  calls = 0;
  failures = 0;
  /** when the model last struck a deal (ISO), for the health check */
  lastModelAt: string | null = null;
  readonly sources: DealSources = { model: 0, rules: 0, fallback: 0 };

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

  /**
   * Start of a game day: every pair strikes a deal. A pair whose last model negotiation is at
   * least `everyMs` old (and someone is online) uses the model; the others use the rules, and
   * the deal says so. Rules days never delay the next model negotiation.
   * Resolves when done (tests).
   */
  onNewDay(v: Village): Promise<void> {
    if (this.running) return Promise.resolve();
    const now = (this.opts.now ?? Date.now)();
    const model = this.model;
    const plan = dealPairs().map((p) => {
      const k = `${p.buyer}:${p.seller}:${p.item}`;
      const useModel = !!model && now - (this.lastModel.get(k) ?? -Infinity) >= this.opts.everyMs;
      if (useModel) this.lastModel.set(k, now);
      return { p, useModel };
    });
    this.running = true;
    return this.run(v, plan, model).finally(() => {
      this.running = false;
    });
  }

  private async run(v: Village, plan: { p: Pair; useModel: boolean }[], model: LlmClient | null) {
    const day = v.day;
    // pairs negotiate side by side, so model deals land early in the morning (sellers walk over at 6:00)
    await Promise.all(plan.map(async ({ p, useModel }) => {
      let res: NegotiationResult;
      let by = 'rules';
      try {
        if (useModel && model) {
          this.calls++;
          res = await negotiateLlm(model, v, p);
          by = model.name;
          this.sources.model++;
          this.lastModelAt = new Date().toISOString();
        } else {
          res = negotiateRules(v, p);
          this.sources.rules++;
        }
      } catch (e) {
        this.failures++;
        this.sources.fallback++;
        this.opts.log?.(`negotiation ${p.buyer}/${p.seller} ${p.item} failed, using rules: ${(e as Error).message}`);
        res = negotiateRules(v, p);
        by = `rules (model unavailable: ${shortReason(e)})`;
      }
      // a model reply that arrives after the day turned is too late for that day
      if (v.day !== day) return;
      v.setDeal({ ...p, agreed: res.agreed, price: res.price, maxQty: res.maxQty, by, rounds: res.rounds });
    }));
  }
}
