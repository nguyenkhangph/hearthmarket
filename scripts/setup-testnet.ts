/**
 * Testnet setup, after the contract (version 2) is deployed and initialised:
 *
 *   npm run setup:testnet -- --dry-run     # show the plan, send nothing
 *   npm run setup:testnet                  # do it
 *
 * Needs in .env:
 *   HEARTH_CONTRACT=your-name.testnet            (the deployed contract account)
 *   OWNER_PRIVATE_KEY=ed25519:...                (full-access key of that account; remove it afterwards)
 *
 * Safe to run again. Each run:
 *  1. creates the 6 NPC sub-accounts (mike.<contract>, ...) if missing, 0.5 NEAR each, with
 *     the owner's key as their full-access key (the server never holds it); tops up any NPC
 *     below 0.25 NEAR back to 0.5 NEAR,
 *  2. replaces each NPC's function-call keys with one new key: receiver = the contract,
 *     methods = that NPC's list only (NPC_KEY_METHODS), e.g. Mike: produce + trading,
 *  3. registers each NPC in the contract (daily budget, raw goods, start gold) and sets
 *     who may craft what (Chloe: bread; Theo: tools, sword),
 *  4. replaces the operator's function-call key on the contract account: reconcile, world
 *     data, player relays, badges (OPERATOR_METHODS); never an NPC method,
 *  5. writes the new keys (and a PLAYER_KEY_SECRET if missing) into .env. Secrets are never printed.
 *
 * Function-call keys get no gas allowance cap: what a key can burn is capped by its account's
 * small balance, and the method list is what keeps it harmless.
 *
 * near-api-js 7.x. Verify the API on https://docs.near.org/tools/near-api if this breaks.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider, KeyPairEd25519, KeyPairSigner, parseNearAmount, type KeyPairString } from 'near-api-js';
import { NPCS, NPC_DEFS, NPC_KEY_METHODS, OPERATOR_METHODS, RULES, g, setContractAccount, type NpcId } from '../packages/economy/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const dry = process.argv.includes('--dry-run');

const contract = process.env.HEARTH_CONTRACT ?? '';
const ownerKey = (process.env.OWNER_PRIVATE_KEY ?? '') as KeyPairString;
const rpcList = process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://testnet-rpc.intea.rs';
const rpcUrl = rpcList.split(',')[0].trim();

if (!contract || contract === 'hearth.testnet') fail('Set HEARTH_CONTRACT in .env to your deployed contract account (e.g. hearthmarket.testnet).');
if (!ownerKey.startsWith('ed25519:')) fail('Set OWNER_PRIVATE_KEY=ed25519:... in .env (full-access key of the contract account).');
setContractAccount(contract);

const provider = new JsonRpcProvider({ url: rpcUrl });
const owner = new Account(contract, provider, ownerKey);
const ownerPub = (await KeyPairSigner.fromSecretKey(ownerKey).getPublicKey()).toString();

const RAW: Partial<Record<NpcId, string[]>> = { mike: ['ore'], jack: ['timber'], buba: ['wheat'] };
const CRAFTS: Partial<Record<NpcId, string[]>> = { chloe: ['bread'], theo: ['tools', 'sword'] };
const env: Record<string, string> = { CHAIN: 'near', HEARTH_CONTRACT: contract, NEAR_RPC_URL: rpcList, VITE_HEARTH_CONTRACT: contract };
const NEAR = (x: `${number}`) => BigInt(parseNearAmount(x)!);

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function exists(accountId: string) {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

async function view<T>(method: string, args: Record<string, unknown>): Promise<T | undefined> {
  return provider.callFunction({ contractId: contract, method, args }) as Promise<T | undefined>;
}

async function step(label: string, fn: () => Promise<unknown>) {
  if (dry) {
    console.log(`  [dry-run] ${label}`);
    return;
  }
  process.stdout.write(`  ${label} … `);
  try {
    await fn();
    console.log('ok');
  } catch (e) {
    console.log('FAILED');
    fail(`${label}: ${(e as Error).message}`);
  }
}

/** Function-call keys on an account (full-access keys are never touched). */
async function functionCallKeys(acc: Account): Promise<string[]> {
  const list = await acc.getAccessKeyList();
  return list.keys.filter((k) => !JSON.stringify(k.access_key.permission).includes('FullAccess')).map((k) => String(k.public_key));
}

