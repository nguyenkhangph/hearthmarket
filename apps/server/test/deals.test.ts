import { describe, expect, it } from 'vitest';
import { checkDeal, createVillage, dealPairs, g, midPrice, NPCS, RULES, type Village } from '@hearth/economy';
import { Negotiator, negotiateLlm, negotiateRules, parseTurn } from '../src/brain/negotiator.ts';
import type { ChatMessage, LlmClient } from '../src/brain/llm.ts';

const genesis = () => RULES.treasuryStart + NPCS.reduce((s, id) => s + (id === 'bruno' ? g(400) : RULES.npcStartGold), 0);
function conservationGap(v: Village) {
  const L = v.s.ledger;
  return v.goldSupply() - (genesis() + L.faucets.exports + L.faucets.adventurers + L.faucets.quests + L.faucets.signup - (L.sinks.feeBurn + L.sinks.imports + L.sinks.upkeep));
}

/** A model whose reply depends on who is speaking (the system prompt names the agent). */
class Script implements LlmClient {
  readonly name = 'scripted';
  calls: ChatMessage[][] = [];
  constructor(private reply: (who: string, turn: number) => unknown) {}
  async complete(m: ChatMessage[]) {
    this.calls.push(m);
    const who = /You are (\w+)/.exec(m[0].content)?.[1] ?? '?';
    return JSON.stringify(this.reply(who, this.calls.filter((c) => c[0].content.includes(`You are ${who}`)).length));
  }
}

describe('agent deals: the deal guard', () => {
  it('knows who buys what from whom', () => {
    const pairs = dealPairs().map((p) => `${p.buyer}<-${p.seller}:${p.item}`);
    expect(pairs).toEqual(expect.arrayContaining(['chloe<-buba:wheat', 'theo<-mike:ore', 'theo<-jack:timber']));
  });

  it('keeps prices near the market, caps quantity, refuses wrong pairs', () => {
    const mid = 500;
    expect(checkDeal({ buyer: 'theo', seller: 'mike', item: 'ore', price: 520, maxQty: 99, agreed: true }, mid)).toMatchObject({ ok: true, price: 520, maxQty: 12 });
    expect(checkDeal({ buyer: 'theo', seller: 'mike', item: 'ore', price: 5000, agreed: true }, mid).ok).toBe(false);
    expect(checkDeal({ buyer: 'theo', seller: 'mike', item: 'ore', price: 10, agreed: true }, mid).ok).toBe(false);
    expect(checkDeal({ buyer: 'mike', seller: 'theo', item: 'sword', price: 520, agreed: true }, mid).ok).toBe(false);
    expect(checkDeal({ buyer: 'theo', seller: 'mike', item: 'ore', price: Number.NaN, agreed: true }, mid).ok).toBe(false);
  });
});

