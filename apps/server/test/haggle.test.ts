import { describe, expect, it } from 'vitest';
import { createVillage, midPrice, rulesHaggle, NPC_DEFS, NPCS, RULES, g, type Village } from '@hearth/economy';
import { Game } from '../src/game.ts';
import { NpcBrain, parseProposal } from '../src/brain/brain.ts';
import { ChainMirror } from '../src/chain/mirror.ts';
import { MockChain, NpcSigner } from '../src/chain/signer.ts';
import type { ChatMessage, LlmClient } from '../src/brain/llm.ts';

const genesis = () => RULES.treasuryStart + NPCS.reduce((s, id) => s + (id === 'bruno' ? g(400) : RULES.npcStartGold), 0);
const gap = (v: Village) => {
  const L = v.s.ledger;
  return v.goldSupply() - (genesis() + L.faucets.exports + L.faucets.adventurers + L.faucets.quests + L.faucets.signup - (L.sinks.feeBurn + L.sinks.imports + L.sinks.upkeep));
};

describe('haggling a sale with an NPC', () => {
  it('rules: an offer at the market price buys the goods through an order the NPC fills', () => {
    const v = createVillage({ seed: 3 });
    v.addPlayer('khang', 'Khang');
    v.s.npcs.mike.stock.ore = 6;
    const price = Math.round(midPrice('ore', v.s.market.stock.ore) * 1.02);
    const r = rulesHaggle(v, 'mike', `3 ore for ${(price / 100).toFixed(2)}`);
    expect(r.deal).toEqual({ item: 'ore', qty: 3, price });
    const gold0 = v.s.players.khang.gold;
    const sale = v.sellToPlayer('mike', 'khang', 'ore', 3, price);
    expect(sale.ok).toBe(true);
    expect(v.s.players.khang.stock.ore).toBe(3);
    expect(v.s.npcs.mike.stock.ore).toBe(3);
    expect(gold0 - v.s.players.khang.gold).toBeGreaterThanOrEqual(3 * price); // price + fee
    const fill = v.s.txs.find((t) => t.method === 'fill_order' && t.signer === NPC_DEFS.mike.account);
    expect(fill?.args).toMatchObject({ qty: 3, price });
    expect(gap(v)).toBe(0);
  });

  it('a low offer gets a counter-offer, not a sale', () => {
    const v = createVillage({ seed: 3 });
    expect(rulesHaggle(v, 'mike', '1 ore for 0.5').deal).toBeUndefined();
  });

  it('refuses sales outside the band, beyond stock, or of goods the NPC does not make', () => {
    const v = createVillage({ seed: 3 });
    v.addPlayer('khang', 'Khang');
    v.s.npcs.mike.stock.ore = 2;
    const mid = midPrice('ore', v.s.market.stock.ore);
    expect(v.sellToPlayer('mike', 'khang', 'ore', 1, mid * 5).ok).toBe(false);
    expect(v.sellToPlayer('mike', 'khang', 'ore', 5, mid).ok).toBe(false);
    expect(v.sellToPlayer('mike', 'khang', 'wheat', 1, mid).ok).toBe(false);
    expect(v.s.players.khang.stock.ore).toBe(0);
  });

  it('a model\'s deal reaches the chain: the relayed order lands before the NPC fills it', async () => {
    const chain = new MockChain();
    const order: string[] = [];
    const call = chain.call.bind(chain);
    chain.call = async (signer, contract, method, args) => {
      if (method === 'relay_place_order') await new Promise((r) => setTimeout(r, 30));
      order.push(method);
      return call(signer, contract, method, args);
    };
    const m = new ChainMirror(chain, { contract: 'hearth.testnet', operator: 'hearth.testnet', playerAccount: (id) => `p-${id}.testnet`, maxPerMinute: 1000 });
    const llm: LlmClient = { name: 'scripted', complete: async (_m: ChatMessage[]) => JSON.stringify({ reply: 'Fine, 2 ore at that.', action: null, deal: { item: 'ore', qty: 2, price: 0 } }) };
    const game = new Game({ seed: 3, mirror: m }, new NpcBrain(llm), new NpcSigner(chain, 'hearth.testnet'), chain);
    game.join('khang', 'Khang');
    game.village.s.npcs.mike.stock.ore = 5;
    const price = Math.round(midPrice('ore', game.village.s.market.stock.ore));
    (llm as { complete: LlmClient['complete'] }).complete = async () => JSON.stringify({ reply: 'Fine.', deal: { item: 'ore', qty: 2, price } });
    const out = await game.haggle('mike', 'two ore please', undefined, 'khang');
    expect(out.deal).toMatchObject({ ok: true, qty: 2, price });
    await m.idle();
    expect(order.indexOf('relay_place_order')).toBeLessThan(order.indexOf('fill_order'));
    const fill = chain.calls.find((c) => c.method === 'fill_order')!;
    const place = chain.calls.find((c) => c.method === 'relay_place_order')!;
    expect(fill.args.order_id).toBe(place.args.order_id);
    expect(fill.signer).toBe(NPC_DEFS.mike.account);
  });

  it('reads a deal from model JSON and ignores malformed ones', () => {
    expect(parseProposal('{"reply":"ok","deal":{"item":"ore","qty":2,"price":590}}').deal).toEqual({ item: 'ore', qty: 2, price: 590 });
    expect(parseProposal('{"reply":"ok","deal":{"item":"gold","qty":2,"price":590}}').deal).toBeUndefined();
  });
});
