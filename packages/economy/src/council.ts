import { NPC_DEFS, NPCS, type ItemId, type NpcId } from './defs.ts';
import { midPrice } from './market.ts';
import { fmt } from './money.ts';
import type { Village } from './engine.ts';
import type { CouncilMotion, MotionKind } from './types.ts';

/**
 * The village council. Every third day a motion comes up; the six NPCs vote by their own
 * interest and say why, from the engine's numbers; players (and Silas, the AI rival) vote too.
 * A motion that passes at 20:00 holds for the next two days. Rules, not a model: the same
 * village always votes the same way, and every reason can be checked against the numbers.
 */
export const MOTIONS: Record<MotionKind, { title: string; effect: string }> = {
  no_wheat_export: {
    title: 'Keep the wheat home: Bruno may not export wheat for two days',
    effect: 'Bruno skips wheat exports',
  },
  bonus_up: {
    title: 'Pay players more: request bonuses up 50% for two days',
    effect: 'new NPC requests carry a 50% larger bonus (the NPC who asks pays it)',
  },
  no_ore_import: {
    title: 'Protect the mine: Bruno may not import ore for two days',
    effect: 'Bruno skips ore imports',
  },
};
export const MOTION_ORDER: MotionKind[] = ['no_wheat_export', 'bonus_up', 'no_ore_import'];
export const COUNCIL_EVERY = 3;
export const COUNCIL_DAYS = 2;

type Vote = { vote: 'yes' | 'no' | 'abstain'; why: string };

const price = (v: Village, i: ItemId) => fmt(midPrice(i, v.s.market.stock[i]), 2);
const worldGap = (v: Village, i: ItemId) => {
  const w = v.s.world.price[i];
  if (!w) return 0;
  return midPrice(i, v.s.market.stock[i]) / w - 1;
};
const pct = (x: number) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`;

/** How an NPC votes on a motion, and why, from its trade and today's numbers. */
export function npcVote(v: Village, id: NpcId, kind: MotionKind): Vote {
  const n = v.s.npcs[id];
  switch (kind) {
    case 'no_wheat_export':
      if (id === 'chloe') return { vote: 'yes', why: `wheat stays in the village and my bread costs less (wheat ${price(v, 'wheat')})` };
      if (id === 'buba') return { vote: 'no', why: `exports are my best buyer when the world pays more (village vs world ${pct(worldGap(v, 'wheat'))})` };
      if (id === 'bruno') return { vote: 'no', why: 'exporting is half of my trade' };
      return { vote: 'abstain', why: 'it does not touch my trade' };
    case 'bonus_up':
      if (id === 'chloe' || id === 'theo' || id === 'jack') {
        const asks = (v.s.requests ?? []).filter((r) => r.npc === id).length;
        return { vote: 'no', why: `I pay that bonus (${asks} request${asks === 1 ? '' : 's'} of mine on the board lately)` };
      }
      if (id === 'mike' || id === 'buba') return { vote: 'yes', why: 'players who earn more buy more of what I sell' };
      return { vote: 'abstain', why: 'I post no requests' };
    case 'no_ore_import':
      if (id === 'mike') return { vote: 'yes', why: `imports undercut my ore (village ${price(v, 'ore')}, ${pct(worldGap(v, 'ore'))} vs the world)${n.mineHealth < 0.9 ? `, and the mine is at ${Math.round(n.mineHealth * 100)}%` : ''}` };
      if (id === 'theo') return { vote: 'no', why: `my tools and swords need cheap ore (ore ${price(v, 'ore')})` };
      if (id === 'bruno') return { vote: 'no', why: 'importing is half of my trade' };
      if (id === 'jack') return { vote: 'yes', why: 'producers have to stick together' };
      return { vote: 'abstain', why: 'it does not touch my trade' };
  }
}

/** The AI rival votes for whatever pays him, given what he holds. */
export function rivalVote(v: Village, rivalId: string, kind: MotionKind): Vote {
  const r = v.s.players[rivalId];
  if (!r) return { vote: 'abstain', why: '' };
  switch (kind) {
    case 'no_wheat_export': return r.stock.wheat > 0 ? { vote: 'no', why: `I hold ${r.stock.wheat} wheat and want the export price` } : { vote: 'yes', why: 'cheaper wheat for my next trade' };
    case 'bonus_up': return { vote: 'yes', why: 'I fill requests too' };
    case 'no_ore_import': return r.stock.ore > 0 ? { vote: 'yes', why: `I hold ${r.stock.ore} ore` } : { vote: 'no', why: 'cheaper ore for my next trade' };
  }
}

export function newMotion(v: Village, id: number): CouncilMotion {
  const kind = MOTION_ORDER[Math.floor(v.day / COUNCIL_EVERY) % MOTION_ORDER.length];
  const votes: CouncilMotion['votes'] = NPCS.map((n) => ({ who: n, kind: 'npc' as const, name: NPC_DEFS[n].name, ...npcVote(v, n, kind) }));
  return { id, kind, day: v.day, title: MOTIONS[kind].title, votes, status: 'open' };
}

export function tally(m: CouncilMotion) {
  const yes = m.votes.filter((x) => x.vote === 'yes').length;
  const no = m.votes.filter((x) => x.vote === 'no').length;
  return { yes, no, passes: yes > no };
}

/** Is this motion's effect in force today? */
export function councilInForce(v: Village, kind: MotionKind): boolean {
  return (v.s.council ?? []).some((m) => m.kind === kind && m.status === 'passed' && m.from !== undefined && v.day >= m.from && v.day <= m.to!);
}
