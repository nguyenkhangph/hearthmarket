use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("hearth.testnet")).predecessor_account_id(acc(who));
    b
}

fn as_caller(who: &str) {
    testing_env!(ctx(who).build());
}

fn as_caller_yocto(who: &str) {
    testing_env!(ctx(who).attached_deposit(NearToken::from_yoctonear(1)).build());
}

fn bal(c: &Hearth, who: &str) -> u128 {
    c.ft_balance_of(acc(who)).0
}

fn setup() -> Hearth {
    as_caller("owner.testnet");
    let mut c = Hearth::new(acc("owner.testnet"), acc("oracle.testnet"), 250_000);
    c.register_npc(acc("theo.hearth.testnet"), 8_000, vec![], false, 8_000);
    c.register_npc(acc("mike.hearth.testnet"), 6_000, vec![Item::Ore], false, 8_000);
    c.register_npc(acc("jack.hearth.testnet"), 6_000, vec![Item::Timber], false, 8_000);
    c.register_npc(acc("bruno.hearth.testnet"), 40_000, vec![], true, 40_000);
    c.set_crafts(acc("theo.hearth.testnet"), vec![Item::Tools, Item::Sword]);
    c.register_player(acc("khang.testnet"), 5_000);
    c.register_player(acc("mallory.testnet"), 5_000);
    c
}

#[test]
fn price_curve_matches_engine() {
    // values from packages/economy (midPrice) for the same inputs
    assert_eq!(mid_price(Item::Ore, 40), 600);
    assert!(mid_price(Item::Ore, 5) > 600);
    assert!(mid_price(Item::Ore, 100) < 600);
}

// ---------------------------------------------------------------- NEP-141 gold

#[test]
#[should_panic(expected = "NPC accounts cannot transfer gold")]
fn npc_cannot_transfer_gold() {
    let mut c = setup();
    as_caller_yocto("theo.hearth.testnet");
    c.ft_transfer(acc("mallory.testnet"), U128(8_000), None);
}

#[test]
#[should_panic(expected = "NPC accounts cannot transfer gold")]
fn npc_cannot_transfer_call_gold() {
    let mut c = setup();
    as_caller_yocto("theo.hearth.testnet");
    let _ = c.ft_transfer_call(acc("mallory.testnet"), U128(8_000), None, "".into());
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn ft_transfer_needs_one_yocto() {
    let mut c = setup();
    as_caller("khang.testnet");
    c.ft_transfer(acc("mallory.testnet"), U128(1_000), None);
}

#[test]
fn player_can_transfer_gold_with_event() {
    let mut c = setup();
    as_caller_yocto("khang.testnet");
    c.ft_transfer(acc("mallory.testnet"), U128(1_000), Some("thanks".into()));
    assert_eq!(bal(&c, "mallory.testnet"), 6_000);
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"ft_transfer\"") && l.contains("\"nep141\"")), "{logs:?}");
}

#[test]
fn ft_metadata_and_supply() {
    let c = setup();
    let m = c.ft_metadata();
    assert_eq!(m.spec, "ft-1.0.0");
    assert_eq!(m.decimals, 2);
    assert_eq!(m.symbol, "HGOLD");
    // treasury 2500 + NPC starts 640 + players 100
    assert_eq!(c.ft_total_supply().0, 250_000 + 8_000 * 3 + 40_000 + 5_000 * 2);
    // the contract account reports what it holds (treasury, pool, escrow)
    assert_eq!(bal(&c, "hearth.testnet"), 250_000);
}

#[test]
fn ft_resolve_transfer_refunds_unused_amount() {
    let mut c = setup();
    as_caller_yocto("khang.testnet");
    let _ = c.ft_transfer_call(acc("shop.testnet"), U128(1_000), None, "buy".into());
    assert_eq!(bal(&c, "shop.testnet"), 1_000);
    // receiver says it used only 600: 400 back to the sender
    testing_env!(
        ctx("hearth.testnet").build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(b"\"400\"".to_vec())],
    );
    let used = c.ft_resolve_transfer(acc("khang.testnet"), acc("shop.testnet"), U128(1_000));
    assert_eq!(used.0, 600);
    assert_eq!(bal(&c, "khang.testnet"), 5_000 - 600);
    assert_eq!(bal(&c, "shop.testnet"), 600);
}

#[test]
fn storage_registration_is_free() {
    let c = setup();
    assert_eq!(c.storage_balance_bounds().min.0, 0);
    assert!(c.storage_balance_of(acc("anyone.testnet")).is_some());
}

