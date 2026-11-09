import { describe, expect, it } from 'vitest';
import { askPrice, bidPrice, createVillage, g, midPrice, NPCS, RULES, type Village } from '../src/index.ts';

const genesis = () => RULES.treasuryStart + NPCS.reduce((s, id) => s + (id === 'bruno' ? g(400) : RULES.npcStartGold), 0);
const gap = (v: Village) => {
  const L = v.s.ledger;
  return v.goldSupply() - (genesis() + L.faucets.exports + L.faucets.adventurers + L.faucets.quests + L.faucets.signup - (L.sinks.feeBurn + L.sinks.imports + L.sinks.upkeep));
};
const me = { kind: 'player' as const, id: 'khang' };
const runTo = (v: Village, h: number) => { do v.step(); while (v.hour !== h); };

function village() {
  const v = createVillage({ seed: 9 });
  v.runDays(1);
  v.addPlayer('khang', 'Khang');
  v.addPlayer('lan', 'Lan');
  return v;
}

describe('stall board', () => {
  it('escrows the goods, and a player buys the whole listing', () => {
    const v = village();
    v.s.players.khang.stock.ore = 10;
    const mid = midPrice('ore', v.s.market.stock.ore);
    const r = v.act(me, { type: 'list_item', item: 'ore', qty: 4, price: mid });
    expect(r.ok).toBe(true);
    expect(v.s.players.khang.stock.ore).toBe(6);
    const l = v.s.listings![0];
    expect(r.ok && v.s.txs.find((t) => t.hash === r.tx)?.args).toMatchObject({ listing_id: l.id, item: 'ore', qty: 4, price: mid });
    const lanGold = v.s.players.lan.gold, khangGold = v.s.players.khang.gold;
    expect(v.act({ kind: 'player', id: 'khang' }, { type: 'buy_listing', id: l.id }).ok).toBe(false); // own listing
    const b = v.act({ kind: 'player', id: 'lan' }, { type: 'buy_listing', id: l.id });
    expect(b.ok).toBe(true);
    expect(v.s.players.lan.gold).toBe(lanGold - mid * 4);
    expect(v.s.players.khang.gold).toBe(khangGold + mid * 4);
    expect(v.s.players.lan.stock.ore).toBe(4);
    expect(l.status).toBe('sold');
    // sold twice: refused
    expect(v.act({ kind: 'player', id: 'lan' }, { type: 'buy_listing', id: l.id }).ok).toBe(false);
    expect(gap(v)).toBe(0);
  });

  it('refuses bad prices, missing stock and too many listings', () => {
    const v = village();
    v.s.players.khang.stock.wheat = 50;
    const mid = midPrice('wheat', v.s.market.stock.wheat);
    expect(v.act(me, { type: 'list_item', item: 'wheat', qty: 1, price: mid * 3 }).ok).toBe(false);
    expect(v.act(me, { type: 'list_item', item: 'wheat', qty: 1, price: Math.floor(mid * 0.3) }).ok).toBe(false);
    expect(v.act(me, { type: 'list_item', item: 'ore', qty: 1, price: midPrice('ore', v.s.market.stock.ore) }).ok).toBe(false);
    expect(v.act(me, { type: 'list_item', item: 'wheat', qty: 21, price: mid }).ok).toBe(false);
    for (let i = 0; i < RULES.listingsPerPlayer; i++) expect(v.act(me, { type: 'list_item', item: 'wheat', qty: 1, price: mid }).ok).toBe(true);
    expect(v.act(me, { type: 'list_item', item: 'wheat', qty: 1, price: mid }).ok).toBe(false);
  });

  it('only the seller cancels, and the goods come back', () => {
    const v = village();
    v.s.players.khang.stock.timber = 5;
    const mid = midPrice('timber', v.s.market.stock.timber);
    const r = v.act(me, { type: 'list_item', item: 'timber', qty: 5, price: mid });
    const id = v.s.listings![0].id;
    expect(r.ok).toBe(true);
    expect(v.act({ kind: 'player', id: 'lan' }, { type: 'cancel_listing', id }).ok).toBe(false);
    expect(v.act(me, { type: 'cancel_listing', id }).ok).toBe(true);
    expect(v.s.players.khang.stock.timber).toBe(5);
    expect(v.act(me, { type: 'cancel_listing', id }).ok).toBe(false);
  });

  it('NPCs buy a cheap listing (P5b), sign npc_stall_buy, and pay the player', () => {
    const v = village();
    runTo(v, 9);
    v.s.players.khang.stock.ore = 3;
    const bid = bidPrice('ore', v.s.market.stock.ore);
    const price = Math.max(Math.ceil(midPrice('ore', v.s.market.stock.ore) * 0.5), Math.floor(bid * 0.9));
    expect(v.act(me, { type: 'list_item', item: 'ore', qty: 3, price }).ok).toBe(true);
    const gold = v.s.players.khang.gold;
    runTo(v, 12);
    const l = v.s.listings![0];
    expect(l.status).toBe('sold');
    expect(l.buyer?.kind).toBe('npc');
    expect(v.s.players.khang.gold).toBe(gold + price * 3);
    const t = v.s.txs.find((x) => x.method === 'npc_stall_buy');
    expect(t?.args).toMatchObject({ listing_id: l.id, amount: price * 3 });
    expect(v.s.diary.some((d) => d.act.startsWith('npc_stall_buy'))).toBe(true);
    expect(gap(v)).toBe(0);
  });

  it('nobody buys an overpriced listing, and it goes home after the listing days', () => {
    const v = village();
    v.s.players.khang.stock.ore = 2;
    const price = Math.floor(askPrice('ore', v.s.market.stock.ore) * 1.9);
    expect(v.act(me, { type: 'list_item', item: 'ore', qty: 2, price }).ok).toBe(true);
    v.runDays(RULES.listingDays + 1);
    expect(v.s.listings![0].status).toBe('cancelled');
    expect(v.s.players.khang.stock.ore).toBeGreaterThanOrEqual(2);
    expect(gap(v)).toBe(0);
  });

  it('a long run with player listings keeps every coin accounted for and stays deterministic', () => {
    const run = () => {
      const v = createVillage({ seed: 21, botPlayers: 6 });
      v.addPlayer('khang', 'Khang');
      for (let d = 0; d < 20; d++) {
        v.s.players.khang.stock.wheat += 3;
        const mid = midPrice('wheat', v.s.market.stock.wheat);
        v.act(me, { type: 'list_item', item: 'wheat', qty: 3, price: Math.ceil(mid * (0.6 + (d % 5) * 0.2)) });
        v.runDays(1);
      }
      return v;
    };
    const a = run(), b = run();
    expect(gap(a)).toBe(0);
    expect(a.s.listings!.some((l) => l.status === 'sold' && l.buyer?.kind === 'npc')).toBe(true);
    expect(JSON.stringify(a.s.listings)).toBe(JSON.stringify(b.s.listings));
  });
});

describe('stall board input checks', () => {
  it('refuses unknown items and fractional prices', () => {
    const v = village();
    expect(v.act(me, { type: 'list_item', item: 'gems' as never, qty: 1, price: 500 }).ok).toBe(false);
    v.s.players.khang.stock.ore = 2;
    expect(v.act(me, { type: 'list_item', item: 'ore', qty: 1, price: midPrice('ore', v.s.market.stock.ore) + 0.5 }).ok).toBe(false);
    expect(v.s.players.khang.stock.ore).toBe(2);
  });
});
