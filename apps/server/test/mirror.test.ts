import { describe, expect, it } from 'vitest';
import { NPC_KEY_METHODS, NPC_DEFS, NPCS, OPERATOR_METHODS, playerSigner, txKind } from '@hearth/economy';
import { ChainMirror, lenientMax, lenientMin } from '../src/chain/mirror.ts';
import { MockChain, NpcSigner } from '../src/chain/signer.ts';
import { NpcBrain } from '../src/brain/brain.ts';
import { Game } from '../src/game.ts';

const CONTRACT = 'hearth.testnet';
const OPERATOR = 'hearth.testnet';

function mirror(opts: Partial<ConstructorParameters<typeof ChainMirror>[1]> = {}) {
  const chain = new MockChain();
  const m = new ChainMirror(chain, {
    contract: CONTRACT,
    operator: OPERATOR,
    playerAccount: (id) => (id.startsWith('bot') ? null : `p-${id}.${CONTRACT}`),
    minDayMs: 0,
    ...opts,
  });
  return { chain, m };
}

describe('chain mirror: translation', () => {
  it('maps raw production, crafting and deals to the NPC key', () => {
    const { m } = mirror();
    expect(m.translate(NPC_DEFS.mike.account, 'produce', { item: 'ore', qty: 7 })).toEqual([
      expect.objectContaining({ signer: NPC_DEFS.mike.account, method: 'produce', args: { item: 'ore', qty: 7 } }),
    ]);
    expect(m.translate(NPC_DEFS.theo.account, 'craft', { item: 'tools', crafts: 2 })?.[0]).toMatchObject({ method: 'craft', args: { item: 'tools', crafts: 2 } });
    expect(m.translate(NPC_DEFS.theo.account, 'hire', { seller: NPC_DEFS.mike.account, item: 'ore', qty: 3, price: 590 })?.[0].method).toBe('hire');
    expect(m.translate(NPC_DEFS.mike.account, 'produce', { item: 'ore', qty: 0 })).toBeNull();
  });

  it('gives market calls room for price drift, but keeps a bound', () => {
    const { m } = mirror();
    const [buy] = m.translate(NPC_DEFS.chloe.account, 'market_buy', { item: 'wheat', qty: 2, max_price: 200 })!;
    expect(buy.args).toEqual({ item: 'wheat', qty: 2, max_price: lenientMax(200) });
    expect(lenientMax(200)).toBe(260);
    const [sell] = m.translate(NPC_DEFS.jack.account, 'market_sell', { item: 'timber', qty: 2, min_price: 270 })!;
    expect(sell.args.min_price).toBe(lenientMin(270));
  });

  it('keeps stall trades in the engine', () => {
    const { m } = mirror();
    expect(m.translate(NPC_DEFS.chloe.account, 'stall_buy', { slot: 0, item: 'wheat', qty: 1, price: 190 })).toBeNull();
  });

  it('sends Bruno through the world and the market in the right order', () => {
    const { m } = mirror();
    const imp = m.translate(NPC_DEFS.bruno.account, 'world_trade', { item: 'wheat', qty: 3, side: 'import', market_price: 220 })!;
    expect(imp.map((c) => c.method)).toEqual(['world_trade', 'market_sell']);
    expect(imp[0].args).toEqual({ item: 'wheat', qty: 3, import: true });
    const exp = m.translate(NPC_DEFS.bruno.account, 'world_trade', { item: 'ore', qty: 2, side: 'export', market_price: 610 })!;
    expect(exp.map((c) => c.method)).toEqual(['market_buy', 'world_trade']);
    expect(m.translate(NPC_DEFS.bruno.account, 'world_trade', { item: 'sword', qty: 1, side: 'export' })).toBeNull();
  });

  it('relays wallet-less players through the operator, registering them once', () => {
    const { m } = mirror();
    const first = m.translate(playerSigner('khang'), 'market_buy', { item: 'wheat', qty: 3, max_price: 210 })!;
    expect(first.map((c) => c.method)).toEqual(['relay_register_player', 'relay_market_buy']);
    expect(first[1]).toMatchObject({ signer: OPERATOR, args: { player: `p-khang.${CONTRACT}`, item: 'wheat', qty: 3 } });
    const second = m.translate(playerSigner('khang'), 'market_sell', { item: 'wheat', qty: 1, min_price: 190 })!;
    expect(second.map((c) => c.method)).toEqual(['relay_market_sell']);
  });

  it('keeps bots and guild-paid actions off chain', () => {
    const { m } = mirror();
    expect(m.translate(playerSigner('bot3'), 'market_buy', { item: 'wheat', qty: 1, max_price: 210 })).toBeNull();
    expect(m.translate(playerSigner('khang'), 'place_order', { order_id: 4, item: 'sword', qty: 1, max_price: 2000, deadline_days: 3, guild: 'g' })).toBeNull();
  });
});

