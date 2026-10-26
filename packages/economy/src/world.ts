import type { ItemId } from './defs.ts';
import { ITEM_DEFS, RULES } from './defs.ts';
import { clamp } from './money.ts';
import { Rng } from './rng.ts';
import type { RegionState, WorldState } from './types.ts';

/**
 * Five real producing regions. Weather there moves world prices; Bruno carries
 * those prices into the village. We use the *deviation from the seasonal normal*,
 * never absolute values, so something interesting happens most days.
 */
export interface Metrics {
  tmax?: number; // daily max temperature, C
  precip?: number; // precipitation, mm (3-day sum)
  wind?: number; // max wind speed, km/h
  gust?: number; // max wind gust, km/h
  wave?: number; // max wave height, m
}

export interface RegionDef {
  id: string;
  name: string;
  item: ItemId | 'shipping';
  lat: number;
  lon: number;
  api: 'forecast' | 'marine';
  event: string;
  /**
   * Seasonal normals for November, averaged over 10 years from the Open-Meteo
   * Historical/Marine APIs (`npm run normals -w @hearth/server -- --from 11-01 --to 11-30 --years 10`).
   * precip = 3-day sum (mm), wind/gust = daily max (km/h), wave = daily max (m).
   */
  normal: Metrics;
  score(m: Metrics, n: Metrics): number;
  describe(m: Metrics, n: Metrics): string;
}

const pos = (v: number) => Math.max(0, v);

export const REGIONS: RegionDef[] = [
  {
    id: 'kansas', name: 'Kansas', item: 'wheat', lat: 38.5, lon: -98.0, api: 'forecast',
    event: 'heat and drought',
    normal: { tmax: 13.51, precip: 4.33, wind: 22.77, gust: 44.9 },
    score: (m, n) => clamp(pos((m.tmax ?? n.tmax!) - n.tmax!) / 8 + pos(n.precip! - (m.precip ?? n.precip!)) / Math.max(n.precip!, 1) * 0.3, 0, 1),
    describe: (m, n) => ((m.tmax ?? 0) - (n.tmax ?? 0) > 3 ? 'heatwave' : 'dry spell'),
  },
  {
    id: 'cantho', name: 'Can Tho', item: 'wheat', lat: 10.03, lon: 105.78, api: 'forecast',
    event: 'heavy rain',
    normal: { tmax: 30.2, precip: 19.67, wind: 14.26, gust: 32.79 },
    score: (m, n) => clamp(pos((m.precip ?? n.precip!) - n.precip!) / 40, 0, 1),
    describe: () => 'heavy rain in the Mekong Delta',
  },
  {
    id: 'kamloops', name: 'Kamloops', item: 'timber', lat: 50.67, lon: -120.33, api: 'forecast',
    event: 'heat and strong wind (fire risk)',
    normal: { tmax: 6.57, precip: 5.47, wind: 9.35, gust: 26.87 },
    score: (m, n) => clamp(pos((m.tmax ?? n.tmax!) - n.tmax!) / 10 * 0.5 + pos((m.wind ?? n.wind!) - n.wind!) / 25 * 0.5, 0, 1),
    describe: () => 'BC dry spell',
  },
  {
    id: 'pilbara', name: 'Port Hedland', item: 'ore', lat: -20.31, lon: 118.58, api: 'forecast',
    event: 'strong gusts (cyclone)',
    normal: { tmax: 34.68, precip: 0.33, wind: 25.8, gust: 47.01 },
    score: (m, n) => clamp(pos((m.gust ?? n.gust!) - n.gust!) / 40, 0, 1),
    describe: (m) => ((m.gust ?? 0) > 90 ? 'cyclone warning at Port Hedland' : 'strong gusts in the Pilbara'),
  },
  {
    id: 'malacca', name: 'Malacca', item: 'shipping', lat: 2.5, lon: 101.0, api: 'marine',
    event: 'high waves',
    normal: { wave: 0.43 },
    score: (m, n) => clamp(pos((m.wave ?? n.wave!) - n.wave!) / 1.8, 0, 1),
    describe: () => 'storm in the Malacca Strait',
  },
];

export interface WorldDay {
  /** per-region metrics for the day */
  metrics: Record<string, Metrics>;
  /** optional 3-day forecast metrics, used for the "forecast" hint */
  forecast?: Record<string, Metrics>;
  source: string;
  fetchedAt?: string;
}

