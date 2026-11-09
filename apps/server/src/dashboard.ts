import { ITEMS, ITEM_DEFS, NPCS, NPC_DEFS, economyHealth, marketView, midPrice, txKind, type NpcId, type Village } from '@hearth/economy';
import type { ChainEvent, ChainMirror } from './chain/mirror.ts';

/** Red-team runs since the server started (all players). */
export interface RedTeamStats {
  runs: number;
  blocked: number;
  bySigner: number;
  byContract: number;
  onChain: number;
  last?: { attack: string; npc: NpcId; layer?: string; hash?: string; at: number };
  /** per player (first name only) */
  players?: Record<string, { name: string; runs: number; blocked: number; onChain: number }>;
}

/** Public boards show a first name only. */
export const firstName = (name: string) => (name.trim().split(/\s+/)[0] || 'player').slice(0, 16);

export interface DashboardExtras {
  online: number;
  brain: string;
  chain: 'mock' | 'near';
  contract: string;
  mirror?: ChainMirror;
  redTeam: RedTeamStats;
  startedAt: number;
  /** NEAR account of a signed-in player, for the trader board */
  playerAccount?: (playerId: string) => string | null;
  /** where the agents' decisions came from since the server started */
  ai?: { deals: { model: number; rules: number; fallback: number }; plans?: { model: number; failed: number }; model?: string };
}

/**
 * Everything the public dashboard shows, in one JSON: the market, the money supply and its
 * flows, who is getting rich, what reached the chain, and how the red team is doing.
 * Read-only; no player data beyond public guild names.
 */
export function dashboardView(v: Village, x: DashboardExtras) {
  const s = v.s;
  const stats = s.dailyStats;
  const first = stats[0]?.priceIndex || 100;
  const a = stats.at(-2)?.ledger;
  const b = stats.at(-1)?.ledger;
  const diff = (f: (l: NonNullable<typeof b>) => number) => (a && b ? f(b) - f(a) : b ? f(b) : 0);
  const value = (stock: Record<string, number>) => ITEMS.reduce((sum, i) => sum + (stock[i] ?? 0) * midPrice(i, s.market.stock[i]), 0);

  const npcs = NPCS.map((id) => {
    const n = s.npcs[id];
    const def = NPC_DEFS[id];
    const diary = s.diary.filter((d) => d.npc === id).at(-1);
    const chainTxs = s.txs.filter((t) => t.signer === def.account && txKind(t.hash) === 'chain').length;
    return {
      id, name: def.name, title: def.title, account: def.account,
      gold: n.gold, stockValue: value(n.stock), netWorth: n.gold + value(n.stock),
      spentToday: n.spentToday, dailyBudget: def.dailyBudget,
      think: diary?.think ?? '', act: diary?.act ?? '', guard: diary?.guard ?? '', diaryTx: diary?.tx && txKind(diary.tx) === 'chain' ? diary.tx : undefined,
      planBy: n.plan?.by,
      nearBalance: x.mirror?.balances[def.account],
      recentChainTxs: chainTxs,
      history: stats.map((d) => d.npcGold[id]),
    };
  }).sort((p, q) => q.netWorth - p.netWorth);

  const humans = Object.values(s.players).filter((p) => !p.bot);
  const events: ChainEvent[] = x.mirror ? [...x.mirror.events].reverse().slice(0, 25) : [];

  return {
    at: Date.now(),
    uptimeMs: Date.now() - x.startedAt,
    day: v.day,
    hour: v.hour,
    online: x.online,
    players: { humans: humans.length, bots: Object.keys(s.players).length - humans.length },
    brain: x.brain,
    chain: x.chain,
    contract: x.contract,
    chainActive: x.mirror?.isActive ?? false,
    market: marketView(v).map((r) => ({ ...r, history: s.market.history[r.item].slice(-30) })),
    supply: stats.map((d) => ({ day: d.day, gold: d.goldSupply, index: (d.priceIndex / first) * 100 })),
    health: economyHealth(stats),
    flows: {
      exports: diff((l) => l.faucets.exports),
      adventurers: diff((l) => l.faucets.adventurers),
      quests: diff((l) => l.faucets.quests + l.faucets.signup),
      feeBurn: diff((l) => l.sinks.feeBurn),
      imports: diff((l) => l.sinks.imports),
      upkeep: diff((l) => l.sinks.upkeep),
      volume: diff((l) => l.volume),
    },
    world: {
      regions: s.world.regions.map((r) => ({ name: r.name, headline: r.headline, severity: r.severity, forecast: r.forecast })),
      prices: Object.fromEntries(ITEMS.filter((i) => ITEM_DEFS[i].world).map((i) => [i, s.world.price[i]])),
      shippingBps: s.world.shippingBps,
      source: s.world.source,
      fx: s.world.fx,
    },
    npcs,
    guilds: Object.values(s.guilds).map((g) => ({ name: g.name, members: g.members.length, fund: g.fund, ai: !!g.ai })).sort((p, q) => q.fund - p.fund),
    orders: { open: s.orders.filter((o) => o.status === 'open').length, filled: s.orders.filter((o) => o.status === 'filled').length },
    onChain: x.mirror
      ? { stats: x.mirror.stats, byMethod: x.mirror.byMethod, events, proofs: [...x.mirror.proofs].reverse(), balances: x.mirror.balances }
      : undefined,
    redTeam: { ...x.redTeam, players: undefined },
    ai: x.ai,
    // today's and recent decisions with their source, for the "LLM or rules" table
    decisions: decisions(v),
    redTeamers: mergeByName(Object.values(x.redTeam.players ?? {})).sort((a, b) => b.blocked - a.blocked || b.runs - a.runs).slice(0, 8),
    traders: traders(v, x.playerAccount),
    deals: (s.deals ?? []).slice(-6).reverse().map((d) => ({
      day: d.day, buyer: NPC_DEFS[d.buyer].name, seller: NPC_DEFS[d.seller].name, item: d.item, status: d.status,
      price: d.price, maxQty: d.maxQty, used: d.used, by: d.by, guard: d.guard,
      rounds: d.rounds.map((r) => ({ who: NPC_DEFS[r.who].name, say: r.say, price: r.price, accept: r.accept })),
    })),
    feed: s.feed.slice(-12).reverse().map((e) => ({ t: e.t, kind: e.kind, text: e.text, tx: e.tx && txKind(e.tx) === 'chain' ? e.tx : undefined })),
  };
}

