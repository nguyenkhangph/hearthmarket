import { describe, expect, it } from 'vitest';
import {
  createVillage, checkNpcAction, NEAR_CONFIG, setContractAccount, g, NPCS, RULES, NPC_DEFS, Village, midPrice, ITEM_DEFS,
} from '../src/index.ts';

const genesis = () => RULES.treasuryStart + NPCS.reduce((s, id) => s + (id === 'bruno' ? g(400) : RULES.npcStartGold), 0);

function conservationGap(v: Village) {
  const L = v.s.ledger;
  const faucets = L.faucets.exports + L.faucets.adventurers + L.faucets.quests + L.faucets.signup;
  const sinks = L.sinks.feeBurn + L.sinks.imports + L.sinks.upkeep;
  return v.goldSupply() - (genesis() + faucets - sinks);
}

describe('village economy', () => {
  it('is deterministic for a given seed', () => {
    const a = createVillage({ seed: 11, botPlayers: 10 });
    const b = createVillage({ seed: 11, botPlayers: 10 });
    a.runDays(5);
    b.runDays(5);
    expect(JSON.stringify(a.snapshot())).toEqual(JSON.stringify(b.snapshot()));
  });

  it('conserves gold: supply = genesis + faucets - sinks, to the centigold', () => {
    const v = createVillage({ seed: 3, botPlayers: 50 });
    for (let d = 0; d < 30; d++) {
      v.runDays(1);
      expect(conservationGap(v)).toBe(0);
    }
  });

  it('keeps every NPC solvent and prices within a band over 30 days', () => {
    const v = createVillage({ seed: 42, botPlayers: 50 });
    v.runDays(30);
    for (const id of NPCS) expect(v.s.npcs[id].brokeDays).toBeLessThanOrEqual(2);
    for (const d of v.s.dailyStats) {
      expect(d.priceIndex).toBeGreaterThan(80);
      expect(d.priceIndex).toBeLessThan(120);
    }
  });

  it('restores from a snapshot and continues identically', () => {
    const a = createVillage({ seed: 5 });
    a.runDays(3);
    const snap = a.snapshot();
    const b = Village.restore(snap, { seed: 5 });
    expect(b.s.tick).toBe(a.s.tick);
    expect(b.goldSupply()).toBe(a.goldSupply());
  });
});

describe('spending guard (mirrors signer + contract)', () => {
  const CONTRACT = NEAR_CONFIG.contract;
  const base = { contract: CONTRACT, receiver: CONTRACT, spentToday: 0, dailyBudget: g(80) };

  it('refuses transfers out of an NPC account', () => {
    const r = checkNpcAction({ ...base, action: { type: 'transfer', to: 'evil.testnet', amount: g(120) } });
    expect(r.ok).toBe(false);
  });

  it('refuses spending over the daily budget', () => {
    const r = checkNpcAction({ ...base, spentToday: g(42), action: { type: 'market_buy', item: 'ore', qty: 10, maxPrice: g(6) } });
    expect(r.ok).toBe(false);
  });

  it('refuses calls to another contract', () => {
    const r = checkNpcAction({ ...base, receiver: 'other.testnet', action: { type: 'produce' } });
    expect(r.ok).toBe(false);
  });

  it('allows a normal purchase within budget', () => {
    const r = checkNpcAction({ ...base, action: { type: 'market_buy', item: 'ore', qty: 4, maxPrice: g(6.5) } });
    expect(r.ok).toBe(true);
  });

  it('an NPC brain proposing a transfer is blocked and logged in the feed', () => {
    const v = createVillage({ seed: 1 });
    const before = v.s.npcs.theo.gold;
    const r = v.act({ kind: 'npc', id: 'theo' }, { type: 'transfer', to: 'attacker.testnet', amount: g(120) });
    expect(r.ok).toBe(false);
    expect(v.s.npcs.theo.gold).toBe(before);
    expect(v.s.feed.at(-1)?.kind).toBe('blocked');
  });
});

describe('players, orders, guilds', () => {
  it('runs the 4 tutorial quests', () => {
    const v = createVillage({ seed: 9 });
    const me = { kind: 'player' as const, id: 'khang' };
    v.addPlayer('khang', 'khang');
    expect(v.act(me, { type: 'market_buy', item: 'wheat', qty: 3, maxPrice: g(5) }).ok).toBe(true);
    expect(v.act(me, { type: 'place_order', item: 'sword', qty: 1, maxPrice: g(22), deadlineDays: 2 }).ok).toBe(true);
    expect(v.act(me, { type: 'invest', npc: 'buba', amount: g(10) }).ok).toBe(true);
    expect(v.act(me, { type: 'join_guild', guild: 'black-cats' }).ok).toBe(true);
    expect(Object.values(v.s.players.khang.quests).every(Boolean)).toBe(true);
  });

  it('fills an order from escrow and refunds the rest', () => {
    const v = createVillage({ seed: 2 });
    const me = { kind: 'player' as const, id: 'p1' };
    v.addPlayer('p1', 'p1');
    const gold0 = v.s.players.p1.gold;
    v.act(me, { type: 'place_order', item: 'timber', qty: 2, maxPrice: g(6), deadlineDays: 3 });
    v.runDays(2);
    const o = v.s.orders.find((x) => x.by.id === 'p1')!;
    expect(o.status).toBe('filled');
    expect(o.escrow).toBe(0);
    expect(v.s.players.p1.stock.timber).toBe(2);
    expect(v.s.players.p1.gold).toBeGreaterThan(gold0 - 2 * g(6) - g(1));
  });

  it('refunds an order nobody fills by the deadline', () => {
    const v = createVillage({ seed: 2 });
    const me = { kind: 'player' as const, id: 'p2' };
    v.addPlayer('p2', 'p2');
    const gold0 = v.s.players.p2.gold;
    v.act(me, { type: 'place_order', item: 'sword', qty: 1, maxPrice: g(1), deadlineDays: 1 });
    v.runDays(3);
    expect(v.s.players.p2.gold).toBe(gold0 + RULES.questReward); // escrow back + "order a sword" quest
  });

  it('pays the season pool to ranked guilds', () => {
    const v = createVillage({ seed: 4, botPlayers: 20 });
    v.runDays(RULES.seasonDays + 1);
    expect(v.s.lastSeasonResult?.ranking.length).toBeGreaterThan(0);
    expect(v.s.season).toBe(2);
  });

  it('prices rise when the market runs short', () => {
    expect(midPrice('ore', 5)).toBeGreaterThan(midPrice('ore', ITEM_DEFS.ore.target));
    expect(midPrice('ore', 100)).toBeLessThan(midPrice('ore', ITEM_DEFS.ore.target));
  });

  it('each NPC has a NEAR sub-account under hearth', () => {
    for (const id of NPCS) expect(NPC_DEFS[id].account.endsWith('.hearth.testnet')).toBe(true);
  });

  it('can move to another contract account', () => {
    setContractAccount('hearthmarket-demo.testnet');
    expect(NPC_DEFS.theo.account).toBe('theo.hearthmarket-demo.testnet');
    setContractAccount('hearth.testnet');
    expect(() => setContractAccount('Bad Name!')).toThrow();
  });
});
