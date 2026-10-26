import { REGIONS, type Metrics, type WorldDay, type WorldSource } from '@hearth/economy';

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

export async function fetchWorldDay(fetchImpl: typeof fetch = fetch): Promise<WorldDay> {
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
  const [lr, mr] = await Promise.all([fetchImpl(`${FORECAST}?${qs}`), fetchImpl(`${MARINE}?${mqs}`)]);
  if (!lr.ok) throw new Error(`open-meteo forecast ${lr.status}`);
  if (!mr.ok) throw new Error(`open-meteo marine ${mr.status}`);
  const landJson = await lr.json();
  const seaJson = await mr.json();
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
  return { metrics, forecast, source: 'open-meteo', fetchedAt: new Date().toISOString() };
}

/**
 * WorldSource backed by Open-Meteo. The engine asks synchronously once per game day;
 * we hand it the latest cached reading and refresh in the background. If the API fails
 * we keep the last good value (never block the village on a network call).
 */
export class OpenMeteoWorld implements WorldSource {
  private latest: WorldDay;
  private timer?: ReturnType<typeof setInterval>;

  constructor(fallback: WorldDay, private onError: (e: Error) => void = () => {}) {
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
      this.latest = await fetchWorldDay();
    } catch (e) {
      this.onError(e as Error);
    }
  }

  next(): WorldDay {
    return this.latest;
  }
}
