import { ITEMS } from './defs.ts';
import { midPrice } from './market.ts';
import { g, type Gold } from './money.ts';
import type { Village } from './engine.ts';

/**
 * The free-play goal: grow your purse in a week. Net worth = gold + goods at the market mid,
 * so goods bought to resell or deliver count while you hold them. Three stars, by threshold.
 */
export const GOAL = {
  days: 7,
  /** net worth for ★, ★★, ★★★ as a multiple of the week's start (50 gold → 75 / 100 / 150) */
  stars: [1.5, 2, 3] as const,
  /** a week never starts below this, so a broke player still has a reachable goal */
  minStart: g(50),
};

export interface GoalState {
  startDay: number;
  startWorth: Gold;
  /** the AI rival's net worth when this week started */
  rivalStart?: Gold;
  /** set when the week is over */
  result?: { stars: number; worth: Gold; day: number; rivalGain?: Gold };
  /** best result in earlier weeks */
  best?: number;
}

export interface GoalView {
  title: string;
  day: number;
  days: number;
  worth: Gold;
  target: Gold;
  stars: number;
  /** 0..1 towards ★★★ */
  progress: number;
  next?: Gold;
  targets: Gold[];
  over: boolean;
  best?: number;
  /** this week's gain, yours and the AI rival's (when there is one) */
  gain: Gold;
  rival?: { name: string; gain: Gold; worth: Gold };
}

export function netWorth(v: Village, playerId: string): Gold {
  const p = v.s.players[playerId];
  if (!p) return 0;
  // goods waiting in a stall-board listing are still the seller's
  const listed = (v.s.listings ?? []).filter((l) => l.seller === playerId && l.status === 'open');
  const held = (i: (typeof ITEMS)[number]) => p.stock[i] + listed.filter((l) => l.item === i).reduce((s, l) => s + l.qty, 0);
  return p.gold + ITEMS.reduce((s, i) => s + held(i) * midPrice(i, v.s.market.stock[i]), 0);
}

/** the three thresholds of a week, rounded to whole gold */
export const goalTargets = (st: GoalState): Gold[] => GOAL.stars.map((m) => Math.round((Math.max(st.startWorth, GOAL.minStart) * m) / 100) * 100);
export const starsFor = (st: GoalState, worth: Gold) => goalTargets(st).filter((t) => worth >= t).length;

export function goalView(v: Village, playerId: string): GoalView | undefined {
  const st = v.s.players[playerId]?.goal;
  if (!st) return undefined;
  const worth = st.result?.worth ?? netWorth(v, playerId);
  const stars = st.result?.stars ?? starsFor(st, worth);
  const targets = goalTargets(st);
  const target = targets[2];
  return {
    title: `Grow your purse to ${target / 100} gold in ${GOAL.days} days`,
    day: Math.min(GOAL.days, v.day - st.startDay + 1),
    days: GOAL.days,
    worth,
    target,
    stars,
    progress: Math.max(0, Math.min(1, worth / target)),
    next: targets.find((t) => worth < t),
    targets,
    over: !!st.result,
    best: st.best,
    gain: worth - st.startWorth,
    ...(st.rivalStart !== undefined && v.s.players['ai-rival'] ? {
      rival: {
        name: v.s.players['ai-rival'].name,
        gain: st.result?.rivalGain ?? netWorth(v, 'ai-rival') - st.rivalStart,
        worth: netWorth(v, 'ai-rival'),
      },
    } : {}),
  };
}
