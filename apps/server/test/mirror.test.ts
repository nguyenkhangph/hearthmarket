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
    const b = m.hook(NPC_DEFS.theo.account, 'market_buy', { item: 'ore', qty: 1, max_price: 700 })!;
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

  it('turns the contract\'s day every game day, also between two reconciles', async () => {
    let now = 0;
    const { m, chain } = mirror({ minDayMs: 600_000, now: () => now });
    const game = new Game({ seed: 1, mirror: m }, new NpcBrain(null), new NpcSigner(chain, CONTRACT), chain);
    m.startDay(game.village);
    for (let i = 0; i < 3; i++) {
      now += 120_000;
      m.startDay(game.village);
    }
    await m.idle();
    const ops = chain.calls.filter((c) => c.signer === OPERATOR).map((c) => c.method);
    expect(ops.filter((x) => x === 'reconcile')).toHaveLength(1);
    expect(ops.filter((x) => x === 'advance_day')).toHaveLength(3);
  });
});

describe('chain mirror: gas budget', () => {
  it('sends a day of production as one produce per NPC and item, and settles every feed line with it', async () => {
    const { m, chain } = mirror({ batchProduce: true });
    const settled = new Map<string, string>();
    m.onSettled = (p, h) => settled.set(p, h);
    const a = m.hook(NPC_DEFS.mike.account, 'produce', { item: 'ore', qty: 5 })!;
    const b = m.hook(NPC_DEFS.mike.account, 'produce', { item: 'ore', qty: 4 })!;
    const c = m.hook(NPC_DEFS.jack.account, 'produce', { item: 'timber', qty: 9 })!;
    expect(txKind(a)).toBe('pending');
    expect(chain.calls).toHaveLength(0);
    expect(m.flushProduce()).toHaveLength(2);
    await m.idle();
    expect(chain.calls.map((x) => [x.signer, x.method, x.args])).toEqual([
      [NPC_DEFS.mike.account, 'produce', { item: 'ore', qty: 9 }],
      [NPC_DEFS.jack.account, 'produce', { item: 'timber', qty: 9 }],
    ]);
    expect(settled.get(a)).toBe(settled.get(b));
    expect(txKind(settled.get(a)!)).toBe('chain');
    expect(txKind(settled.get(c)!)).toBe('chain');
  });

  it('puts the day\'s production on chain before the NPC sells it or a buyer hires it', async () => {
    const { m, chain } = mirror({ batchProduce: true, maxPerMinute: 1000 });
    // a slow chain for produce: without the wait, the hire on Theo's queue would land first
    const call = chain.call.bind(chain);
    chain.call = async (signer, contract, method, args) => {
      if (method === 'produce') await new Promise((r) => setTimeout(r, 30));
      return call(signer, contract, method, args);
    };
    m.hook(NPC_DEFS.jack.account, 'produce', { item: 'timber', qty: 6 });
    m.hook(NPC_DEFS.mike.account, 'produce', { item: 'ore', qty: 5 });
    m.hook(NPC_DEFS.jack.account, 'market_sell', { item: 'timber', qty: 4, min_price: 270 });
    m.hook(NPC_DEFS.theo.account, 'hire', { seller: NPC_DEFS.mike.account, item: 'ore', qty: 3, price: 590 });
    await m.idle();
    const order = chain.calls.map((c) => `${c.signer.split('.')[0]}:${c.method}`);
    expect(order.indexOf('jack:produce')).toBeLessThan(order.indexOf('jack:market_sell'));
    expect(order.indexOf('mike:produce')).toBeLessThan(order.indexOf('theo:hire'));
    expect(chain.calls.find((c) => c.method === 'produce' && c.signer === NPC_DEFS.mike.account)?.args).toEqual({ item: 'ore', qty: 5 });
    // nothing is sent twice at the end of the day
    m.flushProduce();
    await m.idle();
    expect(chain.calls.filter((c) => c.method === 'produce')).toHaveLength(2);
  });

  it('caps the batch at the contract\'s daily production cap', async () => {
    const { m, chain } = mirror({ batchProduce: true });
    for (let i = 0; i < 4; i++) m.hook(NPC_DEFS.buba.account, 'produce', { item: 'wheat', qty: 5 });
    m.flushProduce();
    await m.idle();
    expect(chain.calls[0].args).toEqual({ item: 'wheat', qty: 12 });
  });

  it('keeps an NPC within its calls per hour, but never caps order fills or player relays', async () => {
    let now = 0;
    const { m } = mirror({ npcCallsPerHour: 2, now: () => now, maxPerMinute: 1000, maxQueue: 100 });
    const hire = () => m.hook(NPC_DEFS.theo.account, 'hire', { seller: NPC_DEFS.mike.account, item: 'ore', qty: 1, price: 590 });
    expect(hire()).toMatch(/^pending/);
    expect(hire()).toMatch(/^pending/);
    expect(hire()).toBeNull();
    expect(m.stats.budgeted).toBe(1);
    // another NPC has its own budget
    expect(m.hook(NPC_DEFS.chloe.account, 'craft', { item: 'bread', crafts: 1 })).toMatch(/^pending/);
    // escrow moves are never skipped
    m.hook(playerSigner('khang'), 'place_order', { order_id: 1, item: 'sword', qty: 1, max_price: 2000, deadline_days: 3 });
    await m.idle();
    expect(m.hook(NPC_DEFS.mike.account, 'fill_order', { order_id: 1, qty: 1, price: 1900 })).toMatch(/^pending/);
    expect(m.hook(playerSigner('khang'), 'market_buy', { item: 'wheat', qty: 1, max_price: 210 })).toMatch(/^pending/);
    // Theo's skipped hire left his chain stock short: goods-spending calls wait for the reconcile
    expect(m.hook(NPC_DEFS.theo.account, 'craft', { item: 'sword', crafts: 1 })).toBeNull();
    expect(m.stats.heldBack).toBe(1);
    expect(m.stats.unsynced).toBe(2); // the budgeted hire and the held-back craft wait for the reconcile
    now += 3_600_001;
    expect(m.hook(NPC_DEFS.theo.account, 'market_buy', { item: 'ore', qty: 1, max_price: 700 })).toMatch(/^pending/);
  });

  it('holds back goods-spending calls of a drifted NPC until the next reconcile lands', async () => {
    let now = 0;
    const { m, chain } = mirror({ npcCallsPerHour: 1, now: () => now, maxPerMinute: 1000, maxQueue: 100, minDayMs: 0 });
    const game = new Game({ seed: 3, mirror: m }, new NpcBrain(null), new NpcSigner(chain, CONTRACT), chain);
    const buy = () => m.hook(NPC_DEFS.theo.account, 'market_buy', { item: 'ore', qty: 1, max_price: 700 });
    expect(buy()).toMatch(/^pending/);
    expect(buy()).toBeNull(); // over budget: the chain misses this ore
    expect(m.hook(NPC_DEFS.theo.account, 'craft', { item: 'sword', crafts: 1 })).toBeNull();
    expect(m.hook(NPC_DEFS.jack.account, 'hire', { seller: NPC_DEFS.theo.account, item: 'ore', qty: 1, price: 600 })).toBeNull();
    expect(m.stats.unsynced).toBe(3);
    expect(m.startDay(game.village)).toBe(true);
    await m.idle();
    // the reconcile carried what the game kept: nothing waits any more
    expect(m.stats.unsynced).toBe(0);
    expect(m.stats.reconciled).toBe(3);
    now += 3_600_001;
    expect(m.hook(NPC_DEFS.theo.account, 'craft', { item: 'sword', crafts: 1 })).toMatch(/^pending/);
  });

  it('keeps an NPC that is low on gas money in the game instead of failing on chain', () => {
    const { m } = mirror({ minNpcNear: 0.15, maxPerMinute: 1000 });
    m.balances = { [NPC_DEFS.mike.account]: 0.05, [NPC_DEFS.jack.account]: 1.2 };
    expect(m.hook(NPC_DEFS.mike.account, 'market_sell', { item: 'ore', qty: 1, min_price: 300 })).toBeNull();
    expect(m.hook(NPC_DEFS.jack.account, 'market_sell', { item: 'timber', qty: 1, min_price: 300 })).toMatch(/^pending/);
    expect(m.stats.unsynced).toBe(1);
  });

  it('spends no gas while paused, and re-anchors the chain when a player comes back', () => {
    let now = 0;
    const { m, chain } = mirror({ minDayMs: 600_000, now: () => now });
    const game = new Game({ seed: 3, mirror: m }, new NpcBrain(null), new NpcSigner(chain, CONTRACT), chain);
    expect(m.startDay(game.village)).toBe(true);
    m.setActive(false);
    expect(m.hook(NPC_DEFS.mike.account, 'produce', { item: 'ore', qty: 3 })).toBeNull();
    expect(m.stats.paused).toBe(1);
    now += 1000;
    expect(m.startDay(game.village)).toBe(false);
    m.setActive(true);
    now += 1000; // well inside minDayMs: resuming forces a fresh reconcile anyway
    expect(m.startDay(game.village)).toBe(true);
  });

  it('warns about accounts that are running out of gas', async () => {
    const lines: string[] = [];
    const chain = Object.assign(new MockChain(), { balance: async (a: string) => (a === NPC_DEFS.theo.account ? 0.002 : 0.4) });
    const m = new ChainMirror(chain, { contract: CONTRACT, operator: OPERATOR, playerAccount: () => null, log: (l) => lines.push(l) });
    const b = await m.checkBalances(0.1);
    expect(b[NPC_DEFS.theo.account]).toBe(0.002);
    expect(lines.filter((l) => l.startsWith('LOW BALANCE'))).toEqual([expect.stringContaining(NPC_DEFS.theo.account)]);
  });
});

