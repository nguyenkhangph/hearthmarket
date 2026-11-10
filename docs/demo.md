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

## Video (made, v7)

Two cuts, rendered from the live client in guest mode with narration (Kokoro TTS), subtitles, original music and zooms; every on-chain claim in them is a real testnet transaction:

- **Full, 3:06** (`hearthmarket-demo-v7.mp4`): hook · Google sign-in · the village · real weather and the gold price · agents negotiate · haggle over three rounds · sell from your stall (escrow, Bruno buys with his own key) · hire a keeper and race Silas · council and co-op caravan · red team · the refused transaction on Nearblocks · every claim on chain · outro.
- **Short, 2:18** (`hearthmarket-demo-v7-short.mp4`): for an X account without Premium (videos up to 2:20). Drops sign-in, weather, agent-to-agent deals and the claims card.

The NEAR rules set no length limit; post the full cut if the X account allows it. After posting, put the post's link in the README (top, next to *Play*).

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

## Submission text ("What they built", 1891 of 2000 characters)

> Game economies usually die in one of two ways: developers keep patching prices, or a token is pumped in and the game becomes a chart. Hearthmarket is a pixel village whose economy runs itself. Six AI agents (miner, lumberjack, farmer, baker, smith, merchant) produce, negotiate prices with each other, hire each other and fill player orders. Real weather in five producing regions moves world prices; the price of tokenized gold read from NEAR Intents sets what village gold is worth.
>
> Players play with the agents, not beside them: they haggle with an NPC over three rounds while it remembers lowballs and loyal customers, take big orders on a promise, list goods on a stall board that NPCs buy from, hire an NPC to keep their stall, vote in a council where each NPC votes its own interest, fill co-op caravans with them, and race Silas, an AI rival trader, toward a weekly goal.
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
