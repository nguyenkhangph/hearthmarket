/**
 * Stall board smoke test on testnet, against the stalls contract the game contract points at
 * (`set_stalls`). Run it on stalls-test.<contract> before the real stalls account:
 *
 *   npm run stalls:smoke
 *
 * Needs in .env (written by `npm run setup:testnet`): HEARTH_CONTRACT, ORACLE_ACCOUNT,
 * ORACLE_KEY, NPC_KEY_BRUNO. No owner key: it signs only what the server signs.
 *
 * A fresh test player (smoke<time>.<contract>, relayed, no wallet) buys a little ore, then:
 *   1. lists it            → goods in the stalls contract's escrow
 *   2. a stranger cancels  → must FAIL ("not your listing")
 *   3. Bruno buys it       → seller paid gold, Bruno gets the ore
 *   4. Bruno buys again    → refunded (sold twice is impossible)
 *   5. lists again, the seller cancels → goods back
 *   6. withdraw with nothing owed      → must FAIL ("nothing to withdraw")
 * Each step prints its transaction hash for the explorer.
 */
import { Account, JsonRpcProvider, type KeyPairString } from 'near-api-js';

const contract = process.env.HEARTH_CONTRACT ?? '';
const opAccount = process.env.ORACLE_ACCOUNT || contract;
const opKey = (process.env.ORACLE_KEY ?? '') as KeyPairString;
const brunoKey = (process.env.NPC_KEY_BRUNO ?? '') as KeyPairString;
const rpcUrl = (process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com').split(',')[0].trim();
const explorer = (h: string) => `https://testnet.nearblocks.io/txns/${h}`;

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
if (!contract || !opKey.startsWith('ed25519:') || !brunoKey.startsWith('ed25519:')) fail('Set HEARTH_CONTRACT, ORACLE_KEY and NPC_KEY_BRUNO in .env (npm run setup:testnet writes them).');

const provider = new JsonRpcProvider({ url: rpcUrl });
const op = new Account(opAccount, provider, opKey);
const brunoId = `bruno.${contract}`;
const bruno = new Account(brunoId, provider, brunoKey);
const view = <T>(contractId: string, method: string, args: Record<string, unknown> = {}) => provider.callFunction({ contractId, method, args }) as Promise<T>;

const stalls = await view<string | null>(contract, 'get_stalls');
if ((await view<string>(contract, 'get_version')) !== '6') fail(`${contract} is not version 6 yet.`);
if (!stalls) fail(`${contract} has no stalls contract yet: npm run setup:testnet -- --stalls stalls-test.${contract}`);
console.log(`game ${contract} → stalls ${stalls}\n`);

const TGAS = 150n * 1_000_000_000_000n;
async function call(who: Account, method: string, args: Record<string, unknown>) {
  const res = (await who.callFunctionRaw({ contractId: contract, methodName: method, args, gas: TGAS, deposit: 0n })) as unknown as { transaction?: { hash?: string } };
  return res.transaction?.hash ?? '?';
}
let failures = 0;
async function ok(label: string, who: Account, method: string, args: Record<string, unknown>) {
  try {
    console.log(`✓ ${label}  ${explorer(await call(who, method, args))}`);
  } catch (e) {
    failures++;
    console.log(`✗ ${label}: ${(e as Error).message.slice(0, 200)}`);
  }
}
async function refused(label: string, why: RegExp, who: Account, method: string, args: Record<string, unknown>) {
  try {
    const h = await call(who, method, args);
    failures++;
    console.log(`✗ ${label}: went through, it should have failed  ${explorer(h)}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (why.test(msg)) console.log(`✓ ${label}: refused as expected (${why.source})`);
    else {
      failures++;
      console.log(`✗ ${label}: failed for another reason: ${msg.slice(0, 200)}`);
    }
  }
}
/**
 * Payouts are separate receipts that land a few blocks after the transaction returns, and views
 * read final state, which trails by about two blocks: poll up to ~15 s before calling it a failure.
 */
async function eventually(label: string, test: () => Promise<boolean>, detail: () => Promise<string> = async () => '') {
  for (let i = 0; i < 15; i++) {
    if (await test().catch(() => false)) return check(label, true);
    await new Promise((r) => setTimeout(r, 1000));
  }
  check(label, false, await detail().catch(() => ''));
}
function check(label: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`);
}

const gold = async (a: string) => BigInt((await view<string>(contract, 'ft_balance_of', { account_id: a })) ?? '0');
const ore = async (a: string) => Number((await view<string>(contract, 'mt_balance_of', { account_id: a, token_id: 'ore' })) ?? '0');
type Listing = { status: string; buyer: string | null };

const player = `smoke${Math.floor(Date.now() / 1000) % 1e8}.${contract}`;
const stranger = `stranger${Math.floor(Date.now() / 1000) % 1e8}.${contract}`;
const id1 = 9e12 + (Date.now() % 1e9);
const id2 = id1 + 1;

await ok(`register test player ${player}`, op, 'relay_register_player', { player, start_gold: '5000' });
await ok('register a stranger', op, 'relay_register_player', { player: stranger, start_gold: '5000' });
await ok('test player buys 3 ore at the market', op, 'relay_market_buy', { player, item: 'ore', qty: 3, max_price: 2000 });
const ore0 = await ore(player);
check('test player holds ore', ore0 >= 3, `${ore0}`);

// a price Bruno pays: well under the market (the chain does not check the price, only the escrow)
const price = 300;
await ok(`1. list 3 ore at ${price / 100} gold`, op, 'relay_stall_list', { player, listing_id: id1, item: 'ore', qty: 3, price: String(price) });
check('   goods left the player', (await ore(player)) === ore0 - 3);
check('   listing open in the stalls contract', (await view<Listing>(stalls, 'get_listing', { listing_id: id1 }))?.status === 'open');

await refused('2. a stranger cancels', /not your listing/, op, 'relay_stall_cancel', { player: stranger, listing_id: id1 });

const sellerGold = await gold(player);
const brunoOre = await ore(brunoId);
await ok('3. Bruno buys the listing', bruno, 'npc_stall_buy', { listing_id: id1, amount: String(price * 3) });
const l1 = await view<Listing>(stalls, 'get_listing', { listing_id: id1 });
check('   listing sold to Bruno', l1?.status === 'sold' && l1.buyer === brunoId, JSON.stringify(l1));
await eventually('   seller paid', async () => (await gold(player)) - sellerGold === BigInt(price * 3), async () => `${(await gold(player)) - sellerGold}`);
await eventually('   Bruno got the ore', async () => (await ore(brunoId)) - brunoOre === 3);

const brunoGold = await gold(brunoId);
await ok('4. Bruno buys the same listing again (refund expected)', bruno, 'npc_stall_buy', { listing_id: id1, amount: String(price * 3) });
await eventually('   Bruno got his gold back', async () => (await gold(brunoId)) === brunoGold);

await ok('test player buys 1 ore for the second listing', op, 'relay_market_buy', { player, item: 'ore', qty: 1, max_price: 2000 });
const ore1 = await ore(player);
await ok('5. list 1 ore', op, 'relay_stall_list', { player, listing_id: id2, item: 'ore', qty: 1, price: String(price) });
await ok('   the seller cancels', op, 'relay_stall_cancel', { player, listing_id: id2 });
check('   listing cancelled', (await view<Listing>(stalls, 'get_listing', { listing_id: id2 }))?.status === 'cancelled');
await eventually('   ore back with the seller', async () => (await ore(player)) === ore1, async () => `has ${await ore(player)}, expected ${ore1}; owed by stalls: ${JSON.stringify(await view(stalls, 'owed_to', { account_id: player }))}`);

await refused('6. withdraw with nothing owed', /nothing to withdraw/, op, 'relay_stall_withdraw', { account_id: stranger });

console.log(failures ? `\n✗ ${failures} check(s) failed. Keep STALLS_ONCHAIN off.\n` : '\n✓ All stall checks passed. Safe to point the game at the real stalls contract.\n');
process.exit(failures ? 1 : 0);