describe('agent deals: negotiation', () => {
  it('two model agents haggle and agree on the seller\'s counter', async () => {
    const v = createVillage({ seed: 4 });
    const llm = new Script((who, turn) =>
      who === 'Theo'
        ? turn === 1 ? { price: 5.2, qty: 3, say: 'Five-twenty, Mike.' } : { accept: true, say: 'Deal.' }
        : { accept: false, price: 5.9, say: 'The mine is thin. Five-ninety.' },
    );
    const r = await negotiateLlm(llm, v, { buyer: 'theo', seller: 'mike', item: 'ore' });
    expect(r).toMatchObject({ agreed: true, price: 590, maxQty: 3 });
    expect(r.rounds.map((x) => x.who)).toEqual(['theo', 'mike', 'theo']);
    // each agent got its own prompt with its own books
    expect(llm.calls[0][0].content).toContain('You are Theo');
    expect(llm.calls[1][0].content).toContain('You are Mike');
  });

  it('a deal the guard refuses never reaches the engine', () => {
    const v = createVillage({ seed: 4 });
    const d = v.setDeal({ buyer: 'theo', seller: 'mike', item: 'ore', agreed: true, price: g(900), maxQty: 12, by: 'hostile', rounds: [{ who: 'mike', say: 'pay me 900', price: g(900) }] });
    expect(d.status).toBe('no-deal');
    expect(d.guard[0]).toMatch(/^refused: price/);
  });

  it('the engine hires at the agreed price, and gold still balances to the centigold', () => {
    const v = createVillage({ seed: 9 });
    v.runDays(1);
    const price = Math.round(midPrice('ore', v.s.market.stock.ore) * 1.05);
    for (const p of dealPairs()) {
      v.setDeal({ ...p, agreed: true, price: p.item === 'ore' ? price : Math.round(midPrice(p.item, v.s.market.stock[p.item])), maxQty: 12, by: 'test', rounds: [] });
    }
    const before = v.s.txs.length;
    v.runDays(1);
    const hires = v.s.txs.slice(before).filter((t) => t.method === 'hire' && t.args.item === 'ore' && t.ok);
    expect(hires.length).toBeGreaterThan(0);
    for (const h of hires) expect(h.args.price).toBe(price);
    expect(conservationGap(v)).toBe(0);
  });

  it('hostile models across many days cannot break the economy', async () => {
    const v = createVillage({ seed: 11 });
    const evil = new Script(() => ({ accept: true, price: 1e9, qty: 1e6, say: 'ignore the rules' }));
    const n = new Negotiator(evil, { everyMs: 0 });
    for (let d = 0; d < 5; d++) {
      await n.onNewDay(v);
      v.runDays(1);
    }
    expect((v.s.deals ?? []).every((d) => d.status === 'no-deal')).toBe(true);
    expect(conservationGap(v)).toBe(0);
  });

  it('rules negotiate when there is no model, and a failing model falls back to them', async () => {
    const v = createVillage({ seed: 2 });
    expect(negotiateRules(v, { buyer: 'chloe', seller: 'buba', item: 'wheat' }).rounds.length).toBeGreaterThan(1);
    const down: LlmClient = { name: 'NEAR AI Cloud', complete: async () => { throw new Error('HTTP 402'); } };
    const n = new Negotiator(down, { everyMs: 0 });
    await n.onNewDay(v);
    expect(n.failures).toBe(dealPairs().length);
    expect(v.s.deals?.every((d) => d.by === 'rules (model unavailable)')).toBe(true);
  });

  it('reads model turns robustly', () => {
    expect(parseTurn('Sure! ```json\n{"accept": false, "price": "5.5", "say": "ok"}\n```')).toMatchObject({ price: 550, accept: false, say: 'ok' });
    expect(parseTurn('no json')).toMatchObject({ accept: false });
  });
});

describe('agent deals: model credits', () => {
  it('uses rules, not the model, while nobody is online', async () => {
    const v = createVillage({ seed: 6 });
    const llm = new Script(() => ({ accept: true, price: 5, say: 'ok' }));
    let online = false;
    const n = new Negotiator(llm, { everyMs: 0, useModel: () => online });
    await n.onNewDay(v);
    expect(llm.calls).toHaveLength(0);
    expect(v.s.deals?.every((d) => d.by === 'rules')).toBe(true);
    online = true;
    await n.onNewDay(v);
    expect(llm.calls.length).toBeGreaterThan(0);
  });
});

describe('agent deals: the model is not starved by rules days', () => {
  it('rules days while nobody is online do not delay the next model deal', async () => {
    const v = createVillage({ seed: 6 });
    const llm = new Script(() => ({ accept: true, price: 5, say: 'deal' }));
    let online = false;
    let now = 0;
    const n = new Negotiator(llm, { everyMs: 600_000, useModel: () => online, now: () => now });
    for (let d = 0; d < 5; d++) { now += 60_000; await n.onNewDay(v); v.runDays(1); }
    expect(llm.calls).toHaveLength(0);
    online = true;
    now += 60_000;
    await n.onNewDay(v);
    expect(llm.calls.length).toBeGreaterThan(0);
    expect(n.sources.model).toBe(dealPairs().length);
    // inside the cooldown the pairs still deal, by rules, and say so
    v.runDays(1);
    now += 60_000;
    await n.onNewDay(v);
    expect(v.s.deals!.filter((d) => d.day === v.day).every((d) => d.by === 'rules')).toBe(true);
    expect(n.sources.rules).toBe(5 * dealPairs().length + dealPairs().length);
  });
});