describe('chain mirror: drift found while calls wait in the queue', () => {
  it('holds back a queued craft when the NPC call before it failed', async () => {
    const chain = new MockChain();
    const call = chain.call.bind(chain);
    chain.call = async (signer, contract, method, args) => {
      if (method === 'market_buy') throw new Error('Smart contract panicked: price moved');
      return call(signer, contract, method, args);
    };
    const m = new ChainMirror(chain, { contract: CONTRACT, operator: CONTRACT, playerAccount: () => null, maxPerMinute: 1000, maxQueue: 100 });
    m.hook(NPC_DEFS.chloe.account, 'market_buy', { item: 'wheat', qty: 3, max_price: 300 });
    const craft = m.hook(NPC_DEFS.chloe.account, 'craft', { item: 'bread', crafts: 3 });
    expect(craft).toMatch(/^pending/);
    await m.idle();
    expect(chain.calls.some((c) => c.method === 'craft')).toBe(false);
    expect(m.stats.unsynced).toBe(1);
    expect(m.stats.failed).toBe(1);
  });
});

describe('chain mirror: trust boundary (contract version 5)', () => {
  it('a claimed player is put in self-custody on chain and left out of reconcile', async () => {
    const { m, chain } = mirror({ maxPerMinute: 1000, maxQueue: 100 });
    m.contractVersion = 5;
    const game = new Game({ seed: 3, mirror: m }, new NpcBrain(null), new NpcSigner(chain, CONTRACT), chain);
    game.join('khang', 'Khang');
    game.join('lan', 'Lan');
    await m.idle();
    expect(m.claimed(`p-khang.${CONTRACT}`)).toMatch(/^pending/);
    await m.idle();
    expect(chain.calls.find((c) => c.method === 'relay_self_custody')?.args).toEqual({ player: `p-khang.${CONTRACT}` });
    expect(m.startDay(game.village)).toBe(true);
    await m.idle();
    const rec = chain.calls.filter((c) => c.method === 'reconcile').at(-1)!;
    const accounts = (rec.args.gold as [string, string][]).map(([a]) => a);
    expect(accounts).toContain(`p-lan.${CONTRACT}`);
    expect(accounts).not.toContain(`p-khang.${CONTRACT}`);
  });
});

