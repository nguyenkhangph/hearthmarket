# Judge guide: check the claims in 3 minutes

Five claims, each with something to click and a transaction anyone can open on testnet. You do not need to install anything or have a wallet. To play the game itself, use the 7-step tour in the README (**https://hearthmarket.space/?guest&tour**).

| # | Claim | Check it | Proof on testnet |
| --- | --- | --- | --- |
| 1 | **Each NPC is its own NEAR account and signs its own transactions.** | Open one NPC account and see its transactions, signed with its own function-call key. | [`jack.hearthmarket.testnet`](https://testnet.nearblocks.io/address/jack.hearthmarket.testnet) · [jack produce](https://testnet.nearblocks.io/txns/2jWfs87vLGKrj7HE58mvgqiQBF4vQoFcPRVvnGnBDahF) |
| 2 | **Players trade without a wallet.** Google sign-in derives an account, and the operator relays the player's trades. | **Sign in** at hearthmarket.space and buy wheat, then open **⛓ Prove on NEAR**. | [relay_register_player](https://testnet.nearblocks.io/txns/4xfSsG6gYYbcMXZJdSGwm2t3ax6WhviQXSUuSn9m9R4N) · [relay_market_buy](https://testnet.nearblocks.io/txns/9DzZAaAFV1JX9xMiLxFLXu9TPgUQYHwYyDC1r3Ruk5rm) |
| 3 | **Stall listings are real escrow, and an NPC buys from them with its own key.** | **Market → Stall board** in the game; the listing's goods sit in the stalls contract. | [relay_stall_list](https://testnet.nearblocks.io/txns/BXUW8WvtjmwQ4Q1RZq5ydKtgfz1bR9fKPt3AJ4Ajun6J) · [npc_stall_buy](https://testnet.nearblocks.io/txns/8CFKM6pGdSHQfqngsk6pZ11QgGdsU9EhCWtwLV6UPb7R) · [bought twice: refunded](https://testnet.nearblocks.io/txns/EJhew1rDTVXpa4m4oza8NXa4YbftXgBAMHVfmFf5e7fX) |
| 4 | **A model that obeys any prompt injection still cannot move the money.** | **NPCs → any NPC → Red team → Attack**. The signer or the contract refuses the attack. | [refused by the contract: "not enough goods"](https://testnet.nearblocks.io/txns/Fy76rLeuSK3RTDuFfrJHz1XWY7A8tddsfsYz239cLPoG) · [Red Teamer badge](https://testnet.nearblocks.io/txns/6p6VTQRPC77SiumB8FzEX1grD6pNTQzb9xWXZ5kkdTWU) |
| 5 | **Real-world data moves the economy, and its source is on chain.** | **⏩ 7 days** in guest mode: weather moves world prices. Then the **Economy** panel and the [dashboard](https://hearthmarket.space/dashboard). | [post_world_data with the SHA-256 of the source payload](https://testnet.nearblocks.io/txns/BzDmSbpoVyeFFZa3qzhAGPRxCjQeMBfPazYyt9oYzM9) |

## Who is deciding right now: the model or the rules?

The answer is never hidden.

- The [dashboard](https://hearthmarket.space/dashboard)'s **Who decided** card says whether NEAR AI Cloud is answering. If it is not, the card shows when the model last answered and the provider's error (for example `HTTP 402` or `timed out`).
- [`/api/health`](https://hearthserver-production-97fb.up.railway.app/api/health) carries the same data under `model` (`lastOkAt`, `lastError`, `lastErrorAt`).
- In the game feed, every plan says `thinks (NEAR AI Cloud)` or `thinks (rules)`. When the model cannot be reached, the feed says so once a game day, with the reason. Agent deals made during an outage are labelled `rules (model unavailable: …)`.

When the model is unavailable, the village keeps running on deterministic rules, with the same guards, signer and contract. Nothing the model could do is ever needed for the money to stay safe.

## The trust boundary, in one line

The NPC keys, the signer and the contract decide what can happen. The model only proposes, inside bounded dials. The operator's periodic `reconcile` is the one place the server writes balances, and every reconcile emits an event saying what it changed. See *Trust boundary* in the README.
