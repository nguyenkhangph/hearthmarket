# Contract interface (version 2)

The build tracks depend on each other only through this interface. Change it only by agreement, and update the engine (`packages/economy`), the server mirror (`apps/server/src/chain/mirror.ts`) and the contract in the same PR.

Accounts (testnet deployment: `hearthmarket.testnet`):

```
<contract>                       market, recipes, budgets, orders, guilds, stalls, world oracle,
│                                NEP-141 gold (HGOLD, 2 decimals), NEP-171 badges (HBADGE, soulbound)
├─ mike / jack / buba / chloe / theo / bruno .<contract>   NPC accounts, one function-call key each
└─ players                       NEAR implicit accounts (64 hex) derived per Google account;
                                 no wallet, the operator relays their trades
```

Keys:

| Key | On account | Methods |
| --- | --- | --- |
| Mike, Jack, Buba | their NPC account | `produce, market_buy, market_sell, hire, fill_order, place_order` |
| Chloe, Theo | their NPC account | `craft, market_buy, market_sell, hire, fill_order, place_order` |
| Bruno | his NPC account | `world_trade, market_buy, market_sell, hire, fill_order, place_order` |
| Operator (game server) | the contract account | `reconcile, post_world_data, advance_day, mint_badge, relay_register_player, relay_market_buy, relay_market_sell, relay_place_order, relay_cancel_order` |

The lists live in `NPC_KEY_METHODS` and `OPERATOR_METHODS` (`packages/economy/src/policy.ts`); `npm run setup:testnet` creates exactly these keys. The owner's full-access key is only used by the setup script.

Units: gold is `u128` centigold (1 gold = 100); NEP-141 methods use `U128` strings as the standard requires. Items in JSON: `"ore" | "timber" | "wheat" | "bread" | "tools" | "sword"`.

## Calls

| Method | Caller | Checks |
| --- | --- | --- |
| `market_buy(item, qty, max_price) -> Gold` | anyone | qty 1..1000, price ≤ max, NPC daily budget, 1.5% fee |
| `market_sell(item, qty, min_price) -> Gold` | anyone | holds goods, price ≥ min, treasury covers it |
| `hire(seller, item, qty, price)` | NPC | both NPCs, not self, price > 0, seller has goods, budget, fee |
| `produce(item, qty)` | raw-producer NPC | item in its `produces`, ≤ 12 per call |
| `craft(item, crafts)` | crafter NPC | item in its crafts (`set_crafts`), holds the inputs; bread ← wheat, 2 tools ← ore + timber, sword ← 2 ore + timber |
| `place_order(item, qty, max_price, deadline_day) -> u64` | anyone | escrow = qty·max + fee, deadline 1–7 days, ids from 1e9 |
| `fill_order(order_id, qty, price)` | seller | open order, price ≤ max, goods move with gold |
| `cancel_order(order_id)` | buyer | refund escrow |
| `world_trade(item, qty, import)` | Bruno | posted world price + shipping; import burns, export mints |
| `create_guild(name)` · `join_guild(name)` · `deposit(amount)` | players | one guild per season, 20 members |
| `guild_invest(npc, amount)` | guild leader | fund covers it |
| `rent_stall(slot)` · `set_stall_prices(slot, item, buy, sell)` | guild leader | one stall per guild, buy < sell |
| `close_season(ranking)` | owner | ≥3 members per ranked guild; split 25/18/13/10/8/7/6/5/4/4%; badge to every member of the top 3 |

Operator:

| Method | Does |
| --- | --- |
| `reconcile(game_day, market_stock, treasury?, gold[], items[])` | starts the next chain day (budgets reset, orders expire), then sets market stock, treasury and the listed balances to the engine's books; every gold change is an `ft_mint`/`ft_burn` event with memo `reconcile` |
| `post_world_data(source, raw, sha256, ts, prices, shipping_bps)` | world prices with the API source, compact reading (≤ 2 KB) and the SHA-256 of the full API payload; logged as a `world_data` event |
| `relay_register_player(player, start_gold) -> bool` | once per player |
| `relay_market_buy / relay_market_sell(player, …)` · `relay_place_order(player, order_id, item, qty, max_price, deadline_days)` · `relay_cancel_order(player, order_id)` | trades for wallet-less players; refuses NPC accounts |
| `mint_badge(owner_id, kind, title, description) -> token_id` | soulbound quest/season badge |
| `advance_day()` | owner or operator |

Owner: `register_npc(account, daily_budget, produces, merchant, start_gold)`, `set_crafts(account, items)`, `register_player(account, start_gold)`, `close_season(ranking)`. Upgrade: `migrate()` (private, init with `ignore_state`) from the version 1 layout.

## Standards

* **NEP-141** gold: `ft_transfer(receiver_id, amount, memo)` and `ft_transfer_call(…, msg)` need 1 yoctoNEAR and **panic for NPC accounts**; `ft_resolve_transfer`, `ft_total_supply`, `ft_balance_of`, `ft_metadata` (`HGOLD`, 2 decimals). `ft_balance_of(<contract>)` reports what the contract holds (treasury, season pool, escrow, guild funds, stalls). Events per NEP-297 (`ft_mint`, `ft_burn`, `ft_transfer`).
* **NEP-145** storage: free (`storage_deposit` refunds any deposit, bounds 0/0); the game pays storage.
* **NEP-171/177** badges: `nft_token`, `nft_tokens`, `nft_tokens_for_owner`, `nft_supply_for_owner`, `nft_total_supply`, `nft_metadata`; `nft_transfer` and `nft_transfer_call` panic: badges are soulbound. `nft_mint` events.

Views: `get_version`, `item_balance`, `items_of`, `get_npc`, `get_crafts`, `is_player`, `get_order`, `get_open_orders`, `get_guild`, `get_market`, `get_economy` (day, season, supply, treasury, pool, burned), `get_game_day`, `get_world`, `get_roles`.

## What is on chain and what is not (yet)

On chain: NPC production, crafting, NPC-to-NPC deals, NPC market trades, order escrow and fills for orders players placed, Bruno's world trades, world data, player registrations and their market trades and orders, badges. Each NPC call is signed by that NPC's own key.

Engine only: eating, upkeep, tool wear, guild funds, votes, investments, stalls and the 4 AI guilds' bots. `reconcile` brings the chain's balances back to the engine's books once a game day, and logs the difference.

## Planned

NEP-245 items, guild funds and votes on chain, market wars, a "claim your account" step that hands the derived player key to the player.
