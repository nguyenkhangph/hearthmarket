import { describe, expect, it } from 'vitest';
import { createVillage, g, GOAL, goalTargets, goalView, netWorth } from '../src/index.ts';

describe('week goal', () => {
  it('starts on join, counts goods at the market price, and locks the stars after 7 days', () => {
    const v = createVillage({ seed: 3 });
    v.runDays(1);
    v.addPlayer('khang', 'Khang');
    const p = v.s.players.khang;
    expect(goalTargets(p.goal!)).toEqual([g(75), g(100), g(150)]);
    let gv = goalView(v, 'khang')!;
    expect(gv.day).toBe(1);
    expect(gv.stars).toBe(0);
    p.stock.sword = 3; // worth counts goods
    expect(netWorth(v, 'khang')).toBeGreaterThan(p.gold);
    p.gold += g(60);
    gv = goalView(v, 'khang')!;
    expect(gv.stars).toBeGreaterThanOrEqual(2);
    v.runDays(GOAL.days);
    gv = goalView(v, 'khang')!;
    expect(gv.over).toBe(true);
    const locked = gv.stars;
    p.gold = 0; // after the week, the result does not move
    expect(goalView(v, 'khang')!.stars).toBe(locked);
    expect(v.s.feed.some((e) => e.text.includes('finished the week'))).toBe(true);
    // a new week starts from today's worth, keeping the best result
    expect(v.act({ kind: 'player', id: 'khang' }, { type: 'start_goal' }).ok).toBe(true);
    expect(v.s.players.khang.goal!.best).toBe(locked);
    expect(goalView(v, 'khang')!.over).toBe(false);
    expect(goalTargets(v.s.players.khang.goal!)[0]).toBe(g(75)); // broke start: floor of 50 gold
  });

  it('bots have no goal', () => {
    const v = createVillage({ seed: 3, botPlayers: 2 });
    expect(Object.values(v.s.players).filter((p) => p.bot).every((p) => !p.goal)).toBe(true);
  });
});
