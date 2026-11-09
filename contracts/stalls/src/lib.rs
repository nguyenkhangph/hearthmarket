//! Hearthmarket player stalls.
//!
//! A player lists goods at a fixed price; an NPC (or another player) buys the whole listing.
//! Goods and gold are real tokens of the game contract (`token`): gold is NEP-141, goods are
//! NEP-245. This contract holds them in escrow:
//!
//! * **list**: the game contract moves the seller's goods here with `mt_transfer_call`
//!   (msg `{"list":{"id":7,"price":"550"}}`); `mt_on_transfer` records the listing, or hands
//!   the goods back (returns the amounts) if anything is wrong.
//! * **buy**: the buyer's gold arrives with `ft_transfer_call` (msg `{"buy":{"id":7}}`);
//!   `ft_on_transfer` marks the listing sold, owes the seller the price and the buyer the goods,
//!   pays both out at once, and refunds anything above the price. Short, sold, cancelled,
//!   unknown, or the seller buying their own: the whole amount is refunded.
//! * **cancel**: the seller (or the game contract relaying for a wallet-less seller) cancels
//!   an open listing; the goods are owed back and paid out.
//! * **withdraw**: anything still owed (a payout that failed) can be paid out again, to the
//!   account it is owed to and nowhere else. Anyone may trigger `withdraw_for`.
//!
//! What this contract cannot do: move anything it does not hold, pay anyone but the seller,
//! the buyer or the canceller, or change a listing's price. The operator has no special role
//! here; it only relays through the game contract, which checks its own roles.

use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, PromiseOrValue};

pub const TOKENS: [&str; 6] = ["ore", "timber", "wheat", "bread", "tools", "sword"];
pub const MAX_QTY: u128 = 1_000;
pub const MAX_PRICE: u128 = 1_000_000;
pub const MAX_OPEN_PER_SELLER: u32 = 10;
pub const MAX_OPEN: u32 = 500;

const GAS_TRANSFER: Gas = Gas::from_tgas(8);
const GAS_CALLBACK: Gas = Gas::from_tgas(5);

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Open,
    Sold,
    Cancelled,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Listing {
    pub id: u64,
    pub seller: AccountId,
    pub token_id: String,
    pub qty: U128,
    /// centigold per unit
    pub price: U128,
    pub status: Status,
    pub buyer: Option<AccountId>,
}

#[near(serializers = [json])]
pub struct Owed {
    pub gold: U128,
    pub items: Vec<(String, U128)>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ListMsg {
    list: ListArgs,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ListArgs {
    id: u64,
    price: U128,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct BuyMsg {
    buy: BuyArgs,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct BuyArgs {
    id: u64,
}

#[ext_contract(ext_token)]
#[allow(dead_code)]
trait GameToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>);
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "hearth-stalls", "version": "1.0.0", "event": event, "data": [data] })));
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Stalls {
    /// the game contract: gold (NEP-141) and goods (NEP-245) both live there
    token: AccountId,
    listings: IterableMap<u64, Listing>,
    open_by_seller: LookupMap<AccountId, u32>,
    open: u32,
    gold_owed: LookupMap<AccountId, u128>,
    items_owed: LookupMap<(AccountId, String), u128>,
}

#[near]
impl Stalls {
    #[init]
    pub fn new(token: AccountId) -> Self {
        Self {
            token,
            listings: IterableMap::new(b"l"),
            open_by_seller: LookupMap::new(b"s"),
            open: 0,
            gold_owed: LookupMap::new(b"g"),
            items_owed: LookupMap::new(b"i"),
        }
    }

    pub fn get_version(&self) -> String {
        "1".into()
    }

    fn assert_token(&self) {
        require!(env::predecessor_account_id() == self.token, "only the game contract");
    }