// ---------------------------------------------------------------- NPC guard

#[test]
#[should_panic(expected = "over the daily budget")]
fn npc_budget_is_enforced() {
    let mut c = setup();
    as_caller("theo.hearth.testnet");
    c.market_buy(Item::Ore, 14, 10_000); // ~84 gold + fee > 80
}

#[test]
fn npc_budget_resets_next_day() {
    let mut c = setup();
    as_caller("theo.hearth.testnet");
    c.market_buy(Item::Ore, 5, 10_000); // ~31 gold of an 80 budget
    c.market_buy(Item::Ore, 5, 10_000); // ~33 more: 64 of 80, still inside
    as_caller("owner.testnet");
    c.advance_day();
    as_caller("theo.hearth.testnet");
    assert!(c.get_npc(acc("theo.hearth.testnet")).unwrap().spent_today > 0);
    c.market_buy(Item::Wheat, 1, 10_000); // a new day, a fresh budget
    let p = c.get_npc(acc("theo.hearth.testnet")).unwrap();
    assert_eq!(p.day, 2);
    assert!(p.spent_today < 1_000);
}

#[test]
#[should_panic(expected = "invalid quantity")]
fn huge_quantity_rejected() {
    let mut c = setup();
    as_caller("khang.testnet");
    c.market_buy(Item::Wheat, 100_000, 1);
}

#[test]
#[should_panic(expected = "price must be positive")]
fn zero_price_hire_rejected() {
    let mut c = setup();
    as_caller("mike.hearth.testnet");
    c.produce(Item::Ore, 4);
    as_caller("theo.hearth.testnet");
    c.hire(acc("mike.hearth.testnet"), Item::Ore, 4, 0);
}

#[test]
fn hire_moves_goods_and_gold_with_fee() {
    let mut c = setup();
    as_caller("mike.hearth.testnet");
    c.produce(Item::Ore, 4);
    as_caller("theo.hearth.testnet");
    c.hire(acc("mike.hearth.testnet"), Item::Ore, 4, 550);
    assert_eq!(c.item_balance(acc("theo.hearth.testnet"), Item::Ore), 4);
    assert_eq!(bal(&c, "mike.hearth.testnet"), 8_000 + 2_200);
    assert_eq!(bal(&c, "theo.hearth.testnet"), 8_000 - 2_200 - fee(2_200));
}

#[test]
#[should_panic(expected = "not enough goods")]
fn hire_without_seller_stock_fails() {
    let mut c = setup();
    as_caller("theo.hearth.testnet");
    c.hire(acc("mike.hearth.testnet"), Item::Ore, 500, 1);
}

#[test]
#[should_panic(expected = "this account cannot produce that item")]
fn only_producers_produce() {
    let mut c = setup();
    as_caller("mallory.testnet");
    c.produce(Item::Ore, 5);
}

// ---------------------------------------------------------------- crafting

#[test]
fn smith_crafts_tools_from_ore_and_timber() {
    let mut c = setup();
    as_caller("mike.hearth.testnet");
    c.produce(Item::Ore, 4);
    as_caller("jack.hearth.testnet");
    c.produce(Item::Timber, 3);
    as_caller("theo.hearth.testnet");
    c.hire(acc("mike.hearth.testnet"), Item::Ore, 4, 600);
    c.hire(acc("jack.hearth.testnet"), Item::Timber, 3, 270);
    c.craft(Item::Tools, 2); // 2 ore + 2 timber -> 4 tools
    c.craft(Item::Sword, 1); // 2 ore + 1 timber -> 1 sword
    assert_eq!(c.item_balance(acc("theo.hearth.testnet"), Item::Tools), 4);
    assert_eq!(c.item_balance(acc("theo.hearth.testnet"), Item::Sword), 1);
    assert_eq!(c.item_balance(acc("theo.hearth.testnet"), Item::Ore), 0);
    assert_eq!(c.item_balance(acc("theo.hearth.testnet"), Item::Timber), 0);
}

#[test]
#[should_panic(expected = "not enough goods")]
fn crafting_needs_inputs() {
    let mut c = setup();
    as_caller("theo.hearth.testnet");
    c.craft(Item::Sword, 1);
}

#[test]
#[should_panic(expected = "this account cannot craft that item")]
fn only_crafters_craft() {
    let mut c = setup();
    as_caller("mike.hearth.testnet");
    c.produce(Item::Ore, 2);
    c.craft(Item::Sword, 1);
}

// ---------------------------------------------------------------- orders