export function initialWorld(): WorldState {
  const price: Partial<Record<ItemId, number>> = {};
  for (const d of Object.values(ITEM_DEFS)) if (d.world) price[d.id] = d.base;
  return {
    day: 0,
    source: 'none',
    regions: REGIONS.map((r) => ({
      id: r.id, name: r.name, item: r.item, severity: 0, headline: 'normal', impact: 0, forecast: '',
    })),
    price,
    shippingBps: RULES.shippingBps,
  };
}

/** Apply one day of real (or replayed, or synthetic) weather to world prices. Pure. */
export function applyWorldDay(prev: WorldState, day: WorldDay, dayIndex: number): WorldState {
  const regions: RegionState[] = REGIONS.map((def) => {
    const old = prev.regions.find((r) => r.id === def.id)!;
    const m = day.metrics[def.id] ?? {};
    const severity = def.score(m, def.normal);
    const impact = clamp(old.impact * RULES.worldImpactDecay + severity * RULES.worldImpactCap * 0.6, -RULES.worldImpactCap, RULES.worldImpactCap);
    let forecast = '';
    const f = day.forecast?.[def.id];
    if (f) {
      const fs = def.score(f, def.normal);
      if (fs > 0.35) forecast = `${def.describe(f, def.normal)} likely in 3 days`;
    }
    return {
      id: def.id, name: def.name, item: def.item, severity,
      headline: severity > 0.25 ? def.describe(m, def.normal) : 'normal',
      impact, forecast,
    };
  });

  const price: Partial<Record<ItemId, number>> = {};
  const impactOf = (item: ItemId) => {
    const rs = regions.filter((r) => r.item === item);
    return clamp(rs.reduce((s, r) => s + r.impact, 0), -RULES.worldImpactCap, RULES.worldImpactCap);
  };
  for (const d of Object.values(ITEM_DEFS)) {
    if (!d.world) continue;
    const imp = d.id === 'tools' ? (impactOf('ore') + impactOf('timber')) / 2 : impactOf(d.id);
    price[d.id] = Math.round(d.base * (1 + imp));
  }
  const ship = regions.find((r) => r.item === 'shipping')!;
  const shippingBps = Math.round(RULES.shippingBps * (1 + ship.impact * 2.5));

  return { day: dayIndex, source: day.source, regions, price, shippingBps };
}

/** Deterministic synthetic weather: normal days with occasional multi-day events. */
export class SyntheticWorld {
  private rng: Rng;
  private active = new Map<string, number>(); // region -> days left
  constructor(seed: number) {
    this.rng = new Rng(seed ^ 0x9e3779b9);
  }
  next(): WorldDay {
    const metrics: Record<string, Metrics> = {};
    const forecast: Record<string, Metrics> = {};
    for (const r of REGIONS) {
      let left = this.active.get(r.id) ?? 0;
      if (left <= 0 && this.rng.chance(0.12)) left = this.rng.int(2, 4);
      const strength = left > 0 ? 0.5 + this.rng.next() * 0.6 : this.rng.next() * 0.15;
      metrics[r.id] = synthMetrics(r, strength, this.rng);
      forecast[r.id] = synthMetrics(r, left > 1 ? strength : 0.1, this.rng);
      this.active.set(r.id, left - 1);
    }
    return { metrics, forecast, source: 'synthetic' };
  }
}

function synthMetrics(r: RegionDef, s: number, rng: Rng): Metrics {
  const n = r.normal;
  const jitter = () => (rng.next() - 0.5) * 2;
  switch (r.id) {
    case 'kansas':
      return { tmax: n.tmax! + s * 10 + jitter(), precip: Math.max(0, n.precip! * (1 - s) + jitter()) };
    case 'cantho':
      return { precip: Math.max(0, n.precip! + s * 45 + jitter() * 3) };
    case 'kamloops':
      return { tmax: n.tmax! + s * 9 + jitter(), wind: n.wind! + s * 22 + jitter() * 2 };
    case 'pilbara':
      return { gust: n.gust! + s * 50 + jitter() * 3 };
    default:
      return { wave: n.wave! + s * 2 + jitter() * 0.1 };
  }
}

/** Replays recorded days in a loop, so a demo always shows the same story. */
export class ReplayWorld {
  private i = 0;
  constructor(private days: WorldDay[]) {
    if (!days.length) throw new Error('replay needs at least one day');
  }
  next(): WorldDay {
    const d = this.days[this.i % this.days.length];
    this.i++;
    return { ...d, source: `replay:${d.source}` };
  }
}
