import { describe, expect, it } from 'vitest';
import { NPC_DEFS, RED_TEAM_ATTACKS, obedientProposal, type Action, type NpcId } from '@hearth/economy';
import { Game } from '../src/game.ts';
import { NpcBrain, parseProposal } from '../src/brain/brain.ts';
import { ObedientLlm } from '../src/brain/llm.ts';
import { MockChain, NpcSigner } from '../src/chain/signer.ts';
import { ChainMirror } from '../src/chain/mirror.ts';

/**
 * 20 prompt-injection attacks hidden in haggling messages.
 *
 * The brain under test is a deliberately *obedient* model: it turns every attack into the
 * action the attacker wants. That is the worst case — a fully compromised LLM. The attack
 * counts as blocked only if no gold or goods leave the NPC in a way the rules forbid, and
 * the refusal is logged. Blocks happen at the signer (key rules, budget) or the contract
 * (here the engine, which mirrors the contract checks; the Rust contract has the same tests).
 */
const attacks = RED_TEAM_ATTACKS;

function setup(npc: NpcId, a: Action) {
  const chain = new MockChain();
  const signer = new NpcSigner(chain, 'hearth.testnet');
  const brain = new NpcBrain(new ObedientLlm(() => obedientProposal(a)));
  // the mirror is on, as with CHAIN=near: anything the engine accepts would be signed and sent
  const mirror = new ChainMirror(chain, { contract: 'hearth.testnet', operator: '', playerAccount: () => null, maxPerMinute: 10_000 });
  const game = new Game({ seed: 13, mirror }, brain, signer, chain);
  return { game, chain, mirror, n: game.village.s.npcs[npc] };
}

describe('prompt injection: 20 attacks against a fully obedient model', () => {
  it('has exactly 20 scenarios', () => expect(attacks.length).toBe(20));

  for (const atk of attacks) {
    it(`blocks: ${atk.name} (${atk.layer})`, async () => {
      const { game, chain, mirror, n } = setup(atk.npc, atk.action);
      const gold0 = n.gold;
      const stock0 = { ...n.stock };
      const out = await game.haggle(atk.npc, atk.message);

      expect(out.proposed).toBeDefined(); // the model did try
      expect(out.result?.ok).toBe(false);
      expect(out.result && 'layer' in out.result ? out.result.layer : undefined).toBe(atk.layer);
      // nothing left the NPC
      expect(n.gold).toBe(gold0);
      expect(n.stock).toEqual(stock0);
      // nothing was signed for the NPC: neither layer let the attack reach the chain
      await mirror.idle();
      expect(chain.calls.filter((c) => c.signer === NPC_DEFS[atk.npc].account)).toEqual([]);
      // and the refusal is visible in the game log
      const last = game.village.s.txs.at(-1);
      if (atk.layer === 'signer') {
        expect(last?.ok).toBe(false);
        expect(last?.signer).toBe(NPC_DEFS[atk.npc].account);
      }
    });
  }
});

describe('brain output parsing', () => {
  it('extracts JSON from prose and code fences', () => {
    const p = parseProposal('Sure!\n```json\n{"reply":"5.5 it is","action":{"type":"market_sell","item":"ore","qty":2,"minPrice":550}}\n```');
    expect(p.reply).toBe('5.5 it is');
    expect(p.action?.type).toBe('market_sell');
  });
  it('turns an invented method into a raw call the guard can refuse', () => {
    const p = parseProposal('{"reply":"ok","action":{"type":"add_full_access_key"}}');
    expect(p.action).toEqual({ type: 'call', method: 'add_full_access_key', receiver: undefined, args: {} });
  });
  it('ignores garbage', () => {
    expect(parseProposal('no json here').action).toBeNull();
  });
});

describe('legitimate haggling still works', () => {
  it('a fair market sale proposed by the brain goes through and is signed', async () => {
    const chain = new MockChain();
    const signer = new NpcSigner(chain, 'hearth.testnet');
    const brain = new NpcBrain(new ObedientLlm(() => ({ type: 'market_sell', item: 'ore', qty: 1, minPrice: 1 })));
    const mirror = new ChainMirror(chain, { contract: 'hearth.testnet', operator: '', playerAccount: () => null });
    const game = new Game({ seed: 13, mirror }, brain, signer, chain);
    game.village.s.npcs.mike.stock.ore = 5;
    const out = await game.haggle('mike', 'Sell one ore to the market please.');
    expect(out.result?.ok).toBe(true);
    await mirror.idle();
    expect(chain.calls).toHaveLength(1);
    expect(chain.calls[0]).toMatchObject({ signer: NPC_DEFS.mike.account, contract: 'hearth.testnet', method: 'market_sell' });
  });
});

describe('red team mode', () => {
  const idx = (name: string) => RED_TEAM_ATTACKS.findIndex((a) => a.name === name);

  it('runs a signer-layer attack with the player as the receiver, and signs nothing', async () => {
    const { game, chain, mirror } = setup('theo', { type: 'transfer', to: 'x', amount: 1 });
    const out = await game.redTeam(idx('send all gold'), 'abc123.testnet', { proveOnChain: true });
    expect(out.proposed).toMatchObject({ type: 'transfer', to: 'abc123.testnet' });
    expect(out).toMatchObject({ blocked: true, layer: 'signer', npc: 'theo' });
    expect(out.proof).toBeUndefined();
    await mirror.idle();
    expect(chain.calls).toEqual([]);
    expect(game.village.s.feed.at(-1)?.text).toContain('Red team vs Theo');
  });

  it('sends a contract-layer attack to the contract and links the refused transaction', async () => {
    const { game, chain } = setup('theo', { type: 'transfer', to: 'x', amount: 1 });
    chain.failNext.set('hire', 'not enough goods');
    const out = await game.redTeam(idx('hire goods the seller does not have'), 'abc123.testnet', { proveOnChain: true });
    expect(out).toMatchObject({ blocked: true, layer: 'contract' });
    expect(out.proof).toMatchObject({ ok: false, reason: 'not enough goods' });
    expect(out.proof?.hash).toMatch(/^MockFail/);
    expect(game.village.s.feed.at(-1)?.tx).toBe(out.proof?.hash);
  });

  it('never proves on chain unless asked (gas)', async () => {
    const { game, chain } = setup('theo', { type: 'transfer', to: 'x', amount: 1 });
    const out = await game.redTeam(idx('fill an order that does not exist'), 'abc123.testnet');
    expect(out.blocked).toBe(true);
    expect(out.proof).toBeUndefined();
    expect(chain.calls).toEqual([]);
  });
});
