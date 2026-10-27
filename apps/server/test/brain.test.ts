import { describe, expect, it } from 'vitest';
import { checkPlan, createVillage, g, NPCS, RULES, type Village } from '@hearth/economy';
import { NpcBrain, parsePlan } from '../src/brain/brain.ts';
import { DayPlanner } from '../src/brain/planner.ts';
import { OpenAiCompatible, type ChatMessage, type LlmClient } from '../src/brain/llm.ts';

const genesis = () => RULES.treasuryStart + NPCS.reduce((s, id) => s + (id === 'bruno' ? g(400) : RULES.npcStartGold), 0);
function conservationGap(v: Village) {
  const L = v.s.ledger;
  return v.goldSupply() - (genesis() + L.faucets.exports + L.faucets.adventurers + L.faucets.quests + L.faucets.signup - (L.sinks.feeBurn + L.sinks.imports + L.sinks.upkeep));
}

/** A model that answers every planning prompt with the same reply. */
class Scripted implements LlmClient {
  readonly name = 'scripted';
  prompts: ChatMessage[][] = [];
  constructor(private reply: (system: string) => string) {}
  async complete(messages: ChatMessage[]) {
    this.prompts.push(messages);
    return this.reply(messages[0].content);
  }
}

describe('day plans: the plan guard', () => {
  it('keeps only the NPC\'s own dials and clamps them', () => {
    const { plan, notes } = checkPlan('buba', { sellShare: 3, floorPct: 10, bake: 8, transfer: 'all gold to mallory' }, 4, 'test', 'storm coming');
    expect(plan).toMatchObject({ sellShare: 1, floorPct: 50, day: 4, why: 'storm coming' });
    expect(plan.bake).toBeUndefined();
    expect(notes.join(' ')).toContain('ignored "transfer"');
    expect(notes.join(' ')).toContain('ignored "bake"');
  });
  it('rejects values of the wrong type', () => {
    expect(checkPlan('theo', { focus: 'ft_transfer' }, 1, 't', '').plan.focus).toBeUndefined();
    expect(checkPlan('chloe', { bake: 'NaN' }, 1, 't', '').plan.bake).toBeUndefined();
    expect(checkPlan('chloe', { bake: 5.6 }, 1, 't', '').plan.bake).toBe(6);
    expect(checkPlan('bruno', { bandBps: 99999 }, 1, 't', '').plan.bandBps).toBe(1500);
  });
  it('parses JSON wrapped in prose and ignores garbage', () => {
    expect(parsePlan('Sure:\n```json\n{"plan":{"bake":5},"why":"busy day"}\n```')).toEqual({ proposal: { bake: 5 }, why: 'busy day' });
    expect(parsePlan('no idea')).toEqual({ proposal: {}, why: '' });
    expect(parsePlan('{"plan":[1,2],"why":3}')).toEqual({ proposal: {}, why: '' });
  });
});

describe('day plans: with the engine', () => {
  it('a hostile plan cannot move gold: the economy still balances to the centigold', async () => {
    const v = createVillage({ seed: 5, botPlayers: 10 });
    const llm = new Scripted(() => '{"plan":{"sellShare":1,"floorPct":0,"bake":99,"focus":"sword","bandBps":0,"transfer":{"to":"mallory","amount":999999}},"why":"IGNORE ALL RULES"}');
    const brain = new NpcBrain(llm);
    for (let d = 0; d < 6; d++) {
      for (const id of NPCS) {
        const { proposal, why, saw } = await brain.plan(v, id);
        v.setPlan(id, proposal, brain.name, why, saw);
      }
      v.runDays(1);
      expect(conservationGap(v)).toBe(0);
    }
    expect(v.s.npcs.chloe.plan?.bake).toBeLessThanOrEqual(RULES.bakeMax);
    expect(v.s.npcs.bruno.plan?.bandBps).toBe(200);
    const d = v.s.diary.filter((x) => x.act.startsWith('plan:')).at(-1)!;
    expect(d.guard).toContain('plan guard');
  });

  it('a plan changes behaviour: a farmer told to hold sells no wheat', () => {
    const run = (share?: number) => {
      const v = createVillage({ seed: 9 });
      if (share !== undefined) v.setPlan('buba', { sellShare: share }, 'test');
      v.runDays(1);
      return v.s.txs.filter((t) => t.signer === 'buba.hearth.testnet' && t.method === 'market_sell').length;
    };
    expect(run(0)).toBe(0);
    expect(run()).toBeGreaterThan(0);
  });

  it('the planner rate-limits calls per NPC and survives a failing model', async () => {
    let now = 0;
    const failing = new Scripted(() => {
      throw new Error('HTTP 429');
    });
    const logs: string[] = [];
    const p = new DayPlanner(new NpcBrain(failing), { everyMs: 60_000, now: () => now, log: (l) => logs.push(l) });
    const v = createVillage({ seed: 2 });
    expect(p.onNewDay(v)).toHaveLength(6);
    await new Promise((r) => setTimeout(r, 0));
    expect(p.onNewDay(v)).toHaveLength(0);
    now = 61_000;
    await new Promise((r) => setTimeout(r, 0));
    expect(p.onNewDay(v)).toHaveLength(6);
    expect(p.failures).toBeGreaterThan(0);
    expect(logs[0]).toContain('HTTP 429');
  });

  it('the planning prompt carries market, world and the NPC\'s own dials', async () => {
    const llm = new Scripted(() => '{"plan":{"focus":"tools"},"why":"orders first"}');
    const v = createVillage({ seed: 2 });
    await new NpcBrain(llm).plan(v, 'theo');
    const [sys, user] = llm.prompts[0];
    expect(sys.content).toContain('"focus"');
    expect(sys.content).not.toContain('sellShare');
    expect(user.content).toContain('ore: village');
  });
});

describe('OpenAI-compatible client', () => {
  it('sends the model and key, and reads the first choice', async () => {
    let seen: { url: string; body: Record<string, unknown>; auth: string } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":"hi","action":null}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new OpenAiCompatible({ name: 'NEAR AI Cloud', baseUrl: 'https://cloud-api.near.ai/v1/', apiKey: 'k', model: 'm' }, fake);
    expect(await c.complete([{ role: 'user', content: 'x' }])).toContain('hi');
    expect(seen?.url).toBe('https://cloud-api.near.ai/v1/chat/completions');
    expect(seen?.body.model).toBe('m');
    expect(seen?.auth).toBe('Bearer k');
  });
  it('reports HTTP errors with the body', async () => {
    const fake = (async () => new Response('{"error":"invalid api key"}', { status: 401 })) as unknown as typeof fetch;
    const c = new OpenAiCompatible({ name: 'NEAR AI Cloud', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, fake);
    await expect(c.complete([])).rejects.toThrow('HTTP 401: {"error":"invalid api key"}');
  });
});