describe('chain mirror: stall board (STALLS_ONCHAIN)', () => {
  it('keeps listings in the game when the flag is off or the contract is older than version 6', () => {
    const off = mirror().m;
    off.contractVersion = 6;
    expect(off.translate(playerSigner('khang'), 'list_item', { listing_id: 5, item: 'ore', qty: 2, price: 550 })).toBeNull();
    const old = mirror({ stalls: true }).m;
    old.contractVersion = 5;
    expect(old.translate(playerSigner('khang'), 'list_item', { listing_id: 5, item: 'ore', qty: 2, price: 550 })).toBeNull();
  });

  it('relays list, NPC buy, player buy and cancel through the game contract, in order', async () => {
    const { m, chain } = mirror({ stalls: true, maxPerMinute: 1000, maxQueue: 100 });
    m.contractVersion = 6;
    const khang = playerSigner('khang');
    expect(m.hook(khang, 'list_item', { listing_id: 5, item: 'ore', qty: 2, price: 550 })).toBeTruthy();
    // the NPC buy follows at once: it waits for the listing relay to land
    expect(m.hook(NPC_DEFS.bruno.account, 'npc_stall_buy', { listing_id: 5, amount: 1100 })).toBeTruthy();
    expect(m.hook(khang, 'list_item', { listing_id: 6, item: 'wheat', qty: 1, price: 200 })).toBeTruthy();
    expect(m.hook(playerSigner('lan'), 'buy_listing', { listing_id: 6, amount: 200 })).toBeTruthy();
    expect(m.hook(khang, 'list_item', { listing_id: 7, item: 'wheat', qty: 1, price: 200 })).toBeTruthy();
    expect(m.hook(khang, 'cancel_listing', { listing_id: 7 })).toBeTruthy();
    // never listed on chain: stays in the game
    expect(m.hook(NPC_DEFS.bruno.account, 'npc_stall_buy', { listing_id: 99, amount: 100 })).toBeNull();
    await m.idle();
    const stall = chain.calls.filter((c) => c.method.includes('stall'));
    // the operator's calls land in order; Bruno's buy lands after the listing it buys
    expect(stall.filter((c) => c.signer === OPERATOR).map((c) => c.method)).toEqual([
      'relay_stall_list', 'relay_stall_list', 'relay_stall_buy', 'relay_stall_list', 'relay_stall_cancel',
    ]);
    const list = stall[0];
    expect(list.args).toMatchObject({ player: `p-khang.${CONTRACT}`, item: 'ore', qty: 2, price: '550' });
    const npcBuy = stall.findIndex((c) => c.method === 'npc_stall_buy');
    expect(npcBuy).toBeGreaterThan(0);
    expect(stall[npcBuy]).toMatchObject({ signer: NPC_DEFS.bruno.account, args: { listing_id: list.args.listing_id, amount: '1100' } });
    expect(stall.find((c) => c.method === 'relay_stall_buy')?.args).toMatchObject({ player: `p-lan.${CONTRACT}`, amount: '200' });
    for (const c of stall) {
      if (c.signer === OPERATOR) expect(OPERATOR_METHODS as readonly string[]).toContain(c.method);
      else expect(NPC_KEY_METHODS.bruno as string[]).toContain(c.method);
    }
  });

  it('a whole game with listings on chain signs only allowed calls', async () => {
    const chain = new MockChain();
    const m = new ChainMirror(chain, { contract: CONTRACT, operator: OPERATOR, playerAccount: (id) => `p-${id}.${CONTRACT}`, minDayMs: 0, maxPerMinute: 10_000, maxQueue: 100, stalls: true });
    m.contractVersion = 6;
    const game = new Game({ seed: 7, mirror: m }, new NpcBrain(null), new NpcSigner(chain, CONTRACT), chain);
    game.join('khang', 'Khang');
    game.village.s.players.khang.stock.ore = 6;
    const ore = game.village.s.market.stock.ore;
    const { midPrice } = await import('@hearth/economy');
    expect(game.act('khang', { type: 'list_item', item: 'ore', qty: 3, price: Math.ceil(midPrice('ore', ore) * 0.6) }).ok).toBe(true);
    for (let i = 0; i < 24 * 2; i++) game.tick();
    await m.idle();
    const methods = chain.calls.map((c) => c.method);
    expect(methods).toContain('relay_stall_list');
    expect(methods).toContain('npc_stall_buy');
    for (const c of chain.calls) {
      const npc = NPCS.find((id) => NPC_DEFS[id].account === c.signer);
      if (npc) expect(NPC_KEY_METHODS[npc] as string[]).toContain(c.method);
      else expect(OPERATOR_METHODS as readonly string[]).toContain(c.method);
    }
  });
});

