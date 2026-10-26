/**
 * One-shot testnet setup, after the contract is deployed and initialised:
 *
 *   npm run setup:testnet -- --dry-run     # show the plan, send nothing
 *   npm run setup:testnet                  # do it
 *
 * Needs in .env:
 *   HEARTH_CONTRACT=your-name.testnet            (the deployed contract account)
 *   OWNER_PRIVATE_KEY=ed25519:...                (full-access key of that account; never commit)
 *
 * What it does, skipping anything that already exists:
 *  1. creates the 6 NPC sub-accounts (mike.<contract>, ...) funded with 0.3 NEAR each,
 *     with the owner's key as their full-access key (the server never holds it),
 *  2. adds one function-call key per NPC: receiver = the contract, NPC methods only,
 *     0.25 NEAR gas allowance,
 *  3. registers each NPC in the contract (daily budget, what it produces, start gold),
 *  4. adds an oracle function-call key on the contract account (post_world_data, advance_day),
 *  5. writes the new function-call keys into .env (CHAIN=near). Secrets are never printed.
 *
 * near-api-js 7.x. Verify the API on https://docs.near.org/tools/near-api if this breaks.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider, KeyPairEd25519, KeyPairSigner, parseNearAmount, type KeyPairString } from 'near-api-js';
import { NPCS, NPC_DEFS, NPC_ALLOWED_METHODS, RULES, g, setContractAccount, type NpcId } from '../packages/economy/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const dry = process.argv.includes('--dry-run');

const contract = process.env.HEARTH_CONTRACT ?? '';
const ownerKey = (process.env.OWNER_PRIVATE_KEY ?? '') as KeyPairString;
const rpcUrl = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';

if (!contract || contract === 'hearth.testnet') fail('Set HEARTH_CONTRACT in .env to your deployed contract account (e.g. hearthmarket-khang.testnet).');
if (!ownerKey.startsWith('ed25519:')) fail('Set OWNER_PRIVATE_KEY=ed25519:... in .env (full-access key of the contract account).');
setContractAccount(contract);

const provider = new JsonRpcProvider({ url: rpcUrl });
const owner = new Account(contract, provider, ownerKey);
const ownerPub = (await KeyPairSigner.fromSecretKey(ownerKey).getPublicKey()).toString();

const RAW: Partial<Record<NpcId, string[]>> = { mike: ['ore'], jack: ['timber'], buba: ['wheat'] };
const env: Record<string, string> = { CHAIN: 'near', HEARTH_CONTRACT: contract, NEAR_RPC_URL: rpcUrl };

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

console.log(`\nHearthmarket testnet setup · contract ${contract} · ${rpcUrl}${dry ? ' · DRY RUN' : ''}\n`);

if (!(await exists(contract))) fail(`${contract} does not exist on testnet. Create and deploy it first (docs/testnet.md).`);
try {
  await view('get_economy', {});
} catch {
  fail(`${contract} has no initialised hearth contract. Deploy it and call new(...) first (docs/testnet.md).`);
}

for (const id of NPCS) {
  const def = NPC_DEFS[id];
  const accountId = def.account;
  console.log(`${def.name} (${accountId})`);

  if (await exists(accountId)) console.log('  account exists, skipping creation');
  else await step('create sub-account, 0.3 NEAR', () => owner.createSubAccount({ accountOrPrefix: id, publicKey: ownerPub, nearToTransfer: parseNearAmount('0.3') }));

  const kp = KeyPairEd25519.fromRandom();
  const methods = id === 'bruno' ? [...NPC_ALLOWED_METHODS, 'world_trade'] : [...NPC_ALLOWED_METHODS];
  const npcAccount = new Account(accountId, provider, ownerKey);
  await step(`add function-call key → ${contract} [${methods.join(', ')}]`, () =>
    npcAccount.addFunctionCallAccessKey({ publicKey: kp.getPublicKey().toString(), contractId: contract, methodNames: methods, allowance: parseNearAmount('0.25') }),
  );
  if (!dry) env[`NPC_KEY_${id.toUpperCase()}`] = kp.toString();

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
        args: {
          account: accountId,
          daily_budget: def.dailyBudget,
          produces: RAW[id] ?? [],
          merchant: id === 'bruno',
          start_gold: id === 'bruno' ? g(400) : RULES.npcStartGold,
        },
      }),
    );
  }
}

console.log(`Oracle (${contract})`);
const oracleKp = KeyPairEd25519.fromRandom();
await step('add oracle function-call key [post_world_data, advance_day]', () =>
  owner.addFunctionCallAccessKey({ publicKey: oracleKp.getPublicKey().toString(), contractId: contract, methodNames: ['post_world_data', 'advance_day'], allowance: parseNearAmount('0.25') }),
);
if (!dry) {
  env.ORACLE_ACCOUNT = contract;
  env.ORACLE_KEY = oracleKp.toString();
}

if (dry) {
  console.log('\nDry run finished. Nothing was sent. Run without --dry-run to apply.\n');
  process.exit(0);
}

// write keys into .env without printing them
let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(join(root, '.env.example'), 'utf8');
for (const [k, v] of Object.entries(env)) {
  const line = `${k}=${v}`;
  text = new RegExp(`^${k}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${k}=.*$`, 'm'), line) : `${text.trimEnd()}\n${line}\n`;
}
writeFileSync(envPath, text);
console.log(`\n✓ Done. Function-call keys for 6 NPCs and the oracle were written to .env (not printed).`);
console.log(`  Next: set VITE_HEARTH_CONTRACT=${contract} in .env, then \`npm run dev:server\` and watch for real tx hashes in the feed.\n`);
