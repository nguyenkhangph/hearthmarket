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

rustup target add wasm32-unknown-unknown

# prebuilt installers (building from source needs NASM on Windows)
irm https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.ps1 | iex
irm https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.ps1 | iex

# near-sdk's unit-testing pulls aws-lc-sys, which needs NASM on Windows unless told to use prebuilt objects
[Environment]::SetEnvironmentVariable("AWS_LC_SYS_PREBUILT_NASM", "1", "User")
$env:AWS_LC_SYS_PREBUILT_NASM = "1"

npm run contract:test      # 39 passed
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

## Troubleshooting

| Message | Fix |
| --- | --- |
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