    // ------------------------------------------------------------------ list
    /// NEP-245 receiver: goods arriving with a `list` message become a listing. Returns how
    /// many of each token to give back: 0 when listed, everything when refused.
    pub fn mt_on_transfer(&mut self, sender_id: AccountId, previous_owner_ids: Vec<AccountId>, token_ids: Vec<String>, amounts: Vec<U128>, msg: String) -> PromiseOrValue<Vec<U128>> {
        self.assert_token();
        let refuse = |why: &str, amounts: &Vec<U128>| {
            emit("list_refused", json!({ "sender_id": sender_id, "reason": why }));
            PromiseOrValue::Value(amounts.clone())
        };
        if token_ids.len() != 1 || amounts.len() != 1 || previous_owner_ids.len() != 1 {
            return refuse("one item per listing", &amounts);
        }
        let Ok(m) = serde_json::from_str::<ListMsg>(&msg) else { return refuse("bad message", &amounts) };
        let seller = previous_owner_ids[0].clone();
        let (token_id, qty, price) = (token_ids[0].clone(), amounts[0], m.list.price);
        if !TOKENS.contains(&token_id.as_str()) {
            return refuse("unknown token", &amounts);
        }
        if qty.0 == 0 || qty.0 > MAX_QTY || price.0 == 0 || price.0 > MAX_PRICE {
            return refuse("quantity or price out of range", &amounts);
        }
        if self.listings.contains_key(&m.list.id) {
            return refuse("listing id already used", &amounts);
        }
        let mine = self.open_by_seller.get(&seller).copied().unwrap_or(0);
        if mine >= MAX_OPEN_PER_SELLER || self.open >= MAX_OPEN {
            return refuse("too many open listings", &amounts);
        }
        self.open_by_seller.insert(seller.clone(), mine + 1);
        self.open += 1;
        let l = Listing { id: m.list.id, seller, token_id, qty, price, status: Status::Open, buyer: None };
        emit("listed", json!({ "id": l.id, "seller": l.seller, "token_id": l.token_id, "qty": l.qty, "price": l.price }));
        self.listings.insert(l.id, l);
        PromiseOrValue::Value(vec![U128(0)])
    }

