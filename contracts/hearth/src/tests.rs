use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn as_caller(who: &str) {
    testing_env!(VMContextBuilder::new().predecessor_account_id(acc(who)).build());
}

fn setup() -> Hearth {
    as_caller("owner.testnet");
    let mut c = Hearth::new(acc("owner.testnet"), acc("oracle.testnet"), 250_000);
    c.register_npc(acc("theo.hearth.testnet"), 8_000, vec![], false, 8_000);
    c.register_npc(acc("mike.hearth.testnet"), 6_000, vec![Item::Ore], false, 8_000);
    c.register_npc(acc("bruno.hearth.testnet"), 40_000, vec![], true, 40_000);
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

#[test]
#[should_panic(expected = "NPC accounts cannot transfer gold")]
fn npc_cannot_transfer_gold() {
    let mut c = setup();
    as_caller("theo.hearth.testnet");
    c.ft_transfer(acc("mallory.testnet"), 8_000);
}

#[test]
fn player_can_transfer_gold() {
    let mut c = setup();
    as_caller("khang.testnet");
    c.ft_transfer(acc("mallory.testnet"), 1_000);
    assert_eq!(c.ft_balance_of(acc("mallory.testnet")), 6_000);
}

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
    assert_eq!(c.get_npc(acc("theo.hearth.testnet")).unwrap().spent_today > 0, true);
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
    assert_eq!(c.ft_balance_of(acc("mike.hearth.testnet")), 8_000 + 2_200);
    assert_eq!(c.ft_balance_of(acc("theo.hearth.testnet")), 8_000 - 2_200 - fee(2_200));
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

#[test]
fn order_escrow_fill_and_refund() {
    let mut c = setup();
    as_caller("khang.testnet");
    let id = c.place_order(Item::Ore, 2, 700, 3);
    let escrow = 1_400 + fee(1_400);
    assert_eq!(c.ft_balance_of(acc("khang.testnet")), 5_000 - escrow);
    as_caller("mike.hearth.testnet");
    c.produce(Item::Ore, 2);
    c.fill_order(id, 2, 600);
    let o = c.get_order(id).unwrap();
    assert_eq!(o.status, OrderStatus::Filled);
    assert_eq!(c.item_balance(acc("khang.testnet"), Item::Ore), 2);
    // paid 1200 + fee, rest refunded
    assert_eq!(c.ft_balance_of(acc("khang.testnet")), 5_000 - 1_200 - fee(1_200));
}

#[test]
fn order_expires_and_refunds() {
    let mut c = setup();
    as_caller("khang.testnet");
    c.place_order(Item::Sword, 1, 100, 2);
    as_caller("owner.testnet");
    c.advance_day();
    c.advance_day();
    assert_eq!(c.ft_balance_of(acc("khang.testnet")), 5_000);
}

#[test]
#[should_panic(expected = "no such order")]
fn fill_unknown_order_fails() {
    let mut c = setup();
    as_caller("theo.hearth.testnet");
    c.fill_order(999_999, 1, 100_000);
}

#[test]
#[should_panic(expected = "oracle only")]
fn only_oracle_posts_world_data() {
    let mut c = setup();
    as_caller("mallory.testnet");
    c.post_world_data("fake".into(), "{}".into(), 0, vec![(Item::Wheat, 1)], 0);
}

#[test]
fn world_trade_burns_on_import_and_mints_on_export() {
    let mut c = setup();
    as_caller("oracle.testnet");
    c.post_world_data("open-meteo".into(), "{\"kansas\":{\"tmax\":24}}".into(), 1, vec![(Item::Wheat, 216)], 600);
    let supply0 = c.ft_total_supply();
    as_caller("bruno.hearth.testnet");
    c.world_trade(Item::Wheat, 10, true);
    assert!(c.ft_total_supply() < supply0);
    c.world_trade(Item::Wheat, 10, false);
    assert_eq!(c.item_balance(acc("bruno.hearth.testnet"), Item::Wheat), 0);
}

#[test]
#[should_panic(expected = "merchant only")]
fn only_bruno_trades_with_the_world() {
    let mut c = setup();
    as_caller("oracle.testnet");
    c.post_world_data("open-meteo".into(), "{}".into(), 1, vec![(Item::Wheat, 216)], 600);
    as_caller("theo.hearth.testnet");
    c.world_trade(Item::Wheat, 1, true);
}

#[test]
fn fees_split_between_pool_and_burn() {
    let mut c = setup();
    let supply0 = c.ft_total_supply();
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
fn guild_flow_and_season_close() {
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
}

#[test]
fn items_use_lowercase_json() {
    assert_eq!(near_sdk::serde_json::to_string(&Item::Ore).unwrap(), "\"ore\"");
    let i: Item = near_sdk::serde_json::from_str("\"sword\"").unwrap();
    assert_eq!(i, Item::Sword);
}
