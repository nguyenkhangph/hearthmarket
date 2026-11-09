use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn as_caller(who: &str) {
    testing_env!(VMContextBuilder::new().current_account_id(acc("stalls.hearth.testnet")).predecessor_account_id(acc(who)).build());
}

const GAME: &str = "hearth.testnet";

fn setup() -> Stalls {
    as_caller("owner.testnet");
    Stalls::new(acc(GAME))
}

fn list(c: &mut Stalls, seller: &str, id: u64, token: &str, qty: u128, price: u128) -> Vec<U128> {
    as_caller(GAME);
    match c.mt_on_transfer(acc(seller), vec![acc(seller)], vec![token.into()], vec![U128(qty)], format!(r#"{{"list":{{"id":{id},"price":"{price}"}}}}"#)) {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("expected a value"),
    }
}

fn buy(c: &mut Stalls, buyer: &str, id: u64, amount: u128) -> u128 {
    as_caller(GAME);
    match c.ft_on_transfer(acc(buyer), U128(amount), format!(r#"{{"buy":{{"id":{id}}}}}"#)) {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => panic!("expected a value"),
    }
}

#[test]
fn list_then_buy_pays_the_seller_and_hands_over_the_goods() {
    let mut c = setup();
    assert_eq!(list(&mut c, "khang.testnet", 7, "ore", 3, 550), vec![U128(0)]);
    assert_eq!(c.get_open_count(), 1);
    // pays 1_700 for a 1_650 listing: 50 comes back
    assert_eq!(buy(&mut c, "bruno.hearth.testnet", 7, 1_700), 50);
    let l = c.get_listing(7).unwrap();
    assert_eq!(l.status, Status::Sold);
    assert_eq!(l.buyer, Some(acc("bruno.hearth.testnet")));
    assert_eq!(c.get_open_count(), 0);
    // both payouts already started: nothing left owed
    assert_eq!(c.owed_to(acc("khang.testnet")).gold.0, 0);
    assert!(c.owed_to(acc("bruno.hearth.testnet")).items.is_empty());
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"sold\"") && l.contains("\"total\":\"1650\"")));
}

#[test]
fn a_sold_listing_cannot_be_bought_again() {
    let mut c = setup();
    list(&mut c, "khang.testnet", 7, "ore", 3, 550);
    buy(&mut c, "bruno.hearth.testnet", 7, 1_650);
    assert_eq!(buy(&mut c, "mike.hearth.testnet", 7, 1_650), 1_650);
    assert_eq!(c.get_listing(7).unwrap().buyer, Some(acc("bruno.hearth.testnet")));
}

#[test]
fn short_unknown_or_self_purchases_are_refunded_in_full() {
    let mut c = setup();
    list(&mut c, "khang.testnet", 7, "ore", 3, 550);
    assert_eq!(buy(&mut c, "bruno.hearth.testnet", 7, 1_649), 1_649);
    assert_eq!(buy(&mut c, "bruno.hearth.testnet", 99, 5_000), 5_000);
    assert_eq!(buy(&mut c, "khang.testnet", 7, 1_650), 1_650);
    as_caller(GAME);
    assert!(matches!(c.ft_on_transfer(acc("bruno.hearth.testnet"), U128(10), "not json".into()), PromiseOrValue::Value(U128(10))));
    assert_eq!(c.get_listing(7).unwrap().status, Status::Open);
}

#[test]
fn bad_listings_send_the_goods_back() {
    let mut c = setup();
    assert_eq!(list(&mut c, "khang.testnet", 1, "gems", 3, 550), vec![U128(3)]);
    assert_eq!(list(&mut c, "khang.testnet", 2, "ore", 3, 0), vec![U128(3)]);
    assert_eq!(list(&mut c, "khang.testnet", 3, "ore", 3, 550), vec![U128(0)]);
    assert_eq!(list(&mut c, "mallory.testnet", 3, "ore", 1, 1), vec![U128(1)]); // id taken
    as_caller(GAME);
    let r = c.mt_on_transfer(acc("khang.testnet"), vec![acc("khang.testnet")], vec!["ore".into()], vec![U128(2)], "{}".into());
    assert!(matches!(r, PromiseOrValue::Value(v) if v == vec![U128(2)]));
    assert_eq!(c.get_open_count(), 1);
}

#[test]
fn a_seller_has_at_most_ten_open_listings() {
    let mut c = setup();
    for id in 0..10 {
        assert_eq!(list(&mut c, "khang.testnet", id, "ore", 1, 500), vec![U128(0)]);
    }
    assert_eq!(list(&mut c, "khang.testnet", 10, "ore", 1, 500), vec![U128(1)]);
    assert_eq!(list(&mut c, "lan.testnet", 10, "ore", 1, 500), vec![U128(0)]);
}

