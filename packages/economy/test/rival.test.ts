import { describe, expect, it } from 'vitest';
import { createVillage, g, goalView, midPrice, NPCS, RIVAL, RULES, type Village } from '../src/index.ts';

const genesis = () => RULES.treasuryStart + NPCS.reduce((s, id) => s + (id === 'bruno' ? g(400) : RULES.npcStartGold), 0);
const gap = (v: Village) => {
  const L = v.s.ledger;
  return v.goldSupply() - (genesis() + L.faucets.exports + L.faucets.adventurers + L.faucets.quests + L.faucets.signup - (L.sinks.feeBurn + L.sinks.imports + L.sinks.upkeep));
};
const runTo = (v: Village, h: number) => { do v.step(); while (v.hour !== h); };

describe('Silas, the AI rival', () => {
  it('plays the same game over two weeks, keeps every coin accounted for, and is deterministic', () => {
    const run = () => {
      const v = createVillage({ seed: 31, rival: true });
      v.addPlayer('khang', 'Khang');
      v.runDays(14);
      return v;
    };
    const a = run(), b = run();
    expect(gap(a)).toBe(0);
    const methods = new Set(a.s.txs.filter((t) => t.signer.startsWith(RIVAL.id)).map((t) => t.method));
    expect(methods.size).toBeGreaterThan(1);
    expect(JSON.stringify(a.s.players[RIVAL.id])).toBe(JSON.stringify(b.s.players[RIVAL.id]));
    // no quests, no goal of his own
    expect(a.s.players[RIVAL.id].goal).toBeUndefined();
    expect(a.s.feed.some((e) => e.text.includes('completed') && e.text.includes(RIVAL.name))).toBe(false);
  });

  it('undercuts a player listing by 2%, and the NPC buys his first', () => {
    const v = createVillage({ seed: 31, rival: true });
    v.runDays(1);
    runTo(v, 7);
    v.addPlayer('khang', 'Khang');
    const silas = v.s.players[RIVAL.id];
    // both hold ore; the player lists a little under the market
    v.s.players.khang.stock.ore = 4;
    silas.stock.ore += 4;
    const mid = midPrice('ore', v.s.market.stock.ore);
    expect(v.act({ kind: 'player', id: 'khang' }, { type: 'list_item', item: 'ore', qty: 4, price: Math.round(mid * 0.9) }).ok).toBe(true);
    runTo(v, 10);
    const his = v.openListings().find((l) => l.seller === RIVAL.id && l.item === 'ore');
    const mine = v.openListings().find((l) => l.seller === 'khang')!;
    expect(his).toBeTruthy();
    expect(his!.price).toBeLessThan(mine.price);
    expect(v.s.feed.some((e) => e.text.includes('undercuts Khang'))).toBe(true);
  });

  it('the week goal compares your gain with his', () => {
    const v = createVillage({ seed: 31, rival: true });
    v.runDays(1);
    v.addPlayer('khang', 'Khang');
    v.runDays(2);
    const gv = goalView(v, 'khang')!;
    expect(gv.rival?.name).toBe(RIVAL.name);
    expect(typeof gv.rival?.gain).toBe('number');
    v.runDays(6);
    expect(goalView(v, 'khang')!.over).toBe(true);
    expect(v.s.feed.some((e) => /finished the week .* (ahead of|behind) Silas/.test(e.text))).toBe(true);
  });

  it('is off unless asked for', () => {
    const v = createVillage({ seed: 31 });
    expect(v.s.players[RIVAL.id]).toBeUndefined();
  });
});
