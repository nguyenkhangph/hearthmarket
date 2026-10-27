/**
 * One live Open-Meteo reading, as the server would use it today:
 *   npm run world:check
 * Prints each region against its November normal, the resulting world prices, and the
 * hash the oracle would post on chain. Sends nothing to NEAR.
 */
import { applyWorldDay, fmt, initialWorld, REGIONS } from '@hearth/economy';
import { fetchWorldReading, OPEN_METEO_SOURCE, worldPost } from './openMeteo.ts';

const r = await fetchWorldReading();
const w = applyWorldDay(initialWorld(), r.day, 1);
console.log(`\nOpen-Meteo reading at ${r.day.fetchedAt}\n`);
for (const def of REGIONS) {
  const m = r.day.metrics[def.id] ?? {};
  const st = w.regions.find((x) => x.id === def.id)!;
  const vals = Object.entries(m).map(([k, v]) => `${k} ${typeof v === 'number' ? v.toFixed(1) : '-'} (normal ${def.normal[k as keyof typeof def.normal]?.toFixed(1) ?? '-'})`).join(', ');
  console.log(`${def.name.padEnd(13)} ${def.item.padEnd(9)} severity ${st.severity.toFixed(2)}  ${st.headline}${st.forecast ? ` · forecast: ${st.forecast}` : ''}\n              ${vals}`);
}
console.log(`\nWorld prices: ${Object.entries(w.price).map(([i, p]) => `${i} ${fmt(p!)}`).join(' · ')} · shipping ${(w.shippingBps / 100).toFixed(1)}%`);
const post = worldPost(r.day, r.payload, OPEN_METEO_SOURCE);
console.log(`On-chain post: sha256 ${post.sha256}, reading ${post.raw.length} bytes\n`);
