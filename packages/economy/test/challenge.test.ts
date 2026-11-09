import { describe, expect, it } from 'vitest';
import { Challenge, replayChallenge, negotiateContractRules, RULES, NPCS, g, type ChallengeLevel, type WorldDay } from '../src/index.ts';
import replay from '../../../data/world/replay-kansas-heatwave.json' with { type: 'json' };

const days = (replay as unknown as { days: WorldDay[] }).days;

/** play a round with a strategy called before every hour */
function play(level: ChallengeLevel, strategy: (c: Challenge) => void) {
  const c = new Challenge(level, days);
  while (!c.over) {
    strategy(c);
    c.step();
  }
  return c;
}

const buyEarlyDeliver = (c: Challenge) => {
  if (c.v.s.tick !== c.startTick) return;
  c.act({ type: 'market_buy', item: 'wheat', qty: c.spec.contract.qty, maxPrice: g(100) });
  c.deliver();
};
const speculate = (c: Challenge) => {
  if (c.v.s.tick === c.startTick) {
    const q = c.spec.contract.qty;
    c.act({ type: 'market_buy', item: 'wheat', qty: Math.max(q, Math.floor((c.player.gold - g(20)) / 230)), maxPrice: g(100) });
    c.deliver();
  }
  if (c.v.s.tick === c.startTick + 24 + 9 && c.player.stock.wheat) c.act({ type: 'market_sell', item: 'wheat', qty: c.player.stock.wheat, minPrice: 1 });
};
const buyLate = (c: Challenge) => {
  if (c.v.s.tick !== c.startTick + 24 + 8) return;
  c.act({ type: 'market_buy', item: 'wheat', qty: c.spec.contract.qty, maxPrice: g(100) });
  c.deliver();
};

describe('3-day harvest challenge', () => {
  it('has more than one winning plan, with a clear gap between them', () => {
    for (const level of ['easy', 'normal'] as const) {
      const a = play(level, buyEarlyDeliver).result();
      const b = play(level, speculate).result();
      expect(a.verdict).toBe('win');
      expect(b.verdict).toBe('win');
      expect(b.score - a.score).toBeGreaterThan(3);
    }
  });

  it('loses with a reason when the contract is not kept, or bought after the blight', () => {
    const idle = play('normal', () => {}).result();
    expect(idle.verdict).toBe('lose');
    expect(idle.reasons.join(' ')).toMatch(/contract was not kept/);
    const late = play('normal', buyLate).result();
    expect(late.verdict).toBe('lose');
    expect(late.reasons.join(' ')).toMatch(/goal was/);
    expect(late.decisions.join(' ')).toMatch(/after the blight/);
  });

  it('hard needs more than the contract', () => {
    expect(play('hard', buyEarlyDeliver).result().verdict).toBe('lose');
    expect(play('hard', speculate).result().verdict).toBe('win');
  });

  it('replays exactly: same seed and moves give the same score', () => {
    for (const s of [buyEarlyDeliver, speculate, buyLate]) {
      const c = play('normal', s);
      const r = c.result();
      expect(replayChallenge('normal', days, c.moves)).toEqual(r);
    }
  });

  it('keeps every coin accounted for', () => {
    const c = play('hard', speculate);
    const v = c.v;
    const L = v.s.ledger;
    const genesis = RULES.treasuryStart + NPCS.reduce((s, id) => s + (id === 'bruno' ? g(400) : RULES.npcStartGold), 0);
    expect(v.goldSupply()).toBe(genesis + L.faucets.exports + L.faucets.adventurers + L.faucets.quests + L.faucets.signup - (L.sinks.feeBurn + L.sinks.imports + L.sinks.upkeep));
  });
});

describe('negotiating the contract', () => {
  it('a negotiated price changes the payout, stays in the band, and replays without asking again', () => {
    const c = new Challenge('normal', days);
    const [lo, hi] = c.contractRange();
    expect(c.setContractPrice(hi + 50, 'NEAR AI Cloud', 'too much').ok).toBe(false);
    expect(c.setContractPrice(hi, 'NEAR AI Cloud', 'You drive a hard bargain.').ok).toBe(true);
    expect(c.setContractPrice(lo, 'rules', 'again').ok).toBe(false); // once per round
    while (!c.over) {
      buyEarlyDeliver(c);
      c.step();
    }
    const r = c.result();
    expect(r.decisions.join(' ')).toMatch(/negotiated .* \(NEAR AI Cloud/);
    expect(replayChallenge('normal', days, c.moves)).toEqual(r);
    const plain = play('normal', buyEarlyDeliver).result();
    expect(r.profit).toBeGreaterThan(plain.profit);
  });

  it('rules meet a pitch in the band halfway', () => {
    const r = negotiateContractRules(210, 'I can do 2.80');
    expect(r.price).toBe(Math.round((280 + 252) / 2));
    expect(negotiateContractRules(210, 'give me 9.99').price).toBe(252);
  });
});