    // ------------------------------------------------------------------ buy
    /// NEP-141 receiver: gold arriving with a `buy` message buys the whole listing. Returns the
    /// gold to refund: the excess on a sale, everything otherwise.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        self.assert_token();
        let refuse = |why: &str| {
            emit("buy_refused", json!({ "buyer": sender_id, "reason": why }));
            PromiseOrValue::Value(amount)
        };
        let Ok(m) = serde_json::from_str::<BuyMsg>(&msg) else { return refuse("bad message") };
        let Some(mut l) = self.listings.get(&m.buy.id).cloned() else { return refuse("no such listing") };
        if l.status != Status::Open {
            return refuse("listing is not open");
        }
        if l.seller == sender_id {
            return refuse("the seller cannot buy their own listing");
        }
        let total = l.price.0 * l.qty.0;
        if amount.0 < total {
            return refuse("not enough gold for the listing");
        }
        l.status = Status::Sold;
        l.buyer = Some(sender_id.clone());
        self.close(&l.seller);
        self.add_gold(&l.seller, total);
        self.add_items(&sender_id, &l.token_id, l.qty.0);
        emit("sold", json!({ "id": l.id, "seller": l.seller, "buyer": sender_id, "token_id": l.token_id, "qty": l.qty, "total": U128(total) }));
        let (seller, buyer) = (l.seller.clone(), sender_id.clone());
        self.listings.insert(l.id, l);
        // pay both sides now; a failed payout stays owed (withdraw)
        self.pay_out(&seller);
        self.pay_out(&buyer);
        PromiseOrValue::Value(U128(amount.0 - total))
    }

    // ------------------------------------------------------------------ cancel
    pub fn cancel_listing(&mut self, listing_id: u64) {
        let who = env::predecessor_account_id();
        self.cancel(&who, listing_id);
    }

    /// The game contract cancels for a wallet-less seller (it checked that its operator relays for them).
    pub fn cancel_for(&mut self, seller: AccountId, listing_id: u64) {
        self.assert_token();
        self.cancel(&seller, listing_id);
    }

    fn cancel(&mut self, seller: &AccountId, listing_id: u64) {
        let mut l = self.listings.get(&listing_id).cloned().unwrap_or_else(|| env::panic_str("no such listing"));
        require!(&l.seller == seller, "not your listing");
        require!(l.status == Status::Open, "listing is not open");
        l.status = Status::Cancelled;
        self.close(seller);
        self.add_items(seller, &l.token_id, l.qty.0);
        emit("cancelled", json!({ "id": l.id, "seller": l.seller }));
        self.listings.insert(l.id, l);
        self.pay_out(seller);
    }

    // ------------------------------------------------------------------ payouts
    pub fn withdraw(&mut self) {
        let who = env::predecessor_account_id();
        require!(self.pay_out(&who), "nothing to withdraw");
    }

    /// Pays out what is owed to `account_id`, to that account only. Anyone may call it.
    pub fn withdraw_for(&mut self, account_id: AccountId) {
        require!(self.pay_out(&account_id), "nothing to withdraw");
    }

    /// Starts transfers for everything owed to `who`; returns false when nothing was owed.
    /// The debt is cleared first and restored by the callback if a transfer fails.
    fn pay_out(&mut self, who: &AccountId) -> bool {
        let mut any = false;
        let gold = self.gold_owed.remove(who).unwrap_or(0);
        if gold > 0 {
            any = true;
            // a promise that is not returned is still scheduled when it is dropped
            let _ = ext_token::ext(self.token.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_TRANSFER)
                .ft_transfer(who.clone(), U128(gold), Some("stall payout".into()))
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_gold_paid(who.clone(), U128(gold)));
        }
        for t in TOKENS {
            let q = self.items_owed.remove(&(who.clone(), t.to_string())).unwrap_or(0);
            if q > 0 {
                any = true;
                let _ = ext_token::ext(self.token.clone())
                    .with_attached_deposit(NearToken::from_yoctonear(1))
                    .with_static_gas(GAS_TRANSFER)
                    .mt_transfer(who.clone(), t.to_string(), U128(q), None, Some("stall payout".into()))
                    .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_items_paid(who.clone(), t.to_string(), U128(q)));
            }
        }
        any
    }

    #[private]
    pub fn on_gold_paid(&mut self, who: AccountId, amount: U128) {
        if env::promise_result_checked(0, 64).is_err() {
            self.add_gold(&who, amount.0);
            emit("payout_failed", json!({ "account_id": who, "gold": amount }));
        }
    }

    #[private]
    pub fn on_items_paid(&mut self, who: AccountId, token_id: String, amount: U128) {
        if env::promise_result_checked(0, 64).is_err() {
            self.add_items(&who, &token_id, amount.0);
            emit("payout_failed", json!({ "account_id": who, "token_id": token_id, "amount": amount }));
        }
    }

    fn add_gold(&mut self, who: &AccountId, amount: u128) {
        let b = self.gold_owed.get(who).copied().unwrap_or(0);
        self.gold_owed.insert(who.clone(), b + amount);
    }

    fn add_items(&mut self, who: &AccountId, token_id: &str, qty: u128) {
        let k = (who.clone(), token_id.to_string());
        let b = self.items_owed.get(&k).copied().unwrap_or(0);
        self.items_owed.insert(k, b + qty);
    }

    fn close(&mut self, seller: &AccountId) {
        let n = self.open_by_seller.get(seller).copied().unwrap_or(1);
        self.open_by_seller.insert(seller.clone(), n.saturating_sub(1));
        self.open = self.open.saturating_sub(1);
    }

    // ------------------------------------------------------------------ views
    pub fn get_token(&self) -> AccountId {
        self.token.clone()
    }

    pub fn get_listing(&self, listing_id: u64) -> Option<Listing> {
        self.listings.get(&listing_id).cloned()
    }

    /// Open listings, oldest first.
    pub fn get_open_listings(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Listing> {
        self.listings
            .values()
            .filter(|l| l.status == Status::Open)
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }

    pub fn get_open_count(&self) -> u32 {
        self.open
    }

    pub fn owed_to(&self, account_id: AccountId) -> Owed {
        Owed {
            gold: U128(self.gold_owed.get(&account_id).copied().unwrap_or(0)),
            items: TOKENS
                .iter()
                .filter_map(|t| self.items_owed.get(&(account_id.clone(), t.to_string())).map(|q| (t.to_string(), U128(*q))))
                .filter(|(_, q)| q.0 > 0)
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests;
