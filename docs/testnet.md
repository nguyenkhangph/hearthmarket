# Testnet setup (Windows, PowerShell)

Goal: the `hearth` contract on NEAR testnet, six NPC sub-accounts with function-call keys, and the game server sending real transactions. About 30 minutes, most of it compiling tools.

Never commit `.env`. It holds keys.

## 1. Tools

```powershell
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools   # tick "Desktop development with C++"
```

Close and reopen the terminal, then:

```powershell
rustup target add wasm32-unknown-unknown
cargo install --locked cargo-near
cargo install --locked near-cli-rs
npm run contract:test      # 20 passed
```

## 2. Create the contract account

Pick a name nobody has, e.g. `hearthmarket-khang.testnet`. Run `near` and answer the prompts:

`account` → `create-account` → `sponsor-by-faucet-service` → your name → `autogenerate-new-keypair` → `save-to-keychain` → `testnet` → `create`

## 3. Build and deploy with init

```powershell
cd contracts\hearth
cargo near deploy
```

Answer the prompts: build non-reproducible wasm → your account → **with init call** → function `new` → JSON args:

```json
{"owner":"hearthmarket-khang.testnet","oracle":"hearthmarket-khang.testnet","treasury":250000}
```

→ 30 Tgas → 0 NEAR deposit → testnet → sign with keychain → send. Then `cd ..\..`.

(Use the prompts rather than one long command: Windows PowerShell 5 strips the inner quotes of JSON arguments passed to native programs.)

## 4. Put the owner key in `.env`

Export the full-access key of the contract account:

`near` → `account` → `export-account` → your account → `using-private-key` → `testnet`

Then in `.env` (copy from `.env.example` if you have none: `Copy-Item .env.example .env`):

```
HEARTH_CONTRACT=hearthmarket-khang.testnet
OWNER_PRIVATE_KEY=ed25519:...the exported key...
VITE_HEARTH_CONTRACT=hearthmarket-khang.testnet
```

## 5. Create NPCs, keys and registrations

```powershell
npm run setup:testnet -- --dry-run   # prints the plan, sends nothing
npm run setup:testnet
```

This creates `mike/jack/buba/chloe/theo/bruno.<contract>` (0.3 NEAR each, ~1.8 NEAR total plus fees; the faucet account starts with 10 NEAR), adds a function-call key per NPC limited to your contract and the NPC methods, registers each NPC's daily budget, adds an oracle key, and writes all keys into `.env` without printing them. It is safe to run again: existing accounts and registrations are skipped (a new function-call key is added each run).

After it finishes you can remove `OWNER_PRIVATE_KEY` from `.env`; the server does not need it.

## 6. Run against testnet

```powershell
npm run dev:server     # logs: chain=near contract=hearthmarket-khang.testnet
npm run dev            # in a second terminal
```

Open `http://localhost:5173/?server=ws://localhost:8787`. When an NPC produces ore/timber/wheat or hires another NPC, the feed shows a real transaction hash. Check it on https://testnet.nearblocks.io.

What is mirrored on chain today: raw production and NPC-to-NPC deals (`produce`, `hire`), under the contract's daily budgets. Market trades, orders and guilds still settle in the engine; moving them on chain is the contract track in `docs/plan.md`.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `does not exist on testnet` | Step 2 not done, or a typo in `HEARTH_CONTRACT` |
| `has no initialised hearth contract` | Step 3 without the init call. Redeploy with init, or call `new` once from `near` → `contract` → `call-function` |
| `NotEnoughBalance` | Top up the account from the faucet: `near` → `account` → `create-account` is per account; for an existing one use https://near-faucet.io |
| `failed:` in the feed | The contract refused the call (e.g. budget). That is the guard working; details in the server log |
