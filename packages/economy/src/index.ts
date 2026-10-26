export * from './defs.ts';
export * from './money.ts';
export * from './rng.ts';
export * from './types.ts';
export * from './market.ts';
export * from './policy.ts';
export * from './world.ts';
export * from './engine.ts';
export * from './ai.ts';

import { Village, type VillageOptions } from './engine.ts';
import { aiDriver } from './ai.ts';

/** A village with the 4 AI guilds already playing. */
export function createVillage(opts: VillageOptions = {}): Village {
  const v = new Village({ aiGuilds: true, ...opts });
  v.setAiDriver(aiDriver((opts.seed ?? 42) + 1));
  return v;
}
