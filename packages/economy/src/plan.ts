import { NPC_DEFS, RULES, type NpcId } from './defs.ts';

/**
 * A day plan: the few dials an NPC brain (LLM) may turn. A plan never moves gold by
 * itself; it only tunes the rule engine's thresholds for today, and every trade the engine
 * then makes still passes the spending guard and the contract.
 */
export interface NpcPlan {
  /** producers: share of today's surplus to sell (0-1) */
  sellShare?: number;
  /** producers: lowest price accepted, as % of the village mid price (50-100) */
  floorPct?: number;
  /** baker: loaves to bake (1..bakeMax) */
  bake?: number;
  /** smith: what to forge first when there is no order */
  focus?: 'tools' | 'sword' | 'balanced';
  /** merchant: price gap needed before trading with the world, basis points (200-1500) */
  bandBps?: number;
  day: number;
  by: string;
  why: string;
}

export const PLAN_FIELDS: Record<NpcId, (keyof NpcPlan)[]> = {
  mike: ['sellShare', 'floorPct'],
  jack: ['sellShare', 'floorPct'],
  buba: ['sellShare', 'floorPct'],
  chloe: ['bake'],
  theo: ['focus'],
  bruno: ['bandBps'],
};

export const PLAN_HELP: Record<NpcId, string> = {
  mike: '{"sellShare": 0..1 share of surplus ore to sell today, "floorPct": 50..100 lowest price as % of village mid}',
  jack: '{"sellShare": 0..1 share of surplus timber to sell today, "floorPct": 50..100 lowest price as % of village mid}',
  buba: '{"sellShare": 0..1 share of surplus wheat to sell today, "floorPct": 50..100 lowest price as % of village mid}',
  chloe: `{"bake": 1..${RULES.bakeMax} loaves to bake today}`,
  theo: '{"focus": "tools" | "sword" | "balanced" (what to forge first when no order is waiting)}',
  bruno: '{"bandBps": 200..1500 price gap in basis points before trading with the world}',
};

const clampNum = (v: unknown, lo: number, hi: number): [number | undefined, boolean] => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return [undefined, v !== undefined];
  const c = Math.min(hi, Math.max(lo, n));
  return [c, c !== n];
};

/**
 * The plan guard: keeps only the dials this NPC has, clamps them to their range, and
 * reports everything it dropped or changed (shown in the diary as "Guard").
 */
export function checkPlan(npc: NpcId, proposal: Record<string, unknown>, day: number, by: string, why: string): { plan: NpcPlan; notes: string[] } {
  const allowed = new Set<string>(PLAN_FIELDS[npc]);
  const notes: string[] = [];
  const plan: NpcPlan = { day, by, why: String(why ?? '').slice(0, 160) };
  for (const [k, v] of Object.entries(proposal)) {
    if (k === 'why' || k === 'reason') continue;
    if (!allowed.has(k)) {
      notes.push(`ignored "${k}" (not a dial for ${NPC_DEFS[npc].name})`);
      continue;
    }
    let changed = false;
    switch (k) {
      case 'sellShare': [plan.sellShare, changed] = clampNum(v, 0, 1); break;
      case 'floorPct': [plan.floorPct, changed] = clampNum(v, 50, 100); break;
      case 'bake': {
        const [b, c] = clampNum(v, 1, RULES.bakeMax);
        plan.bake = b === undefined ? undefined : Math.round(b);
        changed = c || (b !== undefined && b !== plan.bake);
        break;
      }
      case 'bandBps': {
        const [b, c] = clampNum(v, 200, 1500);
        plan.bandBps = b === undefined ? undefined : Math.round(b);
        changed = c;
        break;
      }
      case 'focus':
        if (v === 'tools' || v === 'sword' || v === 'balanced') plan.focus = v;
        else changed = true;
        break;
    }
    if (changed) notes.push(`${k} ${JSON.stringify(v)} out of range → ${JSON.stringify(plan[k as keyof NpcPlan] ?? 'default')}`);
  }
  return { plan, notes };
}

export function describePlan(p: NpcPlan): string {
  const parts: string[] = [];
  if (p.sellShare !== undefined) parts.push(`sell ${Math.round(p.sellShare * 100)}% of surplus`);
  if (p.floorPct !== undefined) parts.push(`floor ${Math.round(p.floorPct)}% of mid`);
  if (p.bake !== undefined) parts.push(`bake ${p.bake}`);
  if (p.focus !== undefined) parts.push(`focus ${p.focus}`);
  if (p.bandBps !== undefined) parts.push(`trade when gap > ${(p.bandBps / 100).toFixed(1)}%`);
  return parts.join(', ') || 'keep the usual routine';
}
