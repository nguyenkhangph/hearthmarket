import { describe, expect, it } from 'vitest';
import { createVillage, NPC_DEFS, NPCS, RULES, g, type Village } from '@hearth/economy';
import { Game } from '../src/game.ts';
import { NpcBrain } from '../src/brain/brain.ts';
import { ChainMirror } from '../src/chain/mirror.ts';
import { MockChain, NpcSigner } from '../src/chain/signer.ts';
import type { LlmClient } from '../src/brain/llm.ts';

const genesis = () => RULES.treasuryStart + NPCS.reduce((s, id) => s + (id === 'bruno' ? g(400) : RULES.npcStartGold), 0);
const gap = (v: Village) => {
  const L = v.s.ledger;
  return v.goldSupply() - (genesis() + L.faucets.exports + L.faucets.adventurers + L.faucets.quests + L.faucets.signup - (L.sinks.feeBurn + L.sinks.imports + L.sinks.upkeep));
};

describe('daily NPC requests', () => {
  it('posts requests every morning and pays the first player who delivers', () => {
    const v = createVillage({ seed: 5 });
    v.addPlayer('khang', 'Khang');
    v.addPlayer('lan', 'Lan');
    v.runDays(1);
    const open = v.openRequests();
    expect(open.length).toBeGreaterThan(0);
    const r = open[0];
    const p = v.s.players.khang;
    p.stock[r.item] = r.qty;
    const gold0 = p.gold;
    const npcGold0 = v.s.npcs[r.npc].gold;
    const out = v.act({ kind: 'player', id: 'khang' }, { type: 'deliver_request', requestId: r.id });
    expect(out.ok).toBe(true);
    expect(p.gold - gold0).toBe(r.price * r.qty + r.bonus);
    expect(npcGold0 - v.s.npcs[r.npc].gold).toBe(r.price * r.qty);
    expect(p.stock[r.item]).toBe(0);
    expect(p.badges?.map((b) => b.title)).toContain(`Friend of ${NPC_DEFS[r.npc].name}`);
    // first come: a second player cannot deliver the same request
    v.s.players.lan.stock[r.item] = r.qty;
    expect(v.act({ kind: 'player', id: 'lan' }, { type: 'deliver_request', requestId: r.id }).ok).toBe(false);
    expect(gap(v)).toBe(0);
  });

  it('refuses a delivery without the goods, and expires requests at the next day', () => {
    const v = createVillage({ seed: 5 });
    v.addPlayer('khang', 'Khang');
    v.runDays(1);
    const r = v.openRequests()[0];
    expect(v.act({ kind: 'player', id: 'khang' }, { type: 'deliver_request', requestId: r.id }).ok).toBe(false);
    v.runDays(1);
    v.s.players.khang.stock[r.item] = r.qty;
    expect(v.act({ kind: 'player', id: 'khang' }, { type: 'deliver_request', requestId: r.id }).ok).toBe(false);
  });

  it('settles on chain with relay_deliver_request once the contract is version 4', async () => {
    const chain = new MockChain();
    const m = new ChainMirror(chain, { contract: 'hearth.testnet', operator: 'hearth.testnet', playerAccount: (id) => `p-${id}.testnet`, maxPerMinute: 1000 });
    const llm: LlmClient = { name: 'none', complete: async () => '{}' };
    const game = new Game({ seed: 5, mirror: m }, new NpcBrain(llm), new NpcSigner(chain, 'hearth.testnet'), chain);
    game.join('khang', 'Khang');
    game.village.runDays(1);
    await m.idle();
    const send = async (version: number) => {
      m.contractVersion = version;
      const r = game.village.openRequests()[0];
      game.village.s.players.khang.stock[r.item] = r.qty;
      expect(game.act('khang', { type: 'deliver_request', requestId: r.id }).ok).toBe(true);
      await m.idle();
      return r;
    };
    await send(3);
    expect(chain.calls.some((c) => c.method === 'relay_deliver_request')).toBe(false);
    const r = await send(4);
    const call = chain.calls.find((c) => c.method === 'relay_deliver_request')!;
    expect(call.args).toMatchObject({ player: 'p-khang.testnet', npc: NPC_DEFS[r.npc].account, item: r.item, qty: r.qty, price: r.price, bonus: String(r.bonus) });
  });
});

