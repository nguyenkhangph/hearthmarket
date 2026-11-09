import { RULES } from './defs.ts';
import type { DailyStats } from './types.ts';

export interface SeasonRow {
  season: number;
  days: number;
  avgIndex: number;
  endSupply: number;
  supplyChange: number;
}

export interface EconomyHealth {
  status: 'collecting' | 'stable' | 'inflation' | 'deflation';
  /** price index now, day 1 = 100 */
  index: number;
  /** gold supply change over the last (up to) 7 days, as a fraction */
  supplyGrowth7d: number;
  /** gold into and out of the economy over the same window */
  inflow: number;
  outflow: number;
  /** the biggest faucet and the biggest sink in that window */
  topFaucet?: string;
  topSink?: string;
  text: string;
  seasons: SeasonRow[];
}

/**
 * Is the village inflating? From the daily stats the engine already keeps: the price index
 * against day 1, gold supply over the last week, and gold in (faucets) against gold out
 * (sinks). Warns above +10% prices or +8% supply in a week (and the mirror image for deflation).
 */
export function economyHealth(stats: DailyStats[], seasonDays = RULES.seasonDays): EconomyHealth {
  const seasons = seasonRows(stats, seasonDays);
  if (stats.length < 2) {
    return { status: 'collecting', index: 100, supplyGrowth7d: 0, inflow: 0, outflow: 0, text: 'Collecting data: one more game day is needed.', seasons };
  }
  const first = stats[0].priceIndex || 100;
  const last = stats.at(-1)!;
  const index = (last.priceIndex / first) * 100;
  const a = stats[Math.max(0, stats.length - 8)];
  const days = stats.length - 1 - Math.max(0, stats.length - 8);
  const supplyGrowth7d = a.goldSupply ? (last.goldSupply - a.goldSupply) / a.goldSupply : 0;
  const d = (f: (l: DailyStats['ledger']) => number) => f(last.ledger) - f(a.ledger);
  const faucets: [string, number][] = [
    ['Bruno exports', d((l) => l.faucets.exports)],
    ['adventurers', d((l) => l.faucets.adventurers)],
    ['quests and requests', d((l) => l.faucets.quests)],
    ['new players', d((l) => l.faucets.signup)],
  ];
  const sinks: [string, number][] = [
    ['fee burn', d((l) => l.sinks.feeBurn)],
    ['imports', d((l) => l.sinks.imports)],
    ['upkeep', d((l) => l.sinks.upkeep)],
  ];
  const inflow = faucets.reduce((s, [, v]) => s + v, 0);
  const outflow = sinks.reduce((s, [, v]) => s + v, 0);
  const topFaucet = [...faucets].sort((x, y) => y[1] - x[1])[0][0];
  const topSink = [...sinks].sort((x, y) => y[1] - x[1])[0][0];
  const status: EconomyHealth['status'] =
    index > 110 || supplyGrowth7d > 0.08 ? 'inflation' : index < 90 || supplyGrowth7d < -0.08 ? 'deflation' : 'stable';
  const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
  const g = (c: number) => (c / 100).toFixed(0);
  const verdict = status === 'stable'
    ? 'Stable: faucets and sinks roughly balance.'
    : status === 'inflation'
      ? `Inflation warning: more gold is coming in than going out (mostly ${topFaucet}).`
      : `Deflation warning: more gold is leaving than coming in (mostly ${topSink}).`;
  const text = `Prices ${pct(index / 100 - 1)} since day 1; gold supply ${pct(supplyGrowth7d)} over ${days} day${days === 1 ? '' : 's'}; ${g(inflow)} gold in vs ${g(outflow)} out. ${verdict}`;
  return { status, index, supplyGrowth7d, inflow, outflow, topFaucet, topSink, text, seasons };
}

function seasonRows(stats: DailyStats[], seasonDays: number): SeasonRow[] {
  const by = new Map<number, DailyStats[]>();
  for (const s of stats) {
    const k = Math.floor((s.day - 1) / seasonDays) + 1;
    (by.get(k) ?? by.set(k, []).get(k)!).push(s);
  }
  const first = stats[0]?.priceIndex || 100;
  return [...by.entries()].map(([season, rows]) => ({
    season,
    days: rows.length,
    avgIndex: (rows.reduce((t, r) => t + r.priceIndex, 0) / rows.length / first) * 100,
    endSupply: rows.at(-1)!.goldSupply,
    supplyChange: rows[0].goldSupply ? rows.at(-1)!.goldSupply / rows[0].goldSupply - 1 : 0,
  }));
}