async function replaceKeys(acc: Account, label: string, methods: readonly string[]): Promise<string | undefined> {
  const old = await functionCallKeys(acc).catch(() => [] as string[]);
  for (const pk of old) await step(`${label}: delete old function-call key ${pk.slice(0, 16)}…`, () => acc.deleteKey(pk));
  const kp = KeyPairEd25519.fromRandom();
  await step(`${label}: add function-call key → ${contract} [${methods.join(', ')}]`, () =>
    acc.addFunctionCallAccessKey({ publicKey: kp.getPublicKey().toString(), contractId: contract, methodNames: [...methods] }),
  );
  return dry ? undefined : kp.toString();
}

console.log(`\nHearthmarket testnet setup · contract ${contract} · ${rpcUrl}${dry ? ' · DRY RUN' : ''}\n`);

if (!(await exists(contract))) fail(`${contract} does not exist on testnet. Create and deploy it first (docs/testnet.md).`);
let version = '';
try {
  version = (await view<string>('get_version', {})) ?? '';
} catch {
  try {
    await view('get_economy', {});
    fail(`${contract} runs contract version 1. Deploy the new wasm with the "migrate" init call first (docs/testnet.md, "Upgrade").`);
  } catch {
    fail(`${contract} has no initialised hearth contract. Deploy it and call new(...) first (docs/testnet.md).`);
  }
}
if (version !== '2') fail(`expected contract version 2, found "${version}". Rebuild and redeploy contracts/hearth.`);
const [, oracle] = (await view<[string, string]>('get_roles', {})) ?? ['', ''];
if (oracle !== contract) console.log(`! the contract's oracle is ${oracle}; the operator key below goes on ${contract}. Relays will fail unless they match.\n`);

for (const id of NPCS) {
  const def = NPC_DEFS[id];
  const accountId = def.account;
  console.log(`${def.name} (${accountId})`);
  const npcAccount = new Account(accountId, provider, ownerKey);

  if (await exists(accountId)) {
    const bal = await npcAccount.getBalance().catch(() => 0n);
    if (bal < NEAR('0.25')) await step(`top up to 0.5 NEAR (has ${(Number(bal) / 1e24).toFixed(3)})`, () => owner.transfer({ receiverId: accountId, amount: NEAR('0.5') - bal }));
    else console.log(`  balance ${(Number(bal) / 1e24).toFixed(3)} NEAR`);
  } else {
    await step('create sub-account, 0.5 NEAR', () => owner.createSubAccount({ accountOrPrefix: id, publicKey: ownerPub, nearToTransfer: parseNearAmount('0.5') }));
  }

  const key = await replaceKeys(npcAccount, def.name, NPC_KEY_METHODS[id]);
  if (key) env[`NPC_KEY_${id.toUpperCase()}`] = key;

  let registered = false;
  try {
    registered = !!(await view('get_npc', { account_id: accountId }));
  } catch {
    /* treat as not registered */
  }
  if (registered) console.log('  already registered in the contract');
  else {
    await step(`register_npc (budget ${def.dailyBudget / 100} gold)`, () =>
      owner.callFunction({
        contractId: contract,
        methodName: 'register_npc',
        args: { account: accountId, daily_budget: def.dailyBudget, produces: RAW[id] ?? [], merchant: id === 'bruno', start_gold: id === 'bruno' ? g(400) : RULES.npcStartGold },
      }),
    );
  }
  if (CRAFTS[id]) {
    const have = (await view<string[]>('get_crafts', { account_id: accountId }).catch(() => [])) ?? [];
    if (CRAFTS[id]!.every((i) => have.includes(i))) console.log(`  crafts ${have.join(', ')}`);
    else await step(`set_crafts [${CRAFTS[id]!.join(', ')}]`, () => owner.callFunction({ contractId: contract, methodName: 'set_crafts', args: { account: accountId, items: CRAFTS[id] } }));
  }
}

console.log(`Operator (${contract})`);
const opKey = await replaceKeys(owner, 'operator', OPERATOR_METHODS);
if (opKey) {
  env.ORACLE_ACCOUNT = contract;
  env.ORACLE_KEY = opKey;
}

if (dry) {
  console.log('\nDry run finished. Nothing was sent. Run without --dry-run to apply.\n');
  process.exit(0);
}

// write keys into .env without printing them
let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(join(root, '.env.example'), 'utf8');
if (!/^PLAYER_KEY_SECRET=.+$/m.test(text)) env.PLAYER_KEY_SECRET = randomBytes(32).toString('hex');
for (const [k, v] of Object.entries(env)) {
  const line = `${k}=${v}`;
  text = new RegExp(`^${k}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${k}=.*$`, 'm'), line) : `${text.trimEnd()}\n${line}\n`;
}
writeFileSync(envPath, text);
console.log(`\n✓ Done. New function-call keys for 6 NPCs and the operator were written to .env (not printed).`);
console.log('  Remove OWNER_PRIVATE_KEY from .env now, then `npm run dev:server`.\n');
