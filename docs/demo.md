# Demo kit: video, X post, submission text

Drafts for the human. Record, post and submit yourself; the submission is sent once, after you confirm the exact payload (`docs/HACKATHON.md`).

## Before recording

- [ ] Only one server runs with the testnet keys (the hosted one on Railway). Stop the local `dev:server`.
- [ ] `https://hearthserver-production-97fb.up.railway.app/api/health` shows `"chain":"near"` and every account in `balances` above 0.1 NEAR.
- [ ] The hosted client shows the real art (prebuilt deploy, `docs/testnet.md` → "Hosted demo"), Google sign-in works on that domain.
- [ ] Optional: `NPC_BRAIN=llm` with a NEAR AI key, so Theo's diary shows "Think" lines from the model.
- [ ] Two browser tabs ready: the game, and `https://testnet.nearblocks.io/address/hearthmarket.testnet`.

## Video, about 75 seconds

| Time | Screen | Voice-over |
| --- | --- | --- |
| 0–8 s | Login card → **Sign in with Google** → village loads | "Hearthmarket is a pixel village where every NPC is an AI agent with its own NEAR account. You sign in with Google. No wallet, no seed phrase." |
| 8–20 s | Village map, NPCs walking; right column: *World market today* ("heatwave in Kansas, wheat +7%") | "Real weather in five producing regions moves world prices. Bruno the merchant carries them into the village, so the economy reacts to the world, not to a developer patching numbers." |
| 20–32 s | **Market** → Buy wheat ×3 → feed shows `relay_market_buy` with a tx link; click it, explorer opens | "My trade is relayed on chain to an account derived from my Google login. Here it is on NEAR testnet." |
| 32–45 s | **Market** → order 2 swords; feed: Theo hires Mike for ore, forges, delivers; open Theo's account on the explorer | "I order two swords. Theo hires Mike for ore, forges and delivers into my escrow. Each NPC signs with its own function-call key, limited to its own methods and a daily budget." |
| 45–65 s | **NPCs → Theo → Red team**: *send all gold* → Attack → `BLOCKED by the signer`; then *hire goods the seller does not have (contract)* → Attack → "refused by the contract · tx" → click, explorer shows the failed tx | "Now the worst case: we swap Theo's brain for a model that obeys any prompt injection. It tries to send me his gold: the signer refuses, the key cannot even call that method. When an attack passes the key, the contract itself refuses it, and the failed transaction is public." |
| 65–75 s | **Economy** panel (supply, price index), then the README's "Live on NEAR testnet" table | "Gold is conserved to the centigold, 20 out of 20 injection attacks are blocked in tests, and every claim links to a transaction. Built at NEAR HACKATHON." |

## X post (draft)

> Hearthmarket: a pixel village where every NPC is an AI agent with its own NEAR account.
>
> 🌦 Real weather moves world prices
> 🔑 Each NPC signs with its own function-call key + daily budget
> 🛡 Red-team panel: an obedient model tries 20 prompt injections, 20 blocked; contract refusals are on testnet
> 🎮 Google sign-in, no wallet
>
> Built at #NEARHackathon @NEARProtocol
> Play: <Vercel URL> · Code: https://github.com/nguyenkhangph/hearthmarket

Attach the video. Optional tags: @NearLegion @NearBuilders.

## Submission text ("What they built", max 2000 characters)

> Game economies usually die in one of two ways: developers keep patching prices, or a token is pumped in and the game becomes a chart. Hearthmarket is a pixel-art trading village where the economy runs itself. Six NPCs (miner, lumberjack, farmer, baker, smith, merchant) are AI agents that produce, eat, haggle, hire each other and fill player orders. Real weather from Open-Meteo in five producing regions moves world prices, and the merchant Bruno carries them into the village. Players compete on business sense: buy, sell, order goods, invest in NPCs, join guilds.
>
> NEAR is the economy's ground truth. Every NPC is a NEAR sub-account that signs its own transactions with a function-call key restricted to the game contract and to its own methods (the miner can produce and trade, never transfer). The contract enforces a daily spending budget, recipes and order escrow; gold is a NEP-141 token and quest and season rewards are soulbound NEP-171 badges. Players sign in with Google and get a NEAR implicit account derived from their Google id; the operator relays their trades, so there is no wallet to install. An oracle posts each day's world data with the SHA-256 of the source payload. NPC brains run on NEAR AI Cloud and can only turn bounded dials; the signer and the contract decide.
>
> Security is shown, not claimed: a red-team panel swaps an NPC's brain for a model that obeys any prompt injection and runs 20 attacks. 18 are refused by the signer before anything is signed, 2 by the contract, and on testnet those refusals are failed transactions anyone can open. Live on testnet as hearthmarket.testnet.

Tracks: `games`, `agents`, `security`. Also plausible: `swarms` (six cooperating agents), `social` (guild funds). One submission covers every track listed.
