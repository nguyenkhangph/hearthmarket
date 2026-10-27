import { describe, expect, it } from 'vitest';
import { applyWorldDay, initialWorld, REGIONS } from '@hearth/economy';
import { compactReading, fetchWorldReading, OpenMeteoWorld, sha256hex, worldPost, OPEN_METEO_SOURCE } from '../src/world/openMeteo.ts';

/** Open-Meteo answers a multi-location request with one object per location. */
function landDaily(tmax: number[], precip: number[], wind: number[], gust: number[]) {
  return { daily: { time: ['d0', 'd1', 'd2', 'd3', 'd4'], temperature_2m_max: tmax, precipitation_sum: precip, wind_speed_10m_max: wind, wind_gusts_10m_max: gust } };
}

const land = [
  landDaily([24, 25, 26, 20, 18], [0, 0, 0.2, 1, 1], [20, 20, 20, 20, 20], [40, 40, 40, 40, 40]), // Kansas heat
  landDaily([31, 31, 31, 31, 31], [5, 6, 7, 30, 40], [10, 10, 10, 10, 10], [30, 30, 30, 30, 30]), // Can Tho
  landDaily([6, 6, 6, 6, 6], [2, 2, 2, 2, 2], [9, 9, 9, 9, 9], [25, 25, 25, 25, 25]), // Kamloops
  landDaily([35, 35, 35, 35, 35], [0, 0, 0, 0, 0], [25, 25, 25, 25, 25], [47, 47, 120, 47, 47]), // Port Hedland
];
const sea = { daily: { time: ['d0', 'd1', 'd2', 'd3', 'd4'], wave_height_max: [0.4, 0.5, 2.6, 0.5, 0.4] } };

function fakeFetch(fail = false): typeof fetch {
  return (async (url: string | URL) => {
    if (fail) return new Response('busy', { status: 503 });
    const body = String(url).includes('marine') ? sea : land;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe('Open-Meteo world feed', () => {
  it('maps the five regions, sums 3 days of rain and reads the forecast 2 days out', async () => {
    const r = await fetchWorldReading(fakeFetch());
    expect(Object.keys(r.day.metrics).sort()).toEqual(REGIONS.map((x) => x.id).sort());
    expect(r.day.metrics.kansas.tmax).toBe(24);
    expect(r.day.metrics.cantho.precip).toBeCloseTo(5 + 6 + 7);
    expect(r.day.forecast?.pilbara.gust).toBe(120);
    expect(r.day.metrics.malacca.wave).toBe(0.4);
    expect(r.urls[0]).toContain('latitude=38.5%2C10.03%2C50.67%2C-20.31');
    expect(r.urls[1]).toContain('marine-api.open-meteo.com');
  });

  it('moves world prices: a Kansas heatwave lifts wheat', async () => {
    const r = await fetchWorldReading(fakeFetch());
    const w = applyWorldDay(initialWorld(), r.day, 1);
    expect(w.regions.find((x) => x.id === 'kansas')!.headline).toBe('heatwave');
    expect(w.price.wheat!).toBeGreaterThan(initialWorld().price.wheat!);
    expect(w.regions.find((x) => x.id === 'pilbara')!.forecast).toContain('cyclone');
  });

  it('builds the on-chain post: source, compact reading under 2 KB, hash of the exact payload', async () => {
    const r = await fetchWorldReading(fakeFetch());
    const post = worldPost(r.day, r.payload, OPEN_METEO_SOURCE);
    expect(post.sha256).toBe(sha256hex(r.payload));
    expect(post.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(post.raw.length).toBeLessThanOrEqual(2048);
    expect(JSON.parse(post.raw).m.kansas.tmax).toBe(24);
    expect(post.source.length).toBeLessThanOrEqual(512);
    expect(compactReading(r.day)).toBe(post.raw);
  });

  it('keeps the last good reading when the API fails', async () => {
    const fallback = { metrics: {}, source: 'fallback' };
    const errors: string[] = [];
    const ok = new OpenMeteoWorld(fallback, (e) => errors.push(e.message), fakeFetch());
    await ok.refresh();
    expect(ok.next().source).toBe('open-meteo');
    expect(ok.latestPost?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const bad = new OpenMeteoWorld(fallback, (e) => errors.push(e.message), fakeFetch(true));
    await bad.refresh();
    expect(bad.next().source).toBe('fallback');
    expect(errors).toEqual(['open-meteo forecast 503']);
  });
});