export type DashboardView = ReturnType<typeof dashboardView>;

/** The latest agent decisions (day plans and deals) with where they came from. */
function decisions(v: Village) {
  const s = v.s;
  const plans = NPCS.filter((id) => s.npcs[id].plan).map((id) => {
    const p = s.npcs[id].plan!;
    return { kind: 'plan' as const, day: p.day, who: NPC_DEFS[id].name, by: p.by, source: sourceOf(p.by), why: p.why ?? '' };
  });
  const deals = (s.deals ?? []).slice(-6).map((d) => ({
    kind: 'deal' as const, day: d.day, who: `${NPC_DEFS[d.buyer].name} ← ${NPC_DEFS[d.seller].name}`, by: d.by, source: sourceOf(d.by),
    why: d.status === 'agreed' ? `${d.item} at ${(d.price! / 100).toFixed(2)}` : `${d.item}: no deal`,
  }));
  return [...deals, ...plans].sort((a, b) => b.day - a.day).slice(0, 12);
}

/** "llm" only when the words came from a model; a rules fallback says so. */
export const sourceOf = (by: string): 'llm' | 'rules' | 'fallback' =>
  /model unavailable|fallback/i.test(by) ? 'fallback' : /^rules/i.test(by) ? 'rules' : 'llm';

/** Human players ranked by net worth (gold + goods at the market mid). First name and account only. */
function traders(v: Village, account?: (id: string) => string | null) {
  const s = v.s;
  const mid = Object.fromEntries(ITEMS.map((i) => [i, midPrice(i, s.market.stock[i])]));
  return Object.values(s.players)
    .filter((p) => !p.bot)
    .map((p) => {
      const goods = ITEMS.reduce((t, i) => t + p.stock[i] * mid[i], 0);
      return {
        name: firstName(p.name), worth: p.gold + goods, gold: p.gold, goods, badges: p.badges?.length ?? 0,
        guild: p.guild ? s.guilds[p.guild]?.name : undefined, account: account?.(p.id) ?? undefined,
      };
    })
    .sort((a, b) => b.worth - a.worth)
    .slice(0, 10);
}

/** One row per first name: the history and the live session may hold the same player twice. */
function mergeByName(rows: { name: string; runs: number; blocked: number; onChain: number }[]) {
  const m = new Map<string, { name: string; runs: number; blocked: number; onChain: number }>();
  for (const r of rows) {
    const t = m.get(r.name) ?? { name: r.name, runs: 0, blocked: 0, onChain: 0 };
    t.runs += r.runs; t.blocked += r.blocked; t.onChain += r.onChain;
    m.set(r.name, t);
  }
  return [...m.values()];
}
