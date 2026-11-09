import { describe, expect, it } from 'vitest';
import { createVillage, g, NPCS, RULES, type Village } from '../src/index.ts';

const genesis = () => RULES.treasuryStart + NPCS.reduce((s, id) => s + (id === 'bruno' ? g(400) : RULES.npcStartGold), 0);
const gap = (v: Village) => {
  const L = v.s.ledger;
  return v.goldSupply() - (genesis() + L.faucets.exports + L.faucets.adventurers + L.faucets.quests + L.faucets.signup - (L.sinks.feeBurn + L.sinks.imports + L.sinks.upkeep));
};
const me = { kind: 'player' as const, id: 'khang' };
const runTo = (v: Village, h: number) => { do v.step(); while (v.hour !== h); };

function village() {
  const v = createVillage({ seed: 12 });
  v.runDays(1);
  runTo(v, 7);
  v.addPlayer('khang', 'Khang');
  // goods the player got from a delivery earlier: move them out of the market so supply stays counted
  v.s.players.khang.stock.ore = 6;
  return v;
}

describe('hired stall keeper', () => {
  it('a quick keeper sells to Bruno at 11:00, takes 5%, and reports at 20:00 with its reasoning', () => {
    const v = village();
    const r = v.act(me, { type: 'hire_keeper', npc: 'buba', item: 'ore', qty: 6, strategy: 'quick' });
    expect(r.ok).toBe(true);
    const job = v.s.keepers![0];
    const l = v.s.listings!.find((x) => x.id === job.listingId)!;
    expect(l.keeper).toBe(job.id);
    expect(v.s.players.khang.stock.ore).toBe(0);
    const gold0 = v.s.players.khang.gold, buba0 = v.s.npcs.buba.gold;
    runTo(v, 21);
    expect(l.status).toBe('sold');
    const total = l.price * l.qty;
    const c = Math.round((total * RULES.keeperCommissionBps) / 10_000);
    expect(v.s.players.khang.gold - gold0).toBe(total - c);
    expect(v.s.npcs.buba.gold - buba0).toBeGreaterThanOrEqual(c - g(5)); // Buba also eats, trades
    expect(job.status).toBe('done');
    expect(job.reports.at(-1)!.text).toMatch(/Buba: sold 6 ore .* to Bruno\. Price: .*Bruno pays.*All sold/);
    expect(gap(v)).toBe(0);
  });

  it('only one keeper at a time, never Bruno, and dismissing brings the goods back', () => {
    const v = village();
    expect(v.act(me, { type: 'hire_keeper', npc: 'bruno', item: 'ore', qty: 2, strategy: 'hold' }).ok).toBe(false);
    expect(v.act(me, { type: 'hire_keeper', npc: 'chloe', item: 'ore', qty: 9, strategy: 'hold' }).ok).toBe(false);
    expect(v.act(me, { type: 'hire_keeper', npc: 'chloe', item: 'ore', qty: 3, strategy: 'hold' }).ok).toBe(true);
    expect(v.act(me, { type: 'hire_keeper', npc: 'jack', item: 'ore', qty: 3, strategy: 'hold' }).ok).toBe(false);
    const job = v.s.keepers![0];
    expect(v.act(me, { type: 'dismiss_keeper', id: job.id }).ok).toBe(true);
    expect(v.s.players.khang.stock.ore).toBe(6);
    expect(job.status).toBe('done');
  });

  it('a holding keeper reprices daily and closes after its days, returning what is left', () => {
    const v = village();
    v.s.players.khang.stock.sword = 2;
    expect(v.act(me, { type: 'hire_keeper', npc: 'jack', item: 'sword', qty: 2, strategy: 'wait' }).ok).toBe(true);
    const job = v.s.keepers![0];
    v.runDays(RULES.keeperDays + 1);
    expect(job.status).toBe('done');
    expect(job.sold + v.s.players.khang.stock.sword).toBe(2);
    expect(job.reports.length).toBeGreaterThan(2);
    expect(v.openListings().filter((l) => l.keeper === job.id)).toHaveLength(0);
    expect(gap(v)).toBe(0);
  });
});
