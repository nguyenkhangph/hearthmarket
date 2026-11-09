# Testnet setup (Windows, PowerShell)

Goal: the `hearth` contract (version 2) on NEAR testnet, six NPC sub-accounts with their own function-call keys, an operator key for the game server, and the game sending real transactions. Optional: Google sign-in, NPC brains on NEAR AI Cloud, live weather from Open-Meteo.

Never commit `.env`. It holds keys.

Already deployed version 1 (the first deployment)? Go to **Upgrade from version 1** below.

## 1. Tools

```powershell
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools   # tick "Desktop development with C++"
```

Close and reopen the terminal, then:

```powershell
# make ~/.cargo/bin permanent on PATH
$cargoBin = "$env:USERPROFILE\.cargo\bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$cargoBin*") { [Environment]::SetEnvironmentVariable("Path", "$userPath;$cargoBin", "User") }
$env:Path += ";$cargoBin"

rustup update stable   # the contract pins rustc 1.95 in contracts/hearth/rust-toolchain.toml; rustup installs it on first build
rustup target add wasm32-unknown-unknown

# prebuilt installers (building from source needs NASM on Windows)
irm https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.ps1 | iex
irm https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.ps1 | iex

# near-sdk's unit-testing pulls aws-lc-sys, which needs NASM on Windows unless told to use prebuilt objects
[Environment]::SetEnvironmentVariable("AWS_LC_SYS_PREBUILT_NASM", "1", "User")
$env:AWS_LC_SYS_PREBUILT_NASM = "1"

npm run contract:test      # 45 passed
```

## 2. Create the contract account

Pick a name nobody has, e.g. `hearthmarket.testnet`:

```powershell
near account create-account sponsor-by-faucet-service hearthmarket.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
```

## 3. Build and deploy with init

```powershell
cd contracts\hearth
cargo near build non-reproducible-wasm --no-abi
near contract deploy hearthmarket.testnet use-file target\near\hearth.wasm with-init-call new json-args '{\"owner\":\"hearthmarket.testnet\",\"oracle\":\"hearthmarket.testnet\",\"treasury\":250000}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
cd ..\..
```

`--no-abi`: on Windows the ABI step links a native DLL and fails with `LNK2019 unresolved external symbol`; the contract does not need the ABI. The `\"` keeps Windows PowerShell 5 from stripping the JSON quotes. If it still complains, run `near` and answer the prompts instead.

## 4. Owner key, then keys for NPCs and the operator

Export the full-access key of the contract account (it prints the key: copy it straight into `.env`, never into a chat):

```powershell
near account export-account hearthmarket.testnet using-private-key network-config testnet
```

In `.env` (`Copy-Item .env.example .env` if you have none):

```
HEARTH_CONTRACT=hearthmarket.testnet
OWNER_PRIVATE_KEY=ed25519:...the exported key...
```

```powershell
npm run setup:testnet -- --dry-run   # prints the plan, sends nothing
npm run setup:testnet
```

This creates `mike/jack/buba/chloe/theo/bruno.<contract>` (0.5 NEAR each), gives each NPC one function-call key limited to the contract and its own method list, registers budgets and crafting rights, adds the operator key, and writes all keys plus `CHAIN=near`, `VITE_HEARTH_CONTRACT` and a `PLAYER_KEY_SECRET` into `.env` without printing them. Safe to run again: it replaces the function-call keys and tops up NPCs below 0.25 NEAR.

Then **delete the value of `OWNER_PRIVATE_KEY`** in `.env`. The server never needs it.

## 5. Run against testnet

```powershell
npm run dev:server     # logs: chain=near contract=hearthmarket.testnet
npm run dev            # in a second terminal
```

Open `http://localhost:5173/?server=ws://localhost:8787`. Within a minute the server log shows lines like:

```
chain ok   mike.hearthmarket.testnet produce tx=...
chain ok   theo.hearthmarket.testnet craft tx=...
chain ok   hearthmarket.testnet reconcile tx=...
chain ok   hearthmarket.testnet post_world_data tx=...
chain ok   hearthmarket.testnet relay_market_buy tx=...      (after you buy something)
```

