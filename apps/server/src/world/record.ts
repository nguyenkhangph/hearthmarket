/**
 * Records today's real world data so it can be replayed in demos:
 *   npm run world:record -w @hearth/server
 * Appends to data/world/recorded.json.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchWorldDay } from './openMeteo.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const file = join(root, 'data/world/recorded.json');
const day = await fetchWorldDay();
const doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { description: 'Real days recorded from Open-Meteo (CC BY 4.0).', days: [] };
doc.days.push(day);
writeFileSync(file, JSON.stringify(doc, null, 1));
console.log(`recorded ${day.fetchedAt} -> ${file} (${doc.days.length} days)`);
