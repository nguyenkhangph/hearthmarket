import { describe, expect, it } from 'vitest';
import { createVillage, dealPairs, g, HOME, negotiateRules, NPCS, priceWhy, regardBps, rulesHaggle, RULES, type Village } from '@hearth/economy';

const genesis = () => RULES.treasuryStart + NPCS.reduce((s, id) => s + (id === 'bruno' ? g(400) : RULES.npcStartGold), 0);
const gap = (v: Village) => {
  const L = v.s.ledger;
  return v.goldSupply() - (genesis() + L.faucets.exports + L.faucets.adventurers + L.faucets.quests + L.faucets.signup - (L.sinks.feeBurn + L.sinks.imports + L.sinks.upkeep));
};

/** Morning deals the way the guest village makes them (rules) or the server does (LLM). */
function strikeDeals(v: Village) {
  for (const p of dealPairs()) {
    const r = negotiateRules(v, p);
    v.setDeal({ ...p, agreed: r.agreed, price: r.price, maxQty: r.maxQty, by: 'rules', rounds: r.rounds });
  }
}

describe('agents negotiate on the map', () => {
  it('sellers walk to the buyer at 7:00 and the first delivery settles there, at the agreed price', () => {
    const v = createVillage({ seed: 11 });
    const runTo = (h: number) => { while (v.hour !== h) v.step(); };
    v.runDays(1);
    runTo(0);
    // make sure Theo needs ore and timber today, and the sellers have it
    v.s.npcs.theo.stock.ore = 0;
    v.s.npcs.theo.stock.timber = 0;
    v.s.market.stock.tools = 2;
    v.s.npcs.mike.stock.ore = 20;
    v.s.npcs.jack.stock.timber = 20;
    strikeDeals(v);
    const agreed = (v.s.deals ?? []).filter((d) => d.day === v.day && d.status === 'agreed' && d.buyer === 'theo');
    expect(agreed.length).toBeGreaterThan(0);
    const before = v.s.txs.length;
    runTo(7);
    // the hire happened at 7:00, before the 8:00 market run
    const hires = v.s.txs.slice(before).filter((t) => t.method === 'hire' && t.signer === 'theo.hearthmarket.testnet');
    expect(hires.length).toBeGreaterThan(0);
    for (const d of agreed) if (d.used) expect(hires.some((t) => t.args.price === d.price)).toBe(true);
    // the sellers stand beside Theo's workshop
    const [hx, hy] = HOME.theo;
    for (const d of agreed) {
      const n = v.s.npcs[d.seller];
      expect(Math.abs(n.x - hx) + Math.abs(n.y - hy)).toBeLessThanOrEqual(2);
    }
    // and go home after the meeting
    runTo(11);
    expect([v.s.npcs.mike.x, v.s.npcs.mike.y]).toEqual(HOME.mike);
    expect(gap(v)).toBe(0);
  });

  it('a long run with morning deals keeps every coin accounted for', () => {
    const v = createVillage({ seed: 3 });
    for (let d = 0; d < 40; d++) {
      while (v.hour !== 0) v.step();
      strikeDeals(v);
      v.step();
    }
    expect(gap(v)).toBe(0);
  });
});

describe('why an NPC asks its price', () => {
  it('explains every NPC from the engine numbers', () => {
    const v = createVillage({ seed: 5 });
    v.runDays(2);
    strikeDeals(v);
    for (const id of NPCS) {
      const w = priceWhy(v, id);
      expect(w.head.length).toBeGreaterThan(10);
      expect(w.lines.length).toBeGreaterThan(0);
    }
    expect(priceWhy(v, 'mike').lines.join(' ')).toMatch(/Market holds \d+ ore/);
    expect(priceWhy(v, 'theo').lines.join(' ')).toMatch(/inputs .* sells for/);
    expect(priceWhy(v, 'bruno').lines.join(' ')).toMatch(/landed/);
    expect(priceWhy(v, 'theo').lines.join(' ')).toMatch(/Deal today|No deal today/);
  });

  it('names the plan the brain chose', () => {
    const v = createVillage({ seed: 5 });
    v.runDays(1);
    v.setPlan('mike', { sellShare: 0.5, floorPct: 90 }, 'near-ai (test)', 'ore is scarce, hold out');
    expect(priceWhy(v, 'mike').lines.join(' ')).toMatch(/Today's plan \(near-ai\): sell 50% of surplus, floor 90% of mid, because "ore is scarce/);
  });
});

describe('NPCs remember players', () => {
  it('regulars get a discount, repeated lowballers pay more, and the tooltip says why', () => {
    const v = createVillage({ seed: 4 });
    v.runDays(1);
    v.addPlayer('khang', 'Khang');
    v.addPlayer('lan', 'Lan');
    const ask = (pid: string) => Number(/(\d+(?:\.\d+)?) per ore/.exec(rulesHaggle(v, 'mike', '1 ore for 0.5', pid).reply)?.[1]);
    const fresh = ask('khang');
    for (let i = 0; i < 3; i++) v.sellToPlayer('mike', 'khang', 'ore', 1, Math.round(fresh * 100));
    expect(regardBps(v, 'mike', 'khang').bps).toBeLessThan(0);
    expect(ask('khang')).toBeLessThan(fresh);
    for (let i = 0; i < 3; i++) rulesHaggle(v, 'mike', '1 ore for 0.5', 'lan');
    expect(regardBps(v, 'mike', 'lan').bps).toBeGreaterThan(0);
    expect(priceWhy(v, 'mike', 'khang').lines.join(' ')).toMatch(/Mike remembers 3 trades/);
  });
});
