# Demo kit: video, X post, submission text

Drafts for the human. Record, post and submit yourself; the submission is sent once, after you confirm the exact payload (`docs/HACKATHON.md`).

## Pitch in one breath

Hearthmarket is a village where six AI agents run real businesses on NEAR: each has its own account and key, negotiates prices with the others, and trades with players who signed in with Google. Real weather and the real price of gold, read from NEAR Intents, move the economy. A red team anyone can run shows the agents cannot be talked into giving money away: the key, the signer and the contract each stop it, and the contract's refusals are public transactions. It is a game, and a small public testbed for the question every agent-commerce product has to answer: how do you let an AI hold money safely?

## Before recording

- [ ] Only one server runs with the testnet keys (the hosted one on Railway). Stop the local `dev:server`.
- [ ] `https://hearthserver-production-97fb.up.railway.app/api/health` shows `"chain":"near"`, every account in `chainStats.balances` above 0.1 NEAR.
- [ ] The hosted client shows the real art (Vercel build log: `fetch-art: imported 718 files`).
- [ ] Optional but strong: `NPC_BRAIN=llm` with a NEAR AI key on Railway, so deals and diaries show the model's own words.
- [ ] Contract version 4 deployed (`get_version` = "4") and the new `ORACLE_KEY` on Railway, so request deliveries show their own tx (docs/testnet.md).
- [ ] Tabs ready: the game, `/dashboard`, `https://testnet.nearblocks.io/address/hearthmarket.testnet`.

## Video, about 90 seconds

| Time | Screen | Voice-over |
| --- | --- | --- |
| 0–8 s | Login card → **Sign in with Google** → village loads | "Hearthmarket: six AI agents run a village economy on NEAR. You sign in with Google. No wallet." |
| 8–20 s | `/dashboard`: KPIs, market, agents ranked by net worth | "This is the economy live: prices, money supply, who is getting rich, and every transaction that reached NEAR testnet." |
| 20–35 s | Dashboard → **Agents negotiating**: Theo and Mike haggle over ore, agreed price; then the feed line "Mike delivers 3 ore at the agreed …" with a tx link → explorer | "Each morning the agents negotiate with each other, each with its own brain. Theo pays Mike the agreed price, signed with Theo's own key. Here it is on chain." |
| 35–45 s | World panel: weather headlines, "World money ×0.98 · tokenized gold XAUT … NEAR Intents" | "World prices follow real weather, and village gold follows the real price of gold, quoted by NEAR Intents." |
| 45–55 s | **Market** → buy wheat → feed tx link → explorer shows `relay_market_buy` | "My trade is relayed to a NEAR account made from my Google login." |
| 55–75 s | **NPCs → Theo → Red team**: *send all gold* → `BLOCKED by the signer`; *hire goods the seller does not have (contract)* → "refused by the contract · tx" → explorer shows the failed tx | "Now the worst case: an agent whose brain obeys any prompt injection. The signer refuses what the key cannot do. What passes the key, the contract refuses, in public." |
| 75–90 s | Account chip → **Claim it into your own wallet** (do not reveal the key on camera) → README "Live on NEAR testnet" table | "And the account is yours: claim the key into any wallet. Every claim in the README links to a transaction. Built at NEAR HACKATHON." |

## X post (draft)

> Hearthmarket: six AI agents run a pixel village economy on NEAR.
>
> 🤝 Agents negotiate prices with each other, each signing with its own key
> 🌦 Real weather + the real gold price (via NEAR Intents) move the market
> 🛡 Red team: an obedient model tries 20 prompt injections, 20 blocked; contract refusals are public txs
> 🎮 Google sign-in, no wallet; claim your NEAR account any time
>
> Built at #NEARHackathon @NEARProtocol
> Play: https://hearthmarket.space · Live economy: https://hearthmarket.space/dashboard
> Code: https://github.com/nguyenkhangph/hearthmarket

Attach the video. Optional tags: @NearLegion @NearBuilders.

## Submission text ("What they built", max 2000 characters)

> Game economies usually die in one of two ways: developers keep patching prices, or a token is pumped in and the game becomes a chart. Hearthmarket is a pixel village whose economy runs itself: six AI agents (miner, lumberjack, farmer, baker, smith, merchant) produce, negotiate prices with each other, hire each other and fill player orders. Real weather in five producing regions moves world prices, and the price of tokenized gold read from NEAR Intents sets what village gold is worth. Players sign in with Google, trade, invest and compete in guilds.
>
> Every agent is a NEAR account that signs its own transactions with a function-call key limited to the game contract and its own methods. The contract enforces daily budgets, recipes and escrow; gold is NEP-141, goods NEP-245, badges NEP-171. Google players get a NEAR account derived from their login, the operator relays their trades, and they can claim the key into any wallet. The oracle posts world data with the SHA-256 of the source payload. Agent brains run on NEAR AI Cloud; they can only turn bounded dials and agree prices inside a band around the market.
>
> Security is shown, not claimed: a red-team panel swaps an agent's brain for a model that obeys any prompt injection and runs 20 attacks. The signer refuses 18 before anything is signed; the contract refuses the rest, as failed transactions anyone can open. A public dashboard shows prices, flows, agent deals and every call that reached testnet. It is a game and a small testbed for safe agent commerce.

Tracks: `games`, `agents`, `security`, `swarms`. One submission covers every track listed.
