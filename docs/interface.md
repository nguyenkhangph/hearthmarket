# Contract interface (freeze on day 1)

The four build tracks depend on each other only through this interface. Change it only by agreement, and update the engine (`packages/economy`), the signer and the contract in the same PR.

Accounts (proposed; verify sub-account and key syntax on docs.near.org before creating them):

```
hearth.testnet                 market, recipes, budgets, orders, guilds, stalls, world oracle
├─ gold.hearth.testnet         NEP-141 gold            (planned; internal ledger today)
├─ items.hearth.testnet        NEP-245 items           (planned; internal ledger today)
├─ badge.hearth.testnet        NEP-171 season badges   (planned)
├─ mike / jack / buba / chloe / theo / bruno .hearth.testnet   NPC accounts
└─ oracle.hearth.testnet       posts world data
```

NPC function-call key: receiver `hearth.testnet`, methods `produce, market_buy, market_sell, hire, fill_order, place_order` (+ `world_trade` for Bruno's key). Zero allowance for deposits.

Units: gold is `u128` centigold (1 gold = 100). Items in JSON: `"ore" | "timber" | "wheat" | "bread" | "tools" | "sword"` (same strings in the contract and TypeScript).

## Calls

| Method | Caller | Checks |
| --- | --- | --- |
| `market_buy(item, qty, max_price) -> Gold` | anyone | qty 1..1000, price ≤ max, NPC daily budget, 1.5% fee |
| `market_sell(item, qty, min_price) -> Gold` | anyone | holds goods, price ≥ min, treasury covers it |
| `hire(seller, item, qty, price)` | NPC | both NPCs, price > 0, seller has goods, budget, fee |
| `produce(item, qty)` | raw-producer NPC | item in its `produces`, daily cap |
| `place_order(item, qty, max_price, deadline_day) -> u64` | anyone | escrow = qty·max + fee, deadline 1–7 days |
| `fill_order(order_id, qty, price)` | producer | open order, price ≤ max, goods move with gold |
| `cancel_order(order_id)` | buyer | refund escrow |
| `post_world_data(source, raw, ts, prices, shipping_bps)` | oracle | raw payload ≤ 4 KB, stored for re-checking |
| `world_trade(item, qty, import)` | Bruno | world price + shipping; import burns, export mints |
| `create_guild(name)` · `join_guild(name)` · `deposit(amount)` | players | one guild per season, 20 members |
| `guild_invest(npc, amount)` | guild leader | fund covers it |
| `rent_stall(slot)` · `set_stall_prices(slot, item, buy, sell)` | guild leader | one stall per guild, buy < sell |
| `close_season(ranking)` | owner | ≥3 members per ranked guild; split 25/18/13/10/8/7/6/5/4/4% |
| `ft_transfer(receiver_id, amount)` | players only | panics for NPC accounts |
| `advance_day()` | owner/oracle | expires orders, budgets reset lazily |

Views: `ft_balance_of`, `ft_total_supply`, `item_balance`, `get_npc`, `get_order`, `get_guild`, `get_market`, `get_economy`, `get_world`.

## Planned additions

`declare_war(id, rival, item, side)` (market wars, if time allows), `mint_badge` on season close (NEP-171), guild votes on chain (`propose_vote`, `cast_vote`) or via Sputnik DAO.