describe('chain mirror: stall sweep after a restart', () => {
  it('cancels listings an earlier run left in escrow, and follows landed listings with the flag off', async () => {
    const { m, chain } = mirror({ stalls: true, maxPerMinute: 1000, maxQueue: 100 });
    m.contractVersion = 6;
    expect(m.hook(playerSigner('khang'), 'list_item', { listing_id: 3, item: 'ore', qty: 1, price: 500 })).toBeTruthy();
    await m.idle();
    const mine = Number(chain.calls.find((c) => c.method === 'relay_stall_list')!.args.listing_id);
    expect(m.sweepStalls([{ id: 42, seller: 'old.testnet' }, { id: mine, seller: `p-khang.${CONTRACT}` }])).toBe(1);
    await m.idle();
    expect(chain.calls.filter((c) => c.method === 'relay_stall_cancel').map((c) => c.args)).toEqual([{ player: 'old.testnet', listing_id: 42 }]);
    // flag switched off later: the listing already in escrow is still bought on chain
    (m as unknown as { opts: { stalls: boolean } }).opts.stalls = false;
    expect(m.hook(NPC_DEFS.bruno.account, 'npc_stall_buy', { listing_id: 3, amount: 500 })).toBeTruthy();
    expect(m.translate(playerSigner('khang'), 'list_item', { listing_id: 4, item: 'ore', qty: 1, price: 500 })).toBeNull();
  });
});