describe('chain mirror: queues', () => {
  it('never signs a method that is not on that NPC\'s key', async () => {
    const { m, chain } = mirror();
    const settled: string[] = [];
    m.onSettled = (_p, h) => settled.push(h);
    // Mike's key has no craft; a translation bug must not turn into a signed call
    (m as unknown as { enqueue: (c: unknown[]) => string }).enqueue([{ signer: NPC_DEFS.mike.account, method: 'craft', args: {}, tgas: 20 }]);
    await m.idle();
    expect(chain.calls).toHaveLength(0);
    expect(settled[0]).toContain('not on the mike key');
  });

  it('fills a relayed order by the same on-chain id once the relay has landed', async () => {
    const { m, chain } = mirror();
    expect(m.translate(NPC_DEFS.theo.account, 'fill_order', { order_id: 9, qty: 1, price: 1900 })).toBeNull();
    m.hook(playerSigner('khang'), 'place_order', { order_id: 9, item: 'sword', qty: 1, max_price: 2000, deadline_days: 3 });
    await m.idle();
    const placed = chain.calls.find((c) => c.method === 'relay_place_order')!;
    expect(placed.args.order_id).toBe(m.chainOrderId(9));
    expect(m.translate(NPC_DEFS.theo.account, 'fill_order', { order_id: 9, qty: 1, price: 1900 })?.[0].args.order_id).toBe(m.chainOrderId(9));
  });

  it('reports the contract error in place of the hash and keeps going', async () => {
    const { m, chain } = mirror();
    const settled: [string, string][] = [];
    m.onSettled = (p, h) => settled.push([p, h]);
    chain.failNext.set('hire', 'over the daily budget');
    const a = m.hook(NPC_DEFS.theo.account, 'hire', { seller: NPC_DEFS.mike.account, item: 'ore', qty: 3, price: 590 })!;
    const b = m.hook(NPC_DEFS.theo.account, 'craft', { item: 'tools', crafts: 1 })!;
    await m.idle();
    expect(settled).toContainEqual([a, 'failed:over the daily budget']);
    expect(settled.find(([p]) => p === b)?.[1]).toMatch(/^Mock/);
    expect(m.stats.failed).toBe(1);
  });

  it('keeps calls off chain when a key is backed up or the minute budget is spent', () => {
    const { m } = mirror({ maxQueue: 2, maxPerMinute: 1000 });
    const r = [1, 2, 3].map(() => m.hook(NPC_DEFS.mike.account, 'produce', { item: 'ore', qty: 5 }));
    expect(r[0]).toMatch(/^pending/);
    expect(r[2]).toBeNull();
    const { m: m2 } = mirror({ maxPerMinute: 1 });
    expect(m2.hook(NPC_DEFS.mike.account, 'produce', { item: 'ore', qty: 5 })).toMatch(/^pending/);
    expect(m2.hook(NPC_DEFS.jack.account, 'produce', { item: 'timber', qty: 5 })).toBeNull();
  });
});

describe('chain mirror: a whole game', () => {
  it('runs three days on the mock chain with only allowed calls, then settles every hash', async () => {
    const chain = new MockChain();
    const m = new ChainMirror(chain, { contract: CONTRACT, operator: OPERATOR, playerAccount: (id) => `p-${id}.${CONTRACT}`, minDayMs: 0, maxPerMinute: 10_000, maxQueue: 100 });
    const game = new Game({ seed: 7, mirror: m, worldPost: () => ({ source: 'test', raw: '{}', sha256: '00'.repeat(32) }) }, new NpcBrain(null), new NpcSigner(chain, CONTRACT), chain);
    game.join('khang', 'Khang');
    game.act('khang', { type: 'market_buy', item: 'wheat', qty: 3, maxPrice: 300 });
    game.act('khang', { type: 'place_order', item: 'sword', qty: 1, maxPrice: 2600, deadlineDays: 3 });
    for (let i = 0; i < 24 * 3; i++) game.tick();
    await m.idle();

    const methods = new Set(chain.calls.map((c) => c.method));
    for (const c of chain.calls) {
      const npc = NPCS.find((id) => NPC_DEFS[id].account === c.signer);
      if (npc) expect(NPC_KEY_METHODS[npc] as string[]).toContain(c.method);
      else {
        expect(c.signer).toBe(OPERATOR);
        expect(OPERATOR_METHODS as readonly string[]).toContain(c.method);
      }
    }
    for (const m of ['produce', 'craft', 'hire', 'reconcile', 'post_world_data', 'relay_register_player', 'relay_market_buy', 'relay_place_order']) {
      expect(methods, m).toContain(m);
    }
    expect(methods).not.toContain('ft_transfer');
    // the feed shows real hashes, off-chain marks or failures, never a stuck "pending"
    expect(game.village.s.feed.some((e) => e.tx && txKind(e.tx) === 'pending')).toBe(false);
    expect(game.village.s.feed.some((e) => e.tx && txKind(e.tx) === 'chain')).toBe(true);
    // registration happened once
    expect(chain.calls.filter((c) => c.method === 'relay_register_player')).toHaveLength(1);
  });

  it('reconciles at most once per minDayMs of real time', () => {
    let now = 0;
    const { m, chain } = mirror({ minDayMs: 60_000, now: () => now });
    const game = new Game({ seed: 1, mirror: m }, new NpcBrain(null), new NpcSigner(chain, CONTRACT), chain);
    expect(m.startDay(game.village)).toBe(true);
    now += 10_000;
    expect(m.startDay(game.village)).toBe(false);
    now += 60_000;
    expect(m.startDay(game.village)).toBe(true);
  });
});