#[test]
fn order_escrow_fill_and_refund() {
    let mut c = setup();
    as_caller("khang.testnet");
    let id = c.place_order(Item::Ore, 2, 700, 3);
    assert!(id >= AUTO_ORDER_ID_START);
    let escrow = 1_400 + fee(1_400);
    assert_eq!(bal(&c, "khang.testnet"), 5_000 - escrow);
    assert_eq!(bal(&c, "hearth.testnet"), 250_000 + escrow);
    as_caller("mike.hearth.testnet");
    c.produce(Item::Ore, 2);
    c.fill_order(id, 2, 600);
    let o = c.get_order(id).unwrap();
    assert_eq!(o.status, OrderStatus::Filled);
    assert!(c.get_open_orders().is_empty());
    assert_eq!(c.item_balance(acc("khang.testnet"), Item::Ore), 2);
    // paid 1200 + fee, rest refunded
    assert_eq!(bal(&c, "khang.testnet"), 5_000 - 1_200 - fee(1_200));
}

#[test]
fn order_expires_and_refunds() {
    let mut c = setup();
    as_caller("khang.testnet");
    c.place_order(Item::Sword, 1, 100, 2);
    as_caller("owner.testnet");
    c.advance_day();
    c.advance_day();
    assert_eq!(bal(&c, "khang.testnet"), 5_000);
    assert!(c.get_open_orders().is_empty());
}

#[test]
#[should_panic(expected = "no such order")]
fn fill_unknown_order_fails() {
    let mut c = setup();
    as_caller("theo.hearth.testnet");
    c.fill_order(999_999, 1, 100_000);
}

// ---------------------------------------------------------------- operator

#[test]
#[should_panic(expected = "oracle only")]
fn only_oracle_posts_world_data() {
    let mut c = setup();
    as_caller("mallory.testnet");
    c.post_world_data("fake".into(), "{}".into(), "".into(), 0, vec![(Item::Wheat, 1)], 0);
}

#[test]
fn world_data_is_logged_with_its_hash() {
    let mut c = setup();
    as_caller("oracle.testnet");
    c.post_world_data("open-meteo forecast".into(), "{}".into(), "ab".repeat(32), 1, vec![(Item::Wheat, 216)], 600);
    assert!(get_logs().iter().any(|l| l.contains("\"world_data\"") && l.contains(&"ab".repeat(32))));
    assert_eq!(c.get_world().unwrap().sha256, "ab".repeat(32));
}

#[test]
fn world_trade_burns_on_import_and_mints_on_export() {
    let mut c = setup();
    as_caller("oracle.testnet");
    c.post_world_data("open-meteo".into(), "{\"kansas\":{\"tmax\":24}}".into(), "".into(), 1, vec![(Item::Wheat, 216)], 600);
    let supply0 = c.ft_total_supply().0;
    as_caller("bruno.hearth.testnet");
    c.world_trade(Item::Wheat, 10, true);
    assert!(c.ft_total_supply().0 < supply0);
    c.world_trade(Item::Wheat, 10, false);
    assert_eq!(c.item_balance(acc("bruno.hearth.testnet"), Item::Wheat), 0);
}

#[test]
#[should_panic(expected = "merchant only")]
fn only_bruno_trades_with_the_world() {
    let mut c = setup();
    as_caller("oracle.testnet");
    c.post_world_data("open-meteo".into(), "{}".into(), "".into(), 1, vec![(Item::Wheat, 216)], 600);
    as_caller("theo.hearth.testnet");
    c.world_trade(Item::Wheat, 1, true);
}

#[test]
fn reconcile_starts_a_day_and_reanchors_balances() {
    let mut c = setup();
    as_caller("theo.hearth.testnet");
    c.market_buy(Item::Ore, 5, 10_000);
    let supply0 = c.ft_total_supply().0;
    as_caller("oracle.testnet");
    c.reconcile(
        7,
        vec![(Item::Ore, 30)],
        Some(U128(260_000)),
        vec![(acc("theo.hearth.testnet"), U128(9_000)), (acc("mike.hearth.testnet"), U128(7_500))],
        vec![(acc("theo.hearth.testnet"), Item::Ore, 2)],
    );
    let (day, _, supply, treasury, _, _) = c.get_economy();
    assert_eq!(day, 2);
    assert_eq!(c.get_game_day(), 7);
    assert_eq!(treasury, 260_000);
    assert_eq!(bal(&c, "theo.hearth.testnet"), 9_000);
    assert_eq!(bal(&c, "mike.hearth.testnet"), 7_500);
    assert_eq!(c.item_balance(acc("theo.hearth.testnet"), Item::Ore), 2);
    assert_eq!(c.get_market()[0].1, 30);
    assert_ne!(supply, supply0, "reconcile adjustments change the supply");
    assert!(get_logs().iter().any(|l| l.contains("reconcile")));
    // the NPC budget restarts with the new day
    as_caller("theo.hearth.testnet");
    c.market_buy(Item::Wheat, 1, 10_000);
    assert!(c.get_npc(acc("theo.hearth.testnet")).unwrap().spent_today < 1_000);
}

