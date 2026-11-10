import { describe, expect, it } from 'vitest';
import { COUNCIL_EVERY, councilInForce, createVillage, g, NPCS, RIVAL, RULES, tally, type Village } from '../src/index.ts';

const genesis = () => RULES.treasuryStart + NPCS.reduce((s, id) => s + (id === 'bruno' ? g(400) : RULES.npcStartGold), 0);
const gap = (v: Village) => {
  const L = v.s.ledger;
  return v.goldSupply() - (genesis() + L.faucets.exports + L.faucets.adventurers + L.faucets.quests + L.faucets.signup - (L.sinks.feeBurn + L.sinks.imports + L.sinks.upkeep));
};
const me = { kind: 'player' as const, id: 'khang' };
const runTo = (v: Village, h: number) => { do v.step(); while (v.hour !== h); };

function village() {
  const v = createVillage({ seed: 17, rival: true, social: true });
  v.addPlayer('khang', 'Khang');
  return v;
}

describe('village council', () => {
  it('every third day a motion comes up, NPCs vote by interest with a reason, players swing it at 20:00', () => {
    const v = village();
    while (v.day % COUNCIL_EVERY !== 0 || !v.s.council?.length) v.runDays(1);
    runTo(v, 1);
    const m = v.s.council!.at(-1)!;
    expect(m.status).toBe('open');
    const npcVotes = m.votes.filter((x) => x.kind === 'npc');
    expect(npcVotes).toHaveLength(6);
    for (const x of npcVotes) expect(x.why.length).toBeGreaterThan(5);
    expect(new Set(npcVotes.map((x) => x.vote)).size).toBeGreaterThan(1); // interests split
    expect(m.votes.some((x) => x.who === RIVAL.id)).toBe(true);
    // the player's vote counts, and can be changed until 20:00
    const before = tally(m);
    expect(v.act(me, { type: 'council_vote', id: m.id, yes: true }).ok).toBe(true);
    expect(tally(m).yes).toBe(before.yes + 1);
    expect(v.act(me, { type: 'council_vote', id: m.id, yes: false }).ok).toBe(true);
    expect(tally(m).yes).toBe(before.yes);
    runTo(v, 21);
    expect(['passed', 'failed']).toContain(m.status);
    expect(v.act(me, { type: 'council_vote', id: m.id, yes: true }).ok).toBe(false);
    expect(v.s.feed.some((e) => e.text.startsWith('Council passes') || e.text.startsWith('Council rejects'))).toBe(true);
  });

  it('a passed motion takes effect for two days: Bruno stops exporting wheat', () => {
    const v = village();
    while (!(v.s.council ?? []).some((m) => m.kind === 'no_wheat_export')) v.runDays(1);
    const m = v.s.council!.find((x) => x.kind === 'no_wheat_export')!;
    runTo(v, 1);
    // every player votes yes; with Chloe that is enough against Buba and Bruno when Silas also says yes
    for (let i = 0; i < 3; i++) { v.addPlayer(`p${i}`, `P${i}`); v.act({ kind: 'player', id: `p${i}` }, { type: 'council_vote', id: m.id, yes: true }); }
    v.act(me, { type: 'council_vote', id: m.id, yes: true });
    runTo(v, 21);
    expect(m.status).toBe('passed');
    v.runDays(1);
    expect(councilInForce(v, 'no_wheat_export')).toBe(true);
    const exports = v.s.txs.filter((t) => t.method === 'world_trade' && t.args.item === 'wheat' && t.args.side === 'export' && Math.floor(t.t / 24) + 1 >= m.from! && Math.floor(t.t / 24) + 1 <= m.to!);
    expect(exports).toHaveLength(0);
    v.runDays(3);
    expect(councilInForce(v, 'no_wheat_export')).toBe(false);
    expect(gap(v)).toBe(0);
  });
});

describe('co-op orders', () => {
  it('players, the producer NPC and Silas fill Bruno\'s caravan; each is paid on delivery and the bonus is split by share', () => {
    const v = village();
    while (!v.openCoop()) v.runDays(1);
    const c = v.openCoop()!;
    expect(c.price).toBeGreaterThan(0);
    runTo(v, 9);
    v.s.players.khang.stock[c.item] = 8;
    const gold0 = v.s.players.khang.gold;
    const r = v.act(me, { type: 'coop_give', id: c.id, qty: 8 });
    expect(r.ok).toBe(true);
    expect(v.s.players.khang.gold - gold0).toBe(c.price * 8);
    expect(v.s.txs.find((t) => t.method === 'deliver_request' && t.args.request_id === c.id)?.args).toMatchObject({ npc: 'bruno.hearthmarket.testnet', qty: 8, price: c.price });
    runTo(v, 14);
    // the producer chipped in, signed by Bruno as a hire
    expect(c.parts.some((p) => p.kind === 'npc')).toBe(true);
    expect(v.s.txs.some((t) => t.method === 'hire' && t.signer === 'bruno.hearthmarket.testnet')).toBe(true);
    // fill the rest
    const left = c.qty - c.parts.reduce((s, p) => s + p.qty, 0);
    if (left > 0) {
      v.s.players.khang.stock[c.item] += left;
      expect(v.act(me, { type: 'coop_give', id: c.id, qty: left }).ok).toBe(true);
    }
    expect(c.status).toBe('filled');
    const mine = c.parts.find((p) => p.id === 'khang')!;
    expect(mine.bonus).toBe(Math.floor((c.bonus * mine.qty) / c.qty));
    expect(v.act(me, { type: 'coop_give', id: c.id, qty: 1 }).ok).toBe(false);
    expect(gap(v)).toBe(0);
  });

  it('a long run with council and caravans keeps every coin accounted for and is deterministic', () => {
    const run = () => { const v = village(); v.runDays(24); return v; };
    const a = run(), b = run();
    expect(gap(a)).toBe(0);
    expect((a.s.council ?? []).length).toBeGreaterThan(3);
    expect((a.s.coops ?? []).length).toBeGreaterThan(2);
    expect(JSON.stringify(a.s.council)).toBe(JSON.stringify(b.s.council));
    expect(JSON.stringify(a.s.coops)).toBe(JSON.stringify(b.s.coops));
  });
});

describe('co-op orders when Bruno is short', () => {
  it('a smaller caravan rather than none', () => {
    const v = createVillage({ seed: 17, rival: true, social: true });
    v.addPlayer('khang', 'Khang');
    while (v.day % 4 !== 1) v.runDays(1);
    while (v.hour !== 23) v.step();
    v.s.npcs.bruno.gold = g(90); // conservation is not checked here
    v.step(); // day start: the caravan is posted
    const c = v.openCoop();
    expect(c).toBeTruthy();
    expect(c!.qty).toBeLessThan(30);
    expect(c!.qty).toBeGreaterThanOrEqual(12);
  });
});
