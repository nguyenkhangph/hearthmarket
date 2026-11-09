import { describe, expect, it } from 'vitest';
import { createVillage, economyHealth } from '../src/index.ts';

describe('economy health', () => {
  it('reads stable over a normal fortnight and names its biggest faucet and sink', () => {
    const v = createVillage({ seed: 7 });
    v.runDays(16);
    const h = economyHealth(v.s.dailyStats);
    expect(h.status).toBe('stable');
    expect(h.text).toMatch(/gold in vs .* out/);
    expect(h.seasons.length).toBeGreaterThanOrEqual(1);
    expect(h.topFaucet).toBeTruthy();
  });

  it('warns about inflation when gold supply jumps', () => {
    const v = createVillage({ seed: 7 });
    v.runDays(8);
    const st = structuredClone(v.s.dailyStats);
    const last = st.at(-1)!;
    last.goldSupply = Math.round(st[st.length - 8].goldSupply * 1.2);
    last.ledger.faucets.exports += 100_000;
    const h = economyHealth(st);
    expect(h.status).toBe('inflation');
    expect(h.text).toMatch(/Inflation warning: .*Bruno exports/);
  });
});
