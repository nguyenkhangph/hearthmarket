import { NPC_DEFS, type NpcId } from './defs.ts';
import { fmt, type Gold } from './money.ts';
import type { Village } from './engine.ts';

/**
 * What an NPC remembers about each player it has dealt with: completed trades (orders it
 * filled for them, haggled sales), requests they delivered, and lowball offers. Regulars and
 * friends get up to 5% off when they haggle; repeated lowballers pay up to 5% more. Stored in
 * the village state, so it is deterministic, replayable and the same online and in the browser.
 */
export interface Regard {
  trades: number;
  volume: Gold;
  delivered: number;
  lowballs: number;
  lastDay: number;
  /** big orders the player accepted and did not deliver in time */
  broken?: number;
}

const empty = (): Regard => ({ trades: 0, volume: 0, delivered: 0, lowballs: 0, lastDay: 0 });

export function regardOf(v: Village, npc: NpcId, playerId: string): Regard {
  return v.s.regard?.[npc]?.[playerId] ?? empty();
}

function touch(v: Village, npc: NpcId, playerId: string): Regard {
  const all = (v.s.regard ??= {} as NonNullable<typeof v.s.regard>);
  const byNpc = (all[npc] ??= {});
  const r = (byNpc[playerId] ??= empty());
  r.lastDay = v.day;
  return r;
}

export function noteTrade(v: Village, npc: NpcId, playerId: string, gold: Gold) {
  const r = touch(v, npc, playerId);
  r.trades++;
  r.volume += gold;
}

export function noteDelivery(v: Village, npc: NpcId, playerId: string) {
  touch(v, npc, playerId).delivered++;
}

/** A promise kept counts twice; a broken one costs 2% on every later price, up to the 5% cap. */
export function notePromise(v: Village, npc: NpcId, playerId: string, kept: boolean) {
  const r = touch(v, npc, playerId);
  if (kept) r.delivered++;
  else r.broken = (r.broken ?? 0) + 1;
}

export function noteLowball(v: Village, npc: NpcId, playerId: string) {
  touch(v, npc, playerId).lowballs++;
}

/** Price adjustment for this player, in basis points (negative = discount), and why. */
export function regardBps(v: Village, npc: NpcId, playerId: string): { bps: number; why: string } {
  const r = regardOf(v, npc, playerId);
  const name = NPC_DEFS[npc].name;
  const loyalty = r.trades + 2 * r.delivered;
  const off = Math.min(500, loyalty * 100);
  const up = Math.min(500, Math.max(0, r.lowballs - 1) * 150 + (r.broken ?? 0) * 200);
  const bps = up - off;
  if (!loyalty && !r.lowballs && !r.broken) return { bps: 0, why: `${name} has not traded with you yet: market price.` };
  const parts: string[] = [];
  if (r.trades) parts.push(`${r.trades} trade${r.trades === 1 ? '' : 's'} (${fmt(r.volume, 0)} gold)`);
  if (r.delivered) parts.push(`${r.delivered} request${r.delivered === 1 ? '' : 's'} you delivered`);
  if (r.lowballs) parts.push(`${r.lowballs} lowball offer${r.lowballs === 1 ? '' : 's'}`);
  if (r.broken) parts.push(`${r.broken} big order${r.broken === 1 ? '' : 's'} you promised and never brought`);
  const eff = bps === 0 ? 'no change' : bps < 0 ? `${(-bps / 100).toFixed(0)}% off for you` : `${(bps / 100).toFixed(1)}% more for you`;
  return { bps, why: `${name} remembers ${parts.join(', ')}: ${eff}.` };
}
