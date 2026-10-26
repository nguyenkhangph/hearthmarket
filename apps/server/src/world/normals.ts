/**
 * Computes seasonal normals for the five regions from the Open-Meteo Historical API
 * (same calendar window over the last N years). Paste the output into REGIONS[].normal
 * in packages/economy/src/world.ts — the values there are placeholders until you do.
 *
 *   npm run normals -w @hearth/server -- --from 11-01 --to 11-30 --years 10
 *
 * Verify parameter names on https://open-meteo.com/en/docs/historical-weather-api
 * and https://open-meteo.com/en/docs/marine-weather-api before use.
 */
import { REGIONS } from '@hearth/economy';

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const from = arg('from', '11-01');
const to = arg('to', '11-30');
const years = Number(arg('years', '10'));
const thisYear = new Date().getUTCFullYear();

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

for (const r of REGIONS) {
  const vals: Record<string, number[]> = { tmax: [], precip3: [], wind: [], gust: [], wave: [] };
  for (let y = thisYear - years; y < thisYear; y++) {
    const start = `${y}-${from}`;
    const end = `${y}-${to}`;
    const url = r.api === 'marine'
      ? `https://marine-api.open-meteo.com/v1/marine?latitude=${r.lat}&longitude=${r.lon}&start_date=${start}&end_date=${end}&daily=wave_height_max`
      : `https://archive-api.open-meteo.com/v1/archive?latitude=${r.lat}&longitude=${r.lon}&start_date=${start}&end_date=${end}&daily=temperature_2m_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`${r.id} ${y}: HTTP ${res.status}`);
      continue;
    }
    const d = (await res.json()).daily ?? {};
    const push = (k: string, a?: (number | null)[]) => a?.forEach((v) => typeof v === 'number' && vals[k].push(v));
    push('tmax', d.temperature_2m_max);
    push('wind', d.wind_speed_10m_max);
    push('gust', d.wind_gusts_10m_max);
    push('wave', d.wave_height_max);
    const p: number[] = (d.precipitation_sum ?? []).map((v: number | null) => v ?? 0);
    for (let i = 0; i + 2 < p.length; i++) vals.precip3.push(p[i] + p[i + 1] + p[i + 2]);
  }
  const out = Object.fromEntries(Object.entries(vals).filter(([, v]) => v.length).map(([k, v]) => [k === 'precip3' ? 'precip' : k, +avg(v).toFixed(2)]));
  console.log(`${r.id}: normal: ${JSON.stringify(out)}`);
}