#[test]
#[should_panic(expected = "oracle only")]
fn npcs_cannot_reconcile() {
    let mut c = setup();
    as_caller("theo.hearth.testnet");
    c.reconcile(2, vec![], None, vec![(acc("theo.hearth.testnet"), U128(1_000_000))], vec![]);
}

#[test]
fn relayed_player_order_is_filled_by_the_npc_with_the_same_id() {
    let mut c = setup();
    as_caller("oracle.testnet");
    assert!(c.relay_register_player(acc("p-1234.hearth.testnet"), U128(5_000)));
    assert!(!c.relay_register_player(acc("p-1234.hearth.testnet"), U128(5_000)), "start gold only once");
    c.relay_market_buy(acc("p-1234.hearth.testnet"), Item::Wheat, 3, 1_000);
    assert_eq!(c.item_balance(acc("p-1234.hearth.testnet"), Item::Wheat), 3);
    c.relay_place_order(acc("p-1234.hearth.testnet"), 42, Item::Ore, 2, 700, 3);
    assert_eq!(c.get_order(42).unwrap().deadline_day, 4);
    as_caller("mike.hearth.testnet");
    c.produce(Item::Ore, 2);
    c.fill_order(42, 2, 650);
    assert_eq!(c.item_balance(acc("p-1234.hearth.testnet"), Item::Ore), 2);
    as_caller("oracle.testnet");
    c.relay_market_sell(acc("p-1234.hearth.testnet"), Item::Wheat, 3, 1);
    assert_eq!(c.item_balance(acc("p-1234.hearth.testnet"), Item::Wheat), 0);
}

#[test]
#[should_panic(expected = "oracle only")]
fn players_cannot_relay_for_others() {
    let mut c = setup();
    as_caller("mallory.testnet");
    c.relay_market_buy(acc("khang.testnet"), Item::Wheat, 1, 1_000);
}

#[test]
#[should_panic(expected = "NPCs sign for themselves")]
fn relay_cannot_act_for_npcs() {
    let mut c = setup();
    as_caller("oracle.testnet");
    c.relay_market_buy(acc("theo.hearth.testnet"), Item::Wheat, 1, 1_000);
}

#[test]
#[should_panic(expected = "player not registered")]
fn relay_needs_a_registered_player() {
    let mut c = setup();
    as_caller("oracle.testnet");
    c.relay_market_buy(acc("nobody.testnet"), Item::Wheat, 1, 1_000);
}

// ---------------------------------------------------------------- economy, guilds

#[test]
fn fees_split_between_pool_and_burn() {
    let mut c = setup();
    let supply0 = c.ft_total_supply().0;
    as_caller("khang.testnet");
    let total = c.market_buy(Item::Wheat, 3, 1_000);
    let f = fee(total);
    let (_, _, supply, _, pool, burned) = c.get_economy();
    assert_eq!(pool, f / 2);
    assert_eq!(burned, f - f / 2);
    assert_eq!(supply, supply0 - burned);
}

#[test]
#[should_panic(expected = "NPCs cannot deposit into guilds")]
fn npc_cannot_deposit_into_guild() {
    let mut c = setup();
    as_caller("theo.hearth.testnet");
    c.deposit(1_000);
}

#[test]
fn guild_flow_and_season_close_with_badges() {
    let mut c = setup();
    as_caller("khang.testnet");
    c.create_guild("Ember Dragons".into());
    c.deposit(3_000);
    for p in ["a.testnet", "b.testnet"] {
        as_caller("owner.testnet");
        c.register_player(acc(p), 5_000);
        as_caller(p);
        c.join_guild("Ember Dragons".into());
    }
    as_caller("khang.testnet");
    c.rent_stall(0);
    c.guild_invest(acc("mike.hearth.testnet"), 500);
    c.market_buy(Item::Wheat, 3, 1_000); // put something in the pool
    as_caller("owner.testnet");
    let pool = c.get_economy().4;
    c.close_season(vec!["Ember Dragons".into()]);
    let g = c.get_guild("Ember Dragons".into()).unwrap();
    assert_eq!(g.fund, 3_000 - STALL_RENT - 500 + pool * 2500 / 10_000);
    assert_eq!(c.nft_total_supply().0, 3);
    let mine = c.nft_tokens_for_owner(acc("khang.testnet"), None, None);
    assert_eq!(mine.len(), 1);
    assert!(mine[0].metadata.title.as_ref().unwrap().contains("Season 1 · #1 · Ember Dragons"));
}