In the feed, real hashes are links to testnet.nearblocks.io; `off-chain` marks actions that stay in the engine (stalls, guild funds, AI guild bots), `failed` shows what the contract refused (the reason is in the server log). Your account chip (top right) links to your player account on the explorer.

On chain today: NPC production, crafting, NPC deals, NPC market trades, Bruno's world trades, your market trades and orders (relayed, you have no wallet), order fills, world data, badges. Once a game day the operator `reconcile`s the chain to the engine's books (see `docs/interface.md`).

## Upgrade from version 1

Version 2 adds NEP-141/171, crafting, the operator, relays and `reconcile`. The account, NPCs and balances stay; `migrate` converts the stored state.

1. Stop the server (Ctrl+C). Then:

   ```powershell
   git pull origin main
   npm install
   cd contracts\hearth
   cargo near build non-reproducible-wasm --no-abi
   near contract deploy hearthmarket.testnet use-file target\near\hearth.wasm with-init-call migrate json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
   near contract call-function as-read-only hearthmarket.testnet get_version json-args '{}' network-config testnet now
   cd ..\..
   ```

   The last command must print `"2"`.

2. Put the owner key back in `.env` (`OWNER_PRIVATE_KEY=`, see step 4), run `npm run setup:testnet -- --dry-run`, then `npm run setup:testnet`. It replaces the old keys (their method lists changed), sets crafting rights and adds the operator key.
3. Delete `OWNER_PRIVATE_KEY` again, start `npm run dev:server` and `npm run dev`.

## Upgrade from version 2 to 3 (NEP-245 goods)

Version 3 adds NEP-245 multi-token views, transfers and events for the goods. The stored state is the same as version 2, so there is **no migrate call**: deploy the new code without an init call.

```powershell
cd contracts\hearth
cargo near build non-reproducible-wasm --no-abi
near contract deploy hearthmarket.testnet use-file target\near\hearth.wasm without-init-call network-config testnet sign-with-keychain send
near contract call-function as-read-only hearthmarket.testnet get_version json-args '{}' network-config testnet now
near contract call-function as-read-only hearthmarket.testnet mt_balance_of json-args '{\"account_id\":\"mike.hearthmarket.testnet\",\"token_id\":\"ore\"}' network-config testnet now
cd ..\..
```

`get_version` must print `"3"`. Keys, NPCs and balances stay as they are; the server needs no restart.

## Upgrade from version 3 to 4 (NPC requests on chain)

Version 4 adds `relay_deliver_request`: a player hands an NPC the goods it asked for, the NPC pays from its own gold (inside its daily budget, at most 1.5× the market mid) and a bonus of at most 10 gold is minted with memo "request bonus". Same stored state, so **no migrate call**. The operator key needs the new method, so replace only that key afterwards.

```powershell
cd contracts\hearth
cargo near build non-reproducible-wasm --no-abi
near contract deploy hearthmarket.testnet use-file target\near\hearth.wasm without-init-call network-config testnet sign-with-keychain send
near contract call-function as-read-only hearthmarket.testnet get_version json-args '{}' network-config testnet now
cd ..\..
# put OWNER_PRIVATE_KEY back in .env for this one step, then:
npm run setup:testnet -- --operator-only --dry-run
npm run setup:testnet -- --operator-only
# remove OWNER_PRIVATE_KEY from .env again
```

`get_version` must print `"4"`. The script writes a new `ORACLE_KEY` into `.env` (not printed). **Copy it to Railway** (Variables → `ORACLE_KEY`) and redeploy: the old operator key is deleted, so relays fail until the server has the new one. The server log then says `contract hearthmarket.testnet version 4`. Until version 4 is live, requests still work in the game; the gold reaches the chain with the daily `reconcile`.

## Google sign-in (optional, recommended for the demo)

1. https://console.cloud.google.com → create a project (e.g. "Hearthmarket").
2. **APIs & Services → OAuth consent screen**: External, app name "Hearthmarket", your email as support and developer contact. While the app is in testing, add the Gmail accounts that may sign in under **Test users**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**. Under **Authorized JavaScript origins** add `http://localhost:5173` (and later the address you deploy the client to). No redirect URI is needed.
4. Copy the client ID (`….apps.googleusercontent.com`) into `.env`:

   ```
   VITE_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
   ```