describe('chain mirror: crafts that would fail', () => {
  it('holds back a craft whose inputs are not on chain, and the NPC\'s next sale with it', async () => {
    const goods: Record<string, number> = { ore: 1, timber: 5 };
    const { m, chain } = mirror({ maxPerMinute: 1000, maxQueue: 100, goodsOf: async (_a, item) => goods[item] });
    const theo = NPC_DEFS.theo.account;
    expect(m.hook(theo, 'craft', { item: 'sword', crafts: 2 })).toBeTruthy(); // needs 4 ore
    // queued behind the craft: when the craft is held back, the sale is held back too
    m.hook(theo, 'market_sell', { item: 'sword', qty: 2, min_price: 100 });
    await m.idle();
    expect(chain.calls.filter((c) => c.method === 'craft' || c.method === 'market_sell')).toHaveLength(0);
    expect(m.stats.failed).toBe(0);
    expect(m.stats.heldBack).toBeGreaterThanOrEqual(2);
    goods.ore = 10;
    const { m: m2, chain: chain2 } = mirror({ maxPerMinute: 1000, maxQueue: 100, goodsOf: async (_a, item) => goods[item] });
    expect(m2.hook(theo, 'craft', { item: 'sword', crafts: 2 })).toBeTruthy();
    await m2.idle();
    expect(chain2.calls.filter((c) => c.method === 'craft')).toHaveLength(1);
  });

  it('a delivery kept off chain (the AI rival) marks the NPC, so its spending waits for the reconcile', () => {
    const { m } = mirror();
    expect(m.hook(playerSigner('ai-rival'), 'deliver_request', { request_id: 1, npc: NPC_DEFS.chloe.account, item: 'wheat', qty: 3, price: 250, bonus: 300 })).toBeNull();
    expect(m.hook(NPC_DEFS.chloe.account, 'market_sell', { item: 'bread', qty: 2, min_price: 100 })).toBeNull();
    expect(m.stats.heldBack).toBe(1);
  });
});
