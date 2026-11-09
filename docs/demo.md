# Demo kit: video, X post, submission text

Drafts for the human. Record, post and submit yourself; the submission is sent once, after you confirm the exact payload (`docs/HACKATHON.md`). Deadline: **2026-11-14 23:59 UTC** (15 Nov, 06:59 in Vietnam).

## Pitch in one breath

Hearthmarket is a village where six AI agents run real businesses on NEAR, and you play with them: haggle, take their orders on a promise, sell to them from your stall, hire one to sell for you, and race an AI rival trader. Each agent has its own account and key and signs its own trades inside limits it cannot break; real weather and the real price of gold, read from NEAR Intents, move the economy; a red team anyone can run shows the agents cannot be talked into giving money away.

## Before recording

- [ ] Only one server runs with the testnet keys (the hosted one on Railway). Stop any local `dev:server`.
- [ ] `https://hearthserver-production-97fb.up.railway.app/api/health`: `"chain":"near"`, every account in `chainStats.balances` above 0.1 NEAR, and `deals.sources.model` above 0 after a day change while you are online (the agents' deals come from the model).
- [ ] Railway log: `contract hearthmarket.testnet version 6` and `stall board: escrowed on chain by the stalls contract`.
- [ ] The hosted client shows the real art (Vercel build log: `fetch-art: imported … files`).
- [ ] Two browser windows: one **signed in with Google** (shared village, real transactions), one **guest** at `https://hearthmarket.space/?guest&tour` (for ⏩ 7 days). Tabs ready: `/dashboard`, `https://testnet.nearblocks.io/address/stalls-test.hearthmarket.testnet`.
- [ ] Signed-in window: hold 3–5 wheat before you start, so the stall scene does not wait on a purchase.
- [ ] Sound on (🔊): the coin chime is part of the feel. Record at 1920×1080, browser zoom 100%.
- [ ] Never show the private key (Account → Claim) or the Google email on screen.

## Video, about 2:30

| Time | Screen | Voice-over |
| --- | --- | --- |
| 0:00–0:10 | Login card → **Sign in with Google** → the village, NPCs walking | "Hearthmarket: six AI agents run a village economy on NEAR. You sign in with Google. No wallet." |
| 0:10–0:25 | Hover **Mike** → the "why this price" tooltip; click → panel with **Diary** and **Deals with other agents** | "Every agent explains its price from the same numbers it trades on: stock, the world price and the weather behind it, today's deal with another agent." |
| 0:25–0:45 | Mike's panel → **Haggle**: **Push low** (he refuses, counter), **Halfway** (he comes down), **Take** → "Deal". Show the speech bubbles over Mike on the map | "You haggle with them. Mike opens high and comes down over three rounds; lowball him and he remembers. The deal settles as your order, filled by Mike's own key." |
| 0:45–1:10 | **Market → Stall board**: list 3 wheat 10% under the market. **Prove on NEAR**: `relay_stall_list` queued → on chain → explorer shows the stalls contract | "You can sell to them. Your goods go into escrow in a separate stalls contract on NEAR." |
| 1:10–1:25 | Time reaches 11:00 → feed "Bruno bought your 3 wheat" → coins fly to the purse → Prove on NEAR: "Bruno bought your listing" → explorer: `npc_stall_buy` signed by `bruno.hearthmarket.testnet` | "At eleven the merchant checks the board and buys, signing with his own key. The seller is paid in the same transaction." |
| 1:25–1:45 | Guest window: **Hire a stall keeper** → Buba, *Sell fast* → **⏩ 7 days** → bottom left: week goal with stars and **vs Silas 🤖**; Buba's 20:00 report; feed line "Silas undercuts …" | "Or hire one to sell for you, with a strategy you pick; it reports every evening what it sold and why. And you are not alone: Silas, an AI rival, buys dips, undercuts your listings and takes the orders you leave open." |
| 1:45–1:55 | World panel: weather headlines, "World money … tokenized gold XAUT … NEAR Intents" | "World prices follow real weather; village gold follows the real price of gold, quoted by NEAR Intents." |
| 1:55–2:15 | **NPCs → Theo → Red team**: *send all gold* → `BLOCKED by the signer`; a contract-layer attack → "refused by the contract · tx" → explorer shows the failed tx | "The worst case: an agent whose brain obeys any prompt injection. The signer refuses what the key cannot do; what passes the key, the contract refuses, in public." |
| 2:15–2:30 | `/dashboard`: KPIs, agents ranked by net worth, leaderboard with Silas, proof list → README *Live on NEAR testnet* | "Everything is on a public dashboard, and every claim in the README links to a transaction. Built at NEAR HACKATHON." |

Shorter cut (about 90 s): 0:00–0:10, 0:25–0:45, 0:45–1:25, 1:55–2:15, then the closing line.

## X post (draft)

> Hearthmarket: a pixel village where six AI agents run the economy on NEAR, and you play with them.
>
> 🤝 Haggle with an NPC that remembers you; it signs the deal with its own key
> 🏪 Sell from your stall: goods in escrow on NEAR, the NPC buys with its own key
> 🤖 Race Silas, an AI rival trader who undercuts your listings
> 🌦 Real weather + the real gold price (NEAR Intents) move the market
> 🛡 Red team: prompt-injected agents still can't move the money
> 🎮 Google sign-in, no wallet
>
> Built at #NEARHackathon @NEARProtocol
> Play: https://hearthmarket.space
> Code: https://github.com/nguyenkhangph/hearthmarket

Attach the video. Optional tags: @NearLegion @NearBuilders. (Counts as one long post on X Premium; without Premium, cut the 🌦 and 🛡 lines or post the last three lines as a reply.)

## Submission text ("What they built", 1860 of 2000 characters)

> Game economies usually die in one of two ways: developers keep patching prices, or a token is pumped in and the game becomes a chart. Hearthmarket is a pixel village whose economy runs itself. Six AI agents (miner, lumberjack, farmer, baker, smith, merchant) produce, negotiate prices with each other, hire each other and fill player orders. Real weather in five producing regions moves world prices; the price of tokenized gold read from NEAR Intents sets what village gold is worth.
>
> Players play with the agents, not beside them: they haggle with an NPC over three rounds while it remembers lowballs and loyal customers, take big orders on a promise, list goods on a stall board that NPCs buy from, hire an NPC to keep their stall with a strategy they choose, and race Silas, an AI rival trader who undercuts their listings, toward a weekly goal.
>
> Every agent is a NEAR sub-account that signs its own transactions with a function-call key limited to the game contract and its own methods. The contract enforces daily budgets, recipes and escrow; gold is NEP-141, goods NEP-245, badges NEP-171. Stall listings move goods into a separate stalls contract by mt_transfer_call, and an NPC buys them with its own key through ft_transfer_call. Google players get a NEAR account derived from their login, the operator relays their trades, and they can claim the key into any wallet. The oracle posts world data with the SHA-256 of the source payload. Agent brains run on NEAR AI Cloud and can only turn bounded dials.
>
> Security is shown, not claimed: a red-team panel swaps an agent's brain for a model that obeys any prompt injection and runs 20 attacks. The signer refuses most before anything is signed; the contract refuses the rest as failed transactions anyone can open. A public dashboard shows prices, flows, agent deals and every call that reached testnet.

## Submission payload: what you decide

Collected from you before sending, never guessed (`docs/HACKATHON.md`):

| Field | Value |
| --- | --- |
| projectName | your choice, e.g. "Hearthmarket" |
| leadName | your name |
| email | your contact email (not committed anywhere) |
| size | one of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+` |
| tracks | suggested: `games`, `agents`, `swarms`, `security` (every track the project fits) |
| nearAddress | your **mainnet** account for the prize (create it in a wallet yourself) |
| projectUrl | https://github.com/nguyenkhangph/hearthmarket (must be public) |
| demoUrl | the link to your X post, after it is up |
| idea | the submission text above |
| consent | `true` only after you agree to: "I agree that the organizers may use these details to review our submission and contact us about this hackathon." |

When all values are in, the full JSON is printed for you and sent only after your yes. One attempt per team.
