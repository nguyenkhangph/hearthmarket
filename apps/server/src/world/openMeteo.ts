import { createHash } from 'node:crypto';
import { REGIONS, type Metrics, type WorldDay, type WorldSource } from '@hearth/economy';
import type { WorldPostInput } from '../chain/mirror.ts';

/**
 * Open-Meteo client. Free for non-commercial use, no key, CC BY 4.0 (credit shown in game and README).
 * Two requests per refresh: one forecast request for the four land regions (multi-location),
 * one marine request for the Malacca Strait. Refreshing every 6h is ~8 calls a day.
 *
 * Verify parameter names on https://open-meteo.com/en/docs before relying on them.
 */
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';

interface DailyBlock {
  time: string[];
  [k: string]: (number | null)[] | string[];
}

const num = (a: unknown, i: number): number | undefined => {
  const v = Array.isArray(a) ? a[i] : undefined;
  return typeof v === 'number' ? v : undefined;
};

function toMetrics(d: DailyBlock, day: number): Metrics {
  const precip3 = [0, 1, 2].reduce((s, k) => s + (num(d.precipitation_sum, day + k) ?? 0), 0);
  return {
    tmax: num(d.temperature_2m_max, day),
    precip: precip3,
    wind: num(d.wind_speed_10m_max, day),
    gust: num(d.wind_gusts_10m_max, day),
    wave: num(d.wave_height_max, day),
  };
}

export interface WorldReading {
  day: WorldDay;
  /** the two API responses exactly as received, newline-separated (hashed for the chain) */
  payload: string;
  urls: string[];
}

export async function fetchWorldDay(fetchImpl: typeof fetch = fetch): Promise<WorldDay> {
  return (await fetchWorldReading(fetchImpl)).day;
}

export async function fetchWorldReading(fetchImpl: typeof fetch = fetch): Promise<WorldReading> {
  const land = REGIONS.filter((r) => r.api === 'forecast');
  const sea = REGIONS.filter((r) => r.api === 'marine');
  const qs = new URLSearchParams({
    latitude: land.map((r) => r.lat).join(','),
    longitude: land.map((r) => r.lon).join(','),
    daily: 'temperature_2m_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max',
    forecast_days: '5',
    timezone: 'UTC',
  });
  const mqs = new URLSearchParams({
    latitude: sea.map((r) => r.lat).join(','),
    longitude: sea.map((r) => r.lon).join(','),
    daily: 'wave_height_max',
    forecast_days: '5',
    timezone: 'UTC',
  });
  const urls = [`${FORECAST}?${qs}`, `${MARINE}?${mqs}`];
  const [lr, mr] = await Promise.all(urls.map((u) => fetchImpl(u)));
  if (!lr.ok) throw new Error(`open-meteo forecast ${lr.status}`);
  if (!mr.ok) throw new Error(`open-meteo marine ${mr.status}`);
  const landText = await lr.text();
  const seaText = await mr.text();
  const landJson = JSON.parse(landText);
  const seaJson = JSON.parse(seaText);
  // one location -> object, several -> array
  const landArr: { daily: DailyBlock }[] = Array.isArray(landJson) ? landJson : [landJson];
  const seaArr: { daily: DailyBlock }[] = Array.isArray(seaJson) ? seaJson : [seaJson];

  const metrics: Record<string, Metrics> = {};
  const forecast: Record<string, Metrics> = {};
  land.forEach((r, i) => {
    metrics[r.id] = toMetrics(landArr[i].daily, 0);
    forecast[r.id] = toMetrics(landArr[i].daily, 2);
  });
  sea.forEach((r, i) => {
    metrics[r.id] = toMetrics(seaArr[i].daily, 0);
    forecast[r.id] = toMetrics(seaArr[i].daily, 2);
  });
  return { day: { metrics, forecast, source: 'open-meteo', fetchedAt: new Date().toISOString() }, payload: `${landText}\n${seaText}`, urls };
}

const r1 = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 10) / 10);

/** Compact reading for the chain: today's metrics per region, one decimal. */
export function compactReading(day: WorldDay): string {
  const out: Record<string, Record<string, number>> = {};
  for (const [id, m] of Object.entries(day.metrics)) {
    const o: Record<string, number> = {};
    for (const [k, v] of Object.entries(m)) if (typeof v === 'number') o[k] = r1(v)!;
    out[id] = o;
  }
  return JSON.stringify({ at: day.fetchedAt ?? null, m: out }).slice(0, 2048);
}

export const sha256hex = (text: string) => createHash('sha256').update(text).digest('hex');

/** What the oracle posts for a day: where the data came from, the reading, and the hash of the full payload. */
export function worldPost(day: WorldDay, payload: string, source: string): WorldPostInput {
  return { source: source.slice(0, 512), raw: compactReading(day), sha256: sha256hex(payload) };
}

/** Source line for Open-Meteo posts: the API hosts, the five points and the variables. */
export const OPEN_METEO_SOURCE =
  'open-meteo.com (CC BY 4.0) forecast+marine daily: ' +
  REGIONS.map((r) => `${r.id}@${r.lat},${r.lon}`).join(' ') +
  ' · temperature_2m_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wave_height_max';

/**
 * WorldSource backed by Open-Meteo. The engine asks synchronously once per game day;
 * we hand it the latest cached reading and refresh in the background. If the API fails
 * we keep the last good value (never block the village on a network call).
 */
export class OpenMeteoWorld implements WorldSource {
  private latest: WorldDay;
  /** the latest reading as the oracle posts it on chain */
  latestPost?: WorldPostInput;
  /** full payloads by hash, so the operator can publish what was hashed */
  onPayload?: (sha256: string, payload: string) => void;
  private timer?: ReturnType<typeof setInterval>;

  constructor(fallback: WorldDay, private onError: (e: Error) => void = () => {}, private fetchImpl: typeof fetch = fetch) {
    this.latest = fallback;
  }

  async start(refreshMs = 6 * 3600_000) {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), refreshMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh() {
    try {
      const r = await fetchWorldReading(this.fetchImpl);
      this.latest = r.day;
      this.latestPost = worldPost(r.day, r.payload, OPEN_METEO_SOURCE);
      this.onPayload?.(this.latestPost.sha256, r.payload);
    } catch (e) {
      this.onError(e as Error);
    }
  }

  next(): WorldDay {
    return this.latest;
  }
}