5. Restart `npm run dev:server` and `npm run dev`. The login card shows **Sign in with Google**; the typed-email login is turned off (set `ALLOW_DEV_LOGIN=1` to keep it for testing).

The server checks the Google ID token's signature, audience, issuer and expiry, then derives the player's NEAR implicit account from `PLAYER_KEY_SECRET` and the Google account id: the same Google account always gets the same NEAR account. Keep `PLAYER_KEY_SECRET` stable and secret.

## NPC brains on NEAR AI Cloud (optional)

1. Sign up at https://cloud.near.ai, add credits, create an API key.
2. In `.env`:

   ```
   NEAR_AI_API_KEY=...
   NPC_BRAIN=llm
   ```

3. `npm run llm:check` lists the models your key can use; put one in `NEAR_AI_MODEL=` and run it again. It shows a day plan for Buba (and what the plan guard did with it) and Theo's answer to an injection attempt.
4. Restart the server. Each NPC plans its day at most once every `NPC_PLAN_MINUTES` (default 5, ~72 calls an hour), and haggling in the NPC panel goes through the model. Plans only turn bounded dials (how much to sell, how many loaves, what to forge first, Bruno's trade threshold); every trade still passes the spending guard and the contract. Diaries show "Think" from the model and "Guard" from the plan guard.

## Live weather (optional)

```powershell
npm run world:check      # one Open-Meteo reading, the prices it gives, and the hash the oracle would post
```

Then `WORLD_SOURCE=open-meteo` in `.env` and restart the server. The oracle posts each day's reading with the SHA-256 of the full API payload; the payloads are kept in `data/world/posted/` so anyone can check a hash.

## Gas: keeping the demo alive

Every on-chain call burns a little testnet NEAR from the account that signs it: each NPC pays its own gas, the operator pays for `reconcile`, `post_world_data` and player relays. The faucet is limited, so the server spends carefully by default:

| Setting (`.env`) | Default | What it does |
| --- | --- | --- |
| `CHAIN_IDLE_SECONDS` | 0 (never pause) | Set it above 0 to save gas: nobody playing (and nobody refreshing the dashboard in the last minute) for this long: NPC actions stay in the engine, nothing is sent, and the agents use rules instead of the model. The first player or dashboard viewer back triggers a fresh `reconcile`. |
| `CHAIN_NPC_TX_PER_HOUR` | 20 | Calls per NPC per real hour. Order fills and player relays are never capped (they move escrow). Skipped actions stay in the engine; `reconcile` re-anchors balances. |
| `CHAIN_BATCH_PRODUCE` | 1 | A day of production goes on chain as one `produce` per NPC and item. |
| `CHAIN_DAY_SECONDS` | 600 | Real seconds between two day syncs (`reconcile` + `post_world_data`). |
| `CHAIN_LOW_BALANCE_NEAR` | 0.1 | The server checks every signing account every 10 minutes and logs `LOW BALANCE ...`; `/api/health` lists the balances. |
| `CHAIN_REDTEAM_PROOFS_PER_HOUR` | 12 | Red-team attacks sent to the contract on chain, all players together. |

Check balances by hand:

```powershell
near account view-account-summary theo.hearthmarket.testnet network-config testnet now
```

Top up an NPC from the contract account (its key is in your keychain since step 2). The contract account itself keeps about 3.6 NEAR locked for the contract's storage, so only the rest can be sent:

```powershell
near tokens hearthmarket.testnet send-near theo.hearthmarket.testnet '0.3 NEAR' network-config testnet sign-with-keychain send
```

More testnet NEAR: create another faucet account and send most of it to the contract account:

```powershell
near account create-account sponsor-by-faucet-service hearthmarket-fund.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
near tokens hearthmarket-fund.testnet send-near hearthmarket.testnet '8 NEAR' network-config testnet sign-with-keychain send
```

Run only one server per set of keys. Two servers with the same keys (your laptop and the hosted one) fight over nonces and burn gas twice.

## Hosted demo: server on Railway, client on Vercel

The game server needs a long-running process (WebSocket), so it runs on Railway; the client is static and runs on Vercel.

**Server (Railway)**

1. New project → Deploy from GitHub repo. If Railway creates two services (`@hearth/client`, `@hearth/server`), delete the client one.
2. Service settings: Root Directory empty (the repo root), Custom Start Command `npm run start -w @hearth/server`. Keep one replica: the village lives in memory.
3. Networking → Generate Domain. The WebSocket address is the same host with `wss://`.
4. Variables (Raw Editor), values from your `.env`, never `OWNER_PRIVATE_KEY`:

   ```
   NODE_VERSION=22
   CHAIN=near
   HEARTH_CONTRACT=hearthmarket.testnet
   NEAR_RPC_URL=https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://testnet-rpc.intea.rs
   NPC_KEY_MIKE=...   NPC_KEY_JACK=...   NPC_KEY_BUBA=...   NPC_KEY_CHLOE=...   NPC_KEY_THEO=...   NPC_KEY_BRUNO=...
   ORACLE_ACCOUNT=hearthmarket.testnet
   ORACLE_KEY=...
   PLAYER_KEY_SECRET=...      (same value as local, or players get new accounts)
   GOOGLE_CLIENT_ID=....apps.googleusercontent.com
   ```

5. `https://<domain>/api/health` answers `{"ok":true,...,"chain":"near"}`.

**Client (Vercel)**

1. Import the repo, Root Directory `apps/client`, preset Vite.
2. Environment variables: `VITE_SERVER_URL=wss://<railway domain>`, `VITE_GOOGLE_CLIENT_ID`, `VITE_HEARTH_CONTRACT=hearthmarket.testnet`. They are baked in at build time: redeploy after changing them.
3. Add the Vercel domain (no trailing slash) to the OAuth client's **Authorized JavaScript origins**.

A build from GitHub has no art pack (its license forbids putting it in a public repo), so the page shows stand-in art. To build with the real art on every push, keep the zip in a **private** repository and let the build fetch it:

1. On GitHub create a **private** repository, e.g. `hearthmarket-art`, and upload `Cute_Fantasy.zip` to it (Add file → Upload files).
2. Create a fine-grained token: GitHub → Settings → Developer settings → Fine-grained tokens → Generate. Repository access: only `hearthmarket-art`. Permissions: Contents → Read-only. Copy the token.
3. Vercel → project → Settings → Environment Variables (Production and Preview):

   ```
   ASSET_PACK_URL=https://api.github.com/repos/<your-github-name>/hearthmarket-art/contents/Cute_Fantasy.zip
   ASSET_PACK_TOKEN=<the token>
   ```

4. Redeploy. The build log shows `fetch-art: imported ... files`; without the variables, or if the download fails, it shows a warning and builds with stand-in art (the build never fails over art).

The token only reads that one private repo; it lives in Vercel, never in code. Check with Kenmi that the license covers a public web build of the game (the images are served to players' browsers, as in any web game).

## Troubleshooting

| Message | Fix |
| --- | --- |
| `-429 ... Rate limits exceeded` (FastNEAR) | Public RPCs limit requests. List several in `.env`: `NEAR_RPC_URL=https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://testnet-rpc.intea.rs` (the server moves to the next one on a 429), keep `SECONDS_PER_GAME_HOUR=5` and `CHAIN_MAX_TX_PER_MINUTE=20` |
| `Not enough balance for theo.hearthmarket.testnet` / `LOW BALANCE` | That NPC is out of gas money. Top it up (see **Gas** above) |
| `-429 ... ENDPOINT IS DEPRECATED` | `rpc.testnet.near.org` is rate-limited/deprecated. Set `NEAR_RPC_URL=https://test.rpc.fastnear.com` in `.env` and restart the server |
| `cargo near deploy` fails with `LNK2019 unresolved external symbol` | Windows ABI step. Use `cargo near build non-reproducible-wasm --no-abi` and `near contract deploy ... use-file target\near\hearth.wasm` as above |
| `does not exist on testnet` | Step 2 not done, or a typo in `HEARTH_CONTRACT` |
| `runs contract version 1` (setup script) | Do **Upgrade from version 1** first |
| `has no initialised hearth contract` | Step 3 without the init call. Redeploy with init, or call `new` once from `near` → `contract` → `call-function` |
| `NotEnoughBalance` / `LackBalanceForState` | The contract account is low on NEAR (the code alone locks ~3 NEAR). Create a second faucet account (step 2 with another name) and send from it: `near tokens <that-account> send-near hearthmarket.testnet '9 NEAR' network-config testnet sign-with-keychain send` |
| `refused to sign ...: not on the ... key` | A bug in the server mirror, caught before signing. Report it |
| `failed:over the daily budget` in the feed | The contract refused an NPC's spending. That is the guard working |
| `failed:order id taken` / `no such order` | An order placed before a server restart; harmless |
| `Sign-in refused: token is for another app` | `VITE_GOOGLE_CLIENT_ID` differs between client and server, or a stale tab: reload |
| Google button missing | `VITE_GOOGLE_CLIENT_ID` empty, or `http://localhost:5173` not in the authorized JavaScript origins |

## Keep the dashboard's numbers across deploys (Railway)

The red-team score, the Red Teamer board and the proof list are saved in `STATE_FILE`. Railway wipes the container on every deploy, so give the file a volume:

1. In the Railway project: **+ Create → Volume**, attach it to the game server service, mount path `/data`.
2. Service → **Variables**: `STATE_FILE=/data/runtime/state.json`.
3. Deploy. The start log prints `dashboard state: N proofs, red team X/Y (/data/runtime/state.json)`.

Without a volume the server still rebuilds the score from the refusals listed in `data/proof-history.json`.

## Upgrade from version 4 to 5 (trust boundary)

Version 5 adds `set_oracle`, `self_custody` / `relay_self_custody` / `is_self_custody` and one `reconcile` summary event per call. Same stored state, so **no migrate call**.

```powershell
cd contracts\hearth
cargo near build non-reproducible-wasm --no-abi
near contract deploy hearthmarket.testnet use-file target\near\hearth.wasm without-init-call network-config testnet sign-with-keychain send
near contract call-function as-read-only hearthmarket.testnet get_version json-args '{}' network-config testnet now
cd ..\..
# put OWNER_PRIVATE_KEY back in .env for this one step, then:
npm run setup:testnet -- --operator-only --split-oracle --dry-run
npm run setup:testnet -- --operator-only --split-oracle
# remove OWNER_PRIVATE_KEY from .env again
```

`get_version` must print `"5"`. With `--split-oracle` the script creates `ops.hearthmarket.testnet` (3 NEAR from the contract account, for relay and reconcile gas), calls `set_oracle` with the owner key, deletes the old operator key from the contract account, and writes a new function-call key for `ops.hearthmarket.testnet` (it now includes `relay_self_custody`) into `.env` as `ORACLE_ACCOUNT` and `ORACLE_KEY` (not printed). **Copy both to Railway** (Variables) and redeploy; relays fail until the server has them. The log then says `contract hearthmarket.testnet version 5`, and `get_roles` returns the owner and `ops.hearthmarket.testnet`.

Without `--split-oracle`, `--operator-only` only refreshes the operator key on the contract account; it must be refreshed either way, because the key needs `relay_self_custody`.

## Upgrade from version 5 to 6 (stall board escrow)

Version 6 adds the NEP-245 `mt_transfer_call` (goods into a receiver contract, unused goods come back), relays for the stall board (`relay_stall_list`, `relay_stall_buy`, `relay_stall_cancel`, `relay_stall_withdraw`), `npc_stall_buy` (an NPC buys a listing inside its daily budget; NPCs still never call `ft_transfer`) and `set_stalls` / `get_stalls`. The stalls themselves are a **separate contract** (`contracts/stalls`): it holds listed goods in escrow, takes the buyer's gold, and pays the seller and the buyer at once. Same stored state in the game contract, so **no migrate call**, and the server keeps listings in the game until `STALLS_ONCHAIN=1`.

**1. Back up version 5 first** (the rollback is the old wasm: version 6 only adds one raw storage key that version 5 ignores):

```powershell
mkdir backup -ErrorAction SilentlyContinue
copy contracts\hearth\target\near\hearth.wasm backup\hearth-v5.wasm    # before building v6
near contract view-storage hearthmarket.testnet all as-json network-config testnet now > backup\hearthmarket-v5-state.json
foreach ($m in 'get_economy','get_roles','get_market','get_open_orders') { near contract call-function as-read-only hearthmarket.testnet $m json-args '{}' network-config testnet now > "backup\$m.json" }
```

If `view-storage` refuses (state too large for the RPC), the view files plus the wasm are still enough to roll back. Keep `backup\` out of git (it is in `.gitignore`).

**2. Deploy version 6** (same as every upgrade):

```powershell
cd contracts\hearth
cargo near build non-reproducible-wasm --no-abi
near contract deploy hearthmarket.testnet use-file target\near\hearth.wasm without-init-call network-config testnet sign-with-keychain send
near contract call-function as-read-only hearthmarket.testnet get_version json-args '{}' network-config testnet now   # "6"
cd ..\..
```

The village keeps running as before: nothing calls the new methods yet.

**3. Deploy the stalls contract to a test account first** (2 NEAR pays its storage and the 1-yocto deposits on payouts):

```powershell
near account create-account fund-myself stalls-test.hearthmarket.testnet '2 NEAR' autogenerate-new-keypair save-to-keychain sign-as hearthmarket.testnet network-config testnet sign-with-keychain send
cd contracts\stalls
cargo near build non-reproducible-wasm --no-abi
near contract deploy stalls-test.hearthmarket.testnet use-file target\near\stalls.wasm with-init-call new json-args '{\"token\":\"hearthmarket.testnet\"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
near contract call-function as-read-only stalls-test.hearthmarket.testnet get_version json-args '{}' network-config testnet now   # "1"
cd ..\..
```

**4. Refresh the keys and point the game at the test stalls.** The NPC keys need `npc_stall_buy` and the operator key needs the four relays, so this is a full run (not `--operator-only`):

```powershell
# put OWNER_PRIVATE_KEY back in .env for this one step, then:
npm run setup:testnet -- --stalls stalls-test.hearthmarket.testnet --dry-run
npm run setup:testnet -- --stalls stalls-test.hearthmarket.testnet
# remove OWNER_PRIVATE_KEY from .env again
```

It writes new `NPC_KEY_*` and `ORACLE_KEY` values into `.env` (not printed). **Copy all seven to Railway** and redeploy, with `STALLS_ONCHAIN` still unset: the old keys stop working once replaced.

**5. Smoke test on testnet** (signs only with the server's keys; no owner key needed):

```powershell
npm run stalls:smoke
```

It registers a throwaway test player, buys 3 ore, lists them, has a stranger try to cancel (must fail), lets Bruno buy (seller paid, Bruno gets the ore), has Bruno buy the same listing again (refunded), lists and cancels a second time (goods back), and withdraws with nothing owed (must fail). Every step prints an explorer link; it ends with `✓ All stall checks passed`.

**6. Go live.** Either keep `stalls-test` (it is a full stalls contract) or repeat step 3 for `stalls.hearthmarket.testnet` and switch to it with the owner key once:

```powershell
npm run setup:testnet -- --stalls stalls.hearthmarket.testnet
```

Then set `STALLS_ONCHAIN=1` on Railway. The log says `stall board: escrowed on chain by the stalls contract`. Listings, NPC purchases and cancels then show up in **Prove on NEAR** as `relay_stall_list`, `npc_stall_buy`, `relay_stall_buy` and `relay_stall_cancel`.

**Rollback:** unset `STALLS_ONCHAIN` first (new listings stay in the game at once; open ones still settle on chain or go home after 3 days while the server runs). To go back to version 5 entirely, wait until `get_open_count` on the stalls contract is 0, then deploy `backup\hearth-v5.wasm` as in step 2. A wallet-less player's escrowed goods can only be cancelled through version 6 (`relay_stall_cancel`), so do not roll back while listings are open. Anything owed after a failed payout stays withdrawable by anyone for its owner: `withdraw_for {"account_id": "<player>"}` on the stalls contract.