// ---------------------------------------------------------------- NEP-171 badges

#[test]
fn oracle_mints_soulbound_badges() {
    let mut c = setup();
    as_caller("oracle.testnet");
    let id = c.mint_badge(acc("khang.testnet"), "quest".into(), "First steps".into(), "Finished the four starter quests".into());
    assert_eq!(id, "1");
    let t = c.nft_token(id).unwrap();
    assert_eq!(t.owner_id, acc("khang.testnet"));
    assert!(t.metadata.extra.unwrap().contains("\"soulbound\":true"));
    assert_eq!(c.nft_supply_for_owner(acc("khang.testnet")).0, 1);
    assert_eq!(c.nft_metadata().spec, "nft-1.0.0");
    assert!(get_logs().iter().any(|l| l.contains("\"nft_mint\"") && l.contains("\"nep171\"")));
}

#[test]
#[should_panic(expected = "badges are soulbound")]
fn badges_cannot_be_transferred() {
    let mut c = setup();
    as_caller("oracle.testnet");
    let id = c.mint_badge(acc("khang.testnet"), "quest".into(), "First steps".into(), "".into());
    as_caller_yocto("khang.testnet");
    c.nft_transfer(acc("mallory.testnet"), id, None, None);
}

#[test]
#[should_panic(expected = "oracle only")]
fn players_cannot_mint_badges() {
    let mut c = setup();
    as_caller("khang.testnet");
    c.mint_badge(acc("khang.testnet"), "season".into(), "Champion".into(), "".into());
}

// ---------------------------------------------------------------- upgrade

#[test]
fn migrate_keeps_version_1_balances_and_orders() {
    as_caller("hearth.testnet");
    let mut gold = LookupMap::new(b"g");
    gold.insert(acc("mike.hearth.testnet"), 7_777u128);
    gold.flush();
    let mut npcs = LookupMap::new(b"n");
    npcs.insert(acc("mike.hearth.testnet"), NpcPolicy { daily_budget: 6_000, spent_today: 5_900, day: 3, produces: vec![Item::Ore], merchant: false });
    npcs.flush();
    let mut orders = IterableMap::new(b"o");
    orders.insert(5u64, Order { id: 5, buyer: acc("khang.testnet"), item: Item::Ore, qty: 1, filled: 0, max_price: 700, escrow: 710, deadline_day: 5, status: OrderStatus::Open });
    orders.flush();
    let v1 = HearthV1 {
        owner: acc("hearth.testnet"),
        oracle: acc("hearth.testnet"),
        day: 3,
        season: 1,
        gold,
        items: LookupMap::new(b"i"),
        total_supply: 300_000,
        burned: 12,
        market_stock: [40, 40, 60, 24, 10, 8],
        treasury: 250_000,
        season_pool: 6,
        npcs,
        orders,
        next_order: 6,
        guilds: IterableMap::new(b"G"),
        member_of: LookupMap::new(b"m"),
        stalls: (0..4).map(|_| Stall::default()).collect(),
        world: Some(WorldPostV1 { source: "replay".into(), raw: "{}".into(), ts: 1, prices: vec![(Item::Wheat, 200)], shipping_bps: 600 }),
    };
    env::state_write(&v1);
    let c = Hearth::migrate();
    assert_eq!(c.get_version(), "2");
    assert_eq!(bal(&c, "mike.hearth.testnet"), 7_777);
    assert_eq!(c.get_npc(acc("mike.hearth.testnet")).unwrap().spent_today, 5_900);
    assert_eq!(c.get_open_orders().len(), 1);
    assert_eq!(c.get_economy(), (3, 1, 300_000, 250_000, 6, 12));
    assert_eq!(c.get_world().unwrap().prices, vec![(Item::Wheat, 200)]);
}

#[test]
fn items_use_lowercase_json() {
    assert_eq!(near_sdk::serde_json::to_string(&Item::Ore).unwrap(), "\"ore\"");
    let i: Item = near_sdk::serde_json::from_str("\"sword\"").unwrap();
    assert_eq!(i, Item::Sword);
}