#[test]
#[should_panic(expected = "only the game contract")]
fn goods_from_anywhere_else_are_refused() {
    let mut c = setup();
    as_caller("fake-token.testnet");
    let _ = c.mt_on_transfer(acc("khang.testnet"), vec![acc("khang.testnet")], vec!["ore".into()], vec![U128(3)], r#"{"list":{"id":1,"price":"1"}}"#.into());
}

#[test]
#[should_panic(expected = "only the game contract")]
fn gold_from_anywhere_else_is_refused() {
    let mut c = setup();
    list(&mut c, "khang.testnet", 7, "ore", 3, 550);
    as_caller("fake-token.testnet");
    let _ = c.ft_on_transfer(acc("mallory.testnet"), U128(1), r#"{"buy":{"id":7}}"#.into());
}

#[test]
fn the_seller_cancels_and_gets_the_goods_back() {
    let mut c = setup();
    list(&mut c, "khang.testnet", 7, "ore", 3, 550);
    as_caller("khang.testnet");
    c.cancel_listing(7);
    assert_eq!(c.get_listing(7).unwrap().status, Status::Cancelled);
    assert_eq!(c.get_open_count(), 0);
    // cancelled listings cannot be bought
    assert_eq!(buy(&mut c, "bruno.hearth.testnet", 7, 1_650), 1_650);
}

#[test]
#[should_panic(expected = "not your listing")]
fn a_stranger_cannot_cancel() {
    let mut c = setup();
    list(&mut c, "khang.testnet", 7, "ore", 3, 550);
    as_caller("mallory.testnet");
    c.cancel_listing(7);
}

#[test]
#[should_panic(expected = "not your listing")]
fn the_game_contract_cancels_only_for_the_real_seller() {
    let mut c = setup();
    list(&mut c, "khang.testnet", 7, "ore", 3, 550);
    as_caller(GAME);
    c.cancel_for(acc("mallory.testnet"), 7);
}

#[test]
#[should_panic(expected = "only the game contract")]
fn only_the_game_contract_cancels_for_someone() {
    let mut c = setup();
    list(&mut c, "khang.testnet", 7, "ore", 3, 550);
    as_caller("mallory.testnet");
    c.cancel_for(acc("khang.testnet"), 7);
}

#[test]
#[should_panic(expected = "listing is not open")]
fn a_sold_listing_cannot_be_cancelled() {
    let mut c = setup();
    list(&mut c, "khang.testnet", 7, "ore", 3, 550);
    buy(&mut c, "bruno.hearth.testnet", 7, 1_650);
    as_caller("khang.testnet");
    c.cancel_listing(7);
}

#[test]
#[should_panic(expected = "nothing to withdraw")]
fn withdraw_with_nothing_owed_fails() {
    let mut c = setup();
    as_caller("mallory.testnet");
    c.withdraw();
}

#[test]
fn a_failed_payout_stays_owed_and_can_be_withdrawn() {
    let mut c = setup();
    list(&mut c, "khang.testnet", 7, "ore", 3, 550);
    buy(&mut c, "bruno.hearth.testnet", 7, 1_650);
    // the gold transfer to the seller failed: the callback restores the debt
    testing_env!(
        VMContextBuilder::new().current_account_id(acc("stalls.hearth.testnet")).predecessor_account_id(acc("stalls.hearth.testnet")).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed],
    );
    c.on_gold_paid(acc("khang.testnet"), U128(1_650));
    c.on_items_paid(acc("bruno.hearth.testnet"), "ore".into(), U128(3));
    assert_eq!(c.owed_to(acc("khang.testnet")).gold.0, 1_650);
    assert_eq!(c.owed_to(acc("bruno.hearth.testnet")).items, vec![("ore".to_string(), U128(3))]);
    // anyone can push the payout, and it goes to the owner only
    as_caller("mallory.testnet");
    c.withdraw_for(acc("khang.testnet"));
    assert_eq!(c.owed_to(acc("khang.testnet")).gold.0, 0);
    as_caller("bruno.hearth.testnet");
    c.withdraw();
    assert!(c.owed_to(acc("bruno.hearth.testnet")).items.is_empty());
}

#[test]
fn a_successful_payout_callback_changes_nothing() {
    let mut c = setup();
    testing_env!(
        VMContextBuilder::new().current_account_id(acc("stalls.hearth.testnet")).predecessor_account_id(acc("stalls.hearth.testnet")).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(vec![])],
    );
    c.on_gold_paid(acc("khang.testnet"), U128(1_650));
    assert_eq!(c.owed_to(acc("khang.testnet")).gold.0, 0);
}

#[test]
fn open_listings_view() {
    let mut c = setup();
    list(&mut c, "khang.testnet", 1, "ore", 1, 500);
    list(&mut c, "khang.testnet", 2, "wheat", 4, 210);
    buy(&mut c, "bruno.hearth.testnet", 1, 500);
    let open = c.get_open_listings(None, None);
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].id, 2);
}
