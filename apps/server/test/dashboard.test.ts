import { describe, expect, it } from 'vitest';
import { NPC_DEFS, playerSigner } from '@hearth/economy';
import { ChainMirror } from '../src/chain/mirror.ts';
import { MockChain, NpcSigner } from '../src/chain/signer.ts';
import { NpcBrain } from '../src/brain/brain.ts';
import { Game } from '../src/game.ts';
import { dashboardView } from '../src/dashboard.ts';

describe('public dashboard', () => {
  it('ranks the agents, counts what reached the chain, and links only real hashes', async () => {
    const chain = new MockChain();
    const m = new ChainMirror(chain, { contract: 'hearth.testnet', operator: 'hearth.testnet', playerAccount: (id) => `p-${id}.testnet`, minDayMs: 0, maxPerMinute: 10_000, maxQueue: 100 });
    const game = new Game({ seed: 7, mirror: m }, new NpcBrain(null), new NpcSigner(chain, 'hearth.testnet'), chain);
    game.join('khang', 'Khang');
    game.act('khang', { type: 'market_buy', item: 'wheat', qty: 2, maxPrice: 300 });
    chain.failNext.set('hire', 'not enough goods');
    for (let i = 0; i < 48; i++) game.tick();
    await m.idle();
    const d = dashboardView(game.village, { online: 1, brain: 'rules', chain: 'mock', contract: 'hearth.testnet', mirror: m, redTeam: { runs: 0, blocked: 0, bySigner: 0, byContract: 0, onChain: 0 }, startedAt: Date.now() });
    expect(d.npcs).toHaveLength(6);
    expect(d.npcs[0].netWorth).toBeGreaterThanOrEqual(d.npcs[5].netWorth);
    expect(d.onChain?.byMethod.relay_market_buy.ok).toBe(1);
    expect(d.onChain?.byMethod.hire.failed).toBeGreaterThanOrEqual(1);
    expect(d.onChain?.events.length).toBeGreaterThan(0);
    expect(d.onChain?.events.find((e) => !e.ok)?.reason).toBe('not enough goods');
    for (const n of d.npcs) if (n.diaryTx) expect(n.diaryTx).toMatch(/^Mock/);
    expect(d.supply.length).toBeGreaterThan(0);
    expect(JSON.stringify(d)).not.toContain(playerSigner('khang'));
    expect(d.npcs.map((n) => n.account)).toContain(NPC_DEFS.theo.account);
  });
});