describe('swarm: Bruno bids against the producer for raw-goods orders', () => {
  it('when the world is cheaper, Bruno imports and fills the order; gold stays accounted', () => {
    const v = createVillage({ seed: 9 });
    v.addPlayer('khang', 'Khang');
    v.s.world.price.ore = g(3); // world ore far below the village price
    v.s.npcs.mike.stock.ore = 0;
    const r = v.act({ kind: 'player', id: 'khang' }, { type: 'place_order', item: 'ore', qty: 3, maxPrice: g(9), deadlineDays: 2 });
    expect(r.ok).toBe(true);
    while (v.hour !== 10) v.step();
    expect(v.s.players.khang.stock.ore).toBe(3);
    const fill = v.s.txs.find((t) => t.method === 'fill_order')!;
    expect(fill.signer).toBe(NPC_DEFS.bruno.account);
    expect(v.s.txs.some((t) => t.method === 'world_import' && t.signer === NPC_DEFS.bruno.account)).toBe(true);
    expect(v.s.feed.some((f) => /Auction for Khang's 3 ore: .*Bruno wins/.test(f.text))).toBe(true);
    expect(gap(v)).toBe(0);
  });
});

describe('red team badge', () => {
  it('the first blocked attack earns the "Red Teamer" badge, once', async () => {
    const chain = new MockChain();
    const llm: LlmClient = { name: 'none', complete: async () => '{}' };
    const game = new Game({ seed: 1 }, new NpcBrain(llm), new NpcSigner(chain, 'hearth.testnet'), chain);
    game.join('khang', 'Khang');
    const a = await game.redTeam(0, 'p-khang.testnet', { playerId: 'khang' });
    expect(a.blocked).toBe(true);
    expect(a.badge).toBe(true);
    const b = await game.redTeam(1, 'p-khang.testnet', { playerId: 'khang' });
    expect(b.badge).toBe(false);
    expect(game.village.s.players.khang.badges?.filter((x) => x.title === 'Red Teamer')).toHaveLength(1);
  });
});

describe('big orders (promises)', () => {
  const bigOrder = (v: Village) => (v.s.requests ?? []).find((r) => r.due !== undefined && !r.by && !r.missed);

  it('must be accepted first, by one player, and a kept promise counts twice', () => {
    const v = createVillage({ seed: 5 });
    v.addPlayer('khang', 'Khang');
    v.addPlayer('lan', 'Lan');
    let r = bigOrder(v);
    for (let i = 0; i < 6 && !r; i++) { v.runDays(1); r = bigOrder(v); }
    expect(r).toBeTruthy();
    const order = r!;
    expect(order.due! - order.day).toBe(RULES.bigOrderDays - 1);
    v.s.players.khang.stock[order.item] = order.qty;
    expect(v.act({ kind: 'player', id: 'khang' }, { type: 'deliver_request', requestId: order.id }).ok).toBe(false); // not accepted
    expect(v.act({ kind: 'player', id: 'khang' }, { type: 'accept_request', requestId: order.id }).ok).toBe(true);
    expect(v.act({ kind: 'player', id: 'lan' }, { type: 'accept_request', requestId: order.id }).ok).toBe(false);
    v.runDays(1); // still open the next day
    const npcGold = v.s.npcs[order.npc].gold;
    v.s.npcs[order.npc].spentToday = 0;
    const out = v.act({ kind: 'player', id: 'khang' }, { type: 'deliver_request', requestId: order.id });
    expect(out.ok).toBe(true);
    expect(npcGold - v.s.npcs[order.npc].gold).toBe(order.price * order.qty);
    expect(v.s.regard![order.npc]!.khang.delivered).toBe(2);
    expect(gap(v)).toBe(0);
  });

  it('a broken promise is remembered and raises that NPC\'s prices for the player', async () => {
    const { regardBps } = await import('@hearth/economy');
    const v = createVillage({ seed: 5 });
    v.addPlayer('khang', 'Khang');
    let r = bigOrder(v);
    for (let i = 0; i < 6 && !r; i++) { v.runDays(1); r = bigOrder(v); }
    expect(v.act({ kind: 'player', id: 'khang' }, { type: 'accept_request', requestId: r!.id }).ok).toBe(true);
    v.runDays(RULES.bigOrderDays + 1);
    expect(r!.missed).toBe(true);
    const reg = regardBps(v, r!.npc, 'khang');
    expect(reg.bps).toBeGreaterThan(0);
    expect(reg.why).toMatch(/promised and never brought/);
    expect(v.s.feed.some((e) => e.text.includes('is upset'))).toBe(true);
    v.s.players.khang.stock[r!.item] = r!.qty;
    expect(v.act({ kind: 'player', id: 'khang' }, { type: 'deliver_request', requestId: r!.id }).ok).toBe(false);
  });
});
