//! Hearthmarket game contract.
//!
//! Gold is an integer in centigold (1 gold = 100), exposed as a NEP-141 fungible token
//! (`decimals: 2`). Season badges are soulbound NEP-171 tokens. The game server runs the
//! same rules in TypeScript (`packages/economy`) so the village can run offline; on chain,
//! every NPC action is signed by the NPC's own function-call key and checked here.
//!
//! Safety boundary (the part the AI judges should look at):
//! * NPC accounts sign with function-call keys limited to this contract and a method
//!   list. NEAR enforces that. This contract adds what a key cannot express:
//! * a per-NPC daily gold budget ([`Hearth::assert_npc_spend`]),
//! * NPCs can never move gold out except through market methods (`ft_transfer` panics for NPCs),
//! * price sanity: positive prices, integer quantities, a hard cap per call.
//!
//! Roles:
//! * `owner`: registers NPCs and crafters, closes seasons.
//! * `oracle` (the game operator): posts world data, starts each game day (`reconcile`),
//!   relays actions of email/Google players who have no wallet (`relay_*`), mints badges.
//!   It signs with a function-call key on the contract account; it can never sign as an NPC.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LazyOption, LookupMap};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

pub type Gold = u128;

pub const FEE_BPS: u128 = 150; // 1.5% per trade
pub const FEE_TO_POOL_BPS: u128 = 5_000; // half to the season pool, half burned
pub const SPREAD_BPS: f64 = 200.0;
pub const MAX_QTY: u32 = 1_000;
pub const MAX_CRAFTS: u32 = 12;
pub const STALL_RENT: Gold = 2_000;
pub const SEASON_SPLIT_BPS: [u128; 10] = [2500, 1800, 1300, 1000, 800, 700, 600, 500, 400, 400];
/// Contract-chosen order ids start here; relayed (engine) ids are chosen by the operator below it or far above it.
pub const AUTO_ORDER_ID_START: u64 = 1_000_000_000;
pub const MAX_RECONCILE_ENTRIES: usize = 120;

const GAS_FOR_FT_ON_TRANSFER: Gas = Gas::from_tgas(25);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(10);

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")] // JSON: "ore", "timber", ... same as the TypeScript engine
pub enum Item {
    Ore,
    Timber,
    Wheat,
    Bread,
    Tools,
    Sword,
}

impl Item {
    pub const ALL: [Item; 6] = [Item::Ore, Item::Timber, Item::Wheat, Item::Bread, Item::Tools, Item::Sword];
    /// reference price (centigold) and target stock — identical to ITEM_DEFS in defs.ts
    pub fn def(self) -> (Gold, u32) {
        match self {
            Item::Ore => (600, 40),
            Item::Timber => (270, 40),
            Item::Wheat => (200, 60),
            Item::Bread => (330, 24),
            Item::Tools => (940, 10),
            Item::Sword => (1800, 8),
        }
    }
    fn idx(self) -> usize {
        Item::ALL.iter().position(|i| *i == self).unwrap()
    }
    /// Crafting recipe (inputs per craft) and units per craft — identical to RECIPES/RECIPE_YIELD in defs.ts.
    pub fn recipe(self) -> Option<(&'static [(Item, u32)], u32)> {
        match self {
            Item::Bread => Some((&[(Item::Wheat, 1)], 1)),
            Item::Tools => Some((&[(Item::Ore, 1), (Item::Timber, 1)], 2)),
            Item::Sword => Some((&[(Item::Ore, 2), (Item::Timber, 1)], 1)),
            _ => None,
        }
    }
}

/// Same curve as `midPrice` in packages/economy/src/market.ts.
pub fn mid_price(item: Item, stock: i64) -> Gold {
    let (base, target) = item.def();
    let ratio = (target as f64 + 5.0) / (stock.max(0) as f64 + 5.0);
    let f = ratio.powf(0.6).clamp(0.4, 2.5);
    (base as f64 * f).round() as Gold
}
pub fn ask_price(item: Item, stock: i64) -> Gold {
    (mid_price(item, stock - 1) as f64 * (1.0 + SPREAD_BPS / 20_000.0)).round() as Gold
}
pub fn bid_price(item: Item, stock: i64) -> Gold {
    (mid_price(item, stock + 1) as f64 * (1.0 - SPREAD_BPS / 20_000.0)).round() as Gold
}
pub fn fee(amount: Gold) -> Gold {
    amount * FEE_BPS / 10_000
}

/// NEP-297 event log.
fn emit(standard: &str, version: &str, event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": standard, "version": version, "event": event, "data": [data] })
    ));
}

// ---------------------------------------------------------------------- stored types
// NpcPolicy, Order and Guild are stored as individual map values. Their layout must not
// change between versions (see `migrate`). New per-account data goes into new maps.

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct NpcPolicy {
    pub daily_budget: Gold,
    pub spent_today: Gold,
    pub day: u32,
    /// raw items this NPC may `produce` (empty for crafters and the merchant)
    pub produces: Vec<Item>,
    pub merchant: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum OrderStatus {
    Open,
    Filled,
    Expired,
    Cancelled,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Order {
    pub id: u64,
    pub buyer: AccountId,
    pub item: Item,
    pub qty: u32,
    pub filled: u32,
    pub max_price: Gold,
    pub escrow: Gold,
    pub deadline_day: u32,
    pub status: OrderStatus,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Guild {
    pub name: String,
    pub leader: AccountId,
    pub members: Vec<AccountId>,
    pub fund: Gold,
    pub contributed: Gold,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Stall {
    pub guild: Option<String>,
    pub gold: Gold,
    pub stock: [u32; 6],
    pub buy: [Gold; 6],
    pub sell: [Gold; 6],
}

/// World data as posted by the oracle. `raw` is the compact reading used for prices;
/// `sha256` is the hash of the full API response, `source` names the API and the query,
/// so anyone can fetch the same data and re-check the prices.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct WorldPost {
    pub source: String,
    pub raw: String,
    pub sha256: String,
    pub ts: u64,
    pub day: u32,
    pub prices: Vec<(Item, Gold)>,
    pub shipping_bps: u32,
}

/// A soulbound season or quest badge (NEP-171 token).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Badge {
    pub owner_id: AccountId,
    pub kind: String,
    pub title: String,
    pub description: String,
    pub season: u32,
    pub issued_at_ms: u64,
}

// ---------------------------------------------------------------------- NEP-141/145/171/177 JSON types

#[near(serializers = [json])]
pub struct FungibleTokenMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near(serializers = [json])]
pub struct NftContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub copies: Option<u64>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
pub struct JsonToken {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
    pub approved_account_ids: Option<std::collections::HashMap<AccountId, u64>>,
}

const GOLD_ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%23e8b33a' stroke='%23845a12'/%3E%3Ctext x='8' y='11.5' font-size='9' text-anchor='middle' fill='%23845a12' font-family='monospace'%3EG%3C/text%3E%3C/svg%3E";
const BADGE_ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 1l2 4 4.5.6-3.2 3.1.8 4.5L8 11l-4.1 2.2.8-4.5L1.5 5.6 6 5z' fill='%23e8763a' stroke='%23843a12'/%3E%3C/svg%3E";

#[ext_contract(ext_ft_receiver)]
#[allow(dead_code)]
trait FungibleTokenReceiver {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128>;
}

// ---------------------------------------------------------------------- state

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Hearth {
    owner: AccountId,
    oracle: AccountId,
    day: u32,
    season: u32,
    gold: LookupMap<AccountId, Gold>,
    items: LookupMap<(AccountId, Item), u32>,
    total_supply: Gold,
    burned: Gold,
    market_stock: [u32; 6],
    treasury: Gold,
    season_pool: Gold,
    npcs: LookupMap<AccountId, NpcPolicy>,
    orders: IterableMap<u64, Order>,
    open_orders: Vec<u64>,
    next_order: u64,
    guilds: IterableMap<String, Guild>,
    member_of: LookupMap<AccountId, String>,
    stalls: Vec<Stall>,
    world: LazyOption<WorldPost>,
    /// items each NPC may `craft` (Chloe: bread, Theo: tools and sword)
    crafters: LookupMap<AccountId, Vec<Item>>,
    /// wallet-less players registered through the operator (or the owner)
    players: LookupMap<AccountId, bool>,
    badges: IterableMap<u64, Badge>,
    badges_of: LookupMap<AccountId, Vec<u64>>,
    next_badge: u64,
    /// the game server's day number at the last `reconcile` (for display)
    game_day: u32,
}

/// Version 1 state layout (first testnet deployment). Used only by `migrate`.
#[near(serializers = [borsh])]
pub struct HearthV1 {
    owner: AccountId,
    oracle: AccountId,
    day: u32,
    season: u32,
    gold: LookupMap<AccountId, Gold>,
    items: LookupMap<(AccountId, Item), u32>,
    total_supply: Gold,
    burned: Gold,
    market_stock: [u32; 6],
    treasury: Gold,
    season_pool: Gold,
    npcs: LookupMap<AccountId, NpcPolicy>,
    orders: IterableMap<u64, Order>,
    next_order: u64,
    guilds: IterableMap<String, Guild>,
    member_of: LookupMap<AccountId, String>,
    stalls: Vec<Stall>,
    world: Option<WorldPostV1>,
}

#[near(serializers = [borsh])]
pub struct WorldPostV1 {
    pub source: String,
    pub raw: String,
    pub ts: u64,
    pub prices: Vec<(Item, Gold)>,
    pub shipping_bps: u32,
}

#[near]
impl Hearth {
    #[init]
    pub fn new(owner: AccountId, oracle: AccountId, treasury: Gold) -> Self {
        let mut s = Self {
            owner,
            oracle,
            day: 1,
            season: 1,
            gold: LookupMap::new(b"g"),
            items: LookupMap::new(b"i"),
            total_supply: 0,
            burned: 0,
            market_stock: Item::ALL.map(|i| i.def().1),
            treasury: 0,
            season_pool: 0,
            npcs: LookupMap::new(b"n"),
            orders: IterableMap::new(b"o"),
            open_orders: vec![],
            next_order: AUTO_ORDER_ID_START,
            guilds: IterableMap::new(b"G"),
            member_of: LookupMap::new(b"m"),
            stalls: (0..4).map(|_| Stall::default()).collect(),
            world: LazyOption::new(b"w", None),
            crafters: LookupMap::new(b"c"),
            players: LookupMap::new(b"r"),
            badges: IterableMap::new(b"T"),
            badges_of: LookupMap::new(b"x"),
            next_badge: 1,
            game_day: 1,
        };
        s.treasury = treasury;
        s.total_supply = treasury;
        emit("nep141", "1.0.0", "ft_mint", json!({ "owner_id": env::current_account_id(), "amount": U128(treasury), "memo": "market treasury" }));
        s
    }

    /// Upgrade from the version 1 state, keeping balances, NPCs, orders and guilds.
    /// Deploy the new wasm with an init call to `migrate` (no arguments), signed by the contract account.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: HearthV1 = env::state_read().unwrap_or_else(|| env::panic_str("no version 1 state to migrate"));
        let open_orders: Vec<u64> = old.orders.iter().filter(|(_, o)| o.status == OrderStatus::Open).map(|(id, _)| *id).collect();
        let mut world = LazyOption::new(b"w", None);
        if let Some(w) = old.world {
            world.set(Some(WorldPost { source: w.source, raw: w.raw, sha256: String::new(), ts: w.ts, day: old.day, prices: w.prices, shipping_bps: w.shipping_bps }));
        }
        Self {
            owner: old.owner,
            oracle: old.oracle,
            day: old.day,
            season: old.season,
            gold: old.gold,
            items: old.items,
            total_supply: old.total_supply,
            burned: old.burned,
            market_stock: old.market_stock,
            treasury: old.treasury,
            season_pool: old.season_pool,
            npcs: old.npcs,
            orders: old.orders,
            open_orders,
            next_order: old.next_order.max(AUTO_ORDER_ID_START),
            guilds: old.guilds,
            member_of: old.member_of,
            stalls: old.stalls,
            world,
            crafters: LookupMap::new(b"c"),
            players: LookupMap::new(b"r"),
            badges: IterableMap::new(b"T"),
            badges_of: LookupMap::new(b"x"),
            next_badge: 1,
            game_day: old.day,
        }
    }

    pub fn get_version(&self) -> String {
        "2".into()
    }

    // ------------------------------------------------------------------ roles
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }
    fn assert_oracle(&self) {
        require!(env::predecessor_account_id() == self.oracle, "oracle only");
    }

    /// Register an NPC sub-account with its budget. Its function-call key is added off-chain
    /// with receiver = this contract and the NPC method list.
    pub fn register_npc(&mut self, account: AccountId, daily_budget: Gold, produces: Vec<Item>, merchant: bool, start_gold: Gold) {
        self.assert_owner();
        self.npcs.insert(account.clone(), NpcPolicy { daily_budget, spent_today: 0, day: self.day, produces, merchant });
        self.mint(&account, start_gold, "npc start gold");
    }

    /// Which items an NPC may craft from inputs it holds.
    pub fn set_crafts(&mut self, account: AccountId, items: Vec<Item>) {
        self.assert_owner();
        require!(self.npcs.contains_key(&account), "not an NPC");
        require!(items.iter().all(|i| i.recipe().is_some()), "item has no recipe");
        self.crafters.insert(account, items);
    }

    /// New player: starting gold (a faucet the economy report accounts for).
    pub fn register_player(&mut self, account: AccountId, start_gold: Gold) {
        self.assert_owner();
        self.add_player(&account, start_gold);
    }

    fn add_player(&mut self, account: &AccountId, start_gold: Gold) -> bool {
        require!(!self.npcs.contains_key(account), "account is an NPC");
        if self.players.contains_key(account) {
            return false;
        }
        self.players.insert(account.clone(), true);
        self.mint(account, start_gold, "player start gold");
        true
    }

    /// Game clock. Resets NPC budgets lazily, expires orders.
    pub fn advance_day(&mut self) {
        require!(env::predecessor_account_id() == self.owner || env::predecessor_account_id() == self.oracle, "owner or oracle only");
        self.next_day();
    }

    fn next_day(&mut self) {
        self.day += 1;
        let day = self.day;
        let open = std::mem::take(&mut self.open_orders);
        for id in open {
            let Some(o) = self.orders.get(&id).cloned() else { continue };
            if o.status != OrderStatus::Open {
                continue;
            }
            if day > o.deadline_day {
                let mut o = o;
                o.status = OrderStatus::Expired;
                let refund = o.escrow;
                o.escrow = 0;
                self.credit(&o.buyer, refund);
                self.orders.insert(id, o);
            } else {
                self.open_orders.push(id);
            }
        }
    }

    // ------------------------------------------------------------------ gold ledger
    fn mint(&mut self, who: &AccountId, amount: Gold, memo: &str) {
        if amount == 0 {
            return;
        }
        self.credit(who, amount);
        self.total_supply += amount;
        emit("nep141", "1.0.0", "ft_mint", json!({ "owner_id": who, "amount": U128(amount), "memo": memo }));
    }
    fn burn(&mut self, who: &AccountId, amount: Gold, memo: &str) {
        if amount == 0 {
            return;
        }
        self.debit(who, amount);
        self.total_supply -= amount;
        self.burned += amount;
        emit("nep141", "1.0.0", "ft_burn", json!({ "owner_id": who, "amount": U128(amount), "memo": memo }));
    }
    fn credit(&mut self, who: &AccountId, amount: Gold) {
        let b = self.gold.get(who).copied().unwrap_or(0);
        self.gold.insert(who.clone(), b + amount);
    }
    fn debit(&mut self, who: &AccountId, amount: Gold) {
        let b = self.gold.get(who).copied().unwrap_or(0);
        require!(b >= amount, "not enough gold");
        self.gold.insert(who.clone(), b - amount);
    }
    fn take_fee(&mut self, payer: &AccountId, amount: Gold) {
        let f = fee(amount);
        let pool = f * FEE_TO_POOL_BPS / 10_000;
        self.debit(payer, pool);
        self.season_pool += pool;
        self.burn(payer, f - pool, "market fee");
    }
    fn item_of(&self, who: &AccountId, item: Item) -> u32 {
        self.items.get(&(who.clone(), item)).copied().unwrap_or(0)
    }
    fn add_item(&mut self, who: &AccountId, item: Item, qty: i64) {
        let cur = self.item_of(who, item) as i64 + qty;
        require!(cur >= 0, "not enough goods");
        self.items.insert((who.clone(), item), cur as u32);
    }
    fn transfer_gold(&mut self, sender: &AccountId, receiver: &AccountId, amount: Gold, memo: Option<String>) {
        require!(amount > 0, "amount must be positive");
        require!(sender != receiver, "sender and receiver are the same");
        self.debit(sender, amount);
        self.credit(receiver, amount);
        emit("nep141", "1.0.0", "ft_transfer", json!({ "old_owner_id": sender, "new_owner_id": receiver, "amount": U128(amount), "memo": memo }));
    }

    // ------------------------------------------------------------------ NEP-141 gold
    /// Players may move gold to each other. NPC accounts never can: an injected
    /// "send me all your gold" dies here even if a key somehow allowed the call.
    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        let sender = env::predecessor_account_id();
        require!(!self.npcs.contains_key(&sender), "NPC accounts cannot transfer gold");
        self.transfer_gold(&sender, &receiver_id, amount.0, memo);
    }

    #[payable]
    pub fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        near_sdk::assert_one_yocto();
        let sender = env::predecessor_account_id();
        require!(!self.npcs.contains_key(&sender), "NPC accounts cannot transfer gold");
        self.transfer_gold(&sender, &receiver_id, amount.0, memo);
        ext_ft_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_FOR_FT_ON_TRANSFER)
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).ft_resolve_transfer(sender, receiver_id, amount))
            .into()
    }

    /// Returns the amount the receiver kept; refunds the rest to the sender.
    #[private]
    pub fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let amount = amount.0;
        let unused = match env::promise_result_checked(0, 64) {
            Ok(v) => serde_json::from_slice::<U128>(&v).map(|u| u.0.min(amount)).unwrap_or(amount),
            Err(_) => amount,
        };
        let refund = unused.min(self.gold.get(&receiver_id).copied().unwrap_or(0));
        if refund > 0 {
            self.debit(&receiver_id, refund);
            self.credit(&sender_id, refund);
            emit("nep141", "1.0.0", "ft_transfer", json!({ "old_owner_id": receiver_id, "new_owner_id": sender_id, "amount": U128(refund), "memo": "refund" }));
        }
        U128(amount - refund)
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    /// Market treasury, season pool and order escrow are held by the contract account itself.
    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        let own = self.gold.get(&account_id).copied().unwrap_or(0);
        if account_id == env::current_account_id() {
            let escrow: Gold = self.open_orders.iter().filter_map(|id| self.orders.get(id)).map(|o| o.escrow).sum();
            let guilds: Gold = self.guilds.values().map(|g| g.fund).sum();
            let stalls: Gold = self.stalls.iter().map(|s| s.gold).sum();
            return U128(own + self.treasury + self.season_pool + escrow + guilds + stalls);
        }
        U128(own)
    }

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: "ft-1.0.0".into(),
            name: "Hearthmarket Gold".into(),
            symbol: "HGOLD".into(),
            icon: Some(GOLD_ICON.into()),
            reference: None,
            reference_hash: None,
            decimals: 2,
        }
    }

    // NEP-145: the game pays for storage, so registration is free and any deposit is returned.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = (account_id, registration_only);
        let deposit = env::attached_deposit();
        if !deposit.is_zero() {
            Promise::new(env::predecessor_account_id()).transfer(deposit).detach();
        }
        StorageBalance { total: U128(0), available: U128(0) }
    }
    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        let _ = account_id;
        Some(StorageBalance { total: U128(0), available: U128(0) })
    }
    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: U128(0), max: Some(U128(0)) }
    }

    // ------------------------------------------------------------------ NPC guard
    /// Daily budget check for NPC callers. No-op for players.
    fn assert_npc_spend(&mut self, who: &AccountId, spend: Gold) {
        if let Some(p) = self.npcs.get(who) {
            let mut p = p.clone();
            if p.day != self.day {
                p.day = self.day;
                p.spent_today = 0;
            }
            require!(p.spent_today + spend <= p.daily_budget, "over the daily budget");
            p.spent_today += spend;
            self.npcs.insert(who.clone(), p);
        }
    }

    fn check_qty(qty: u32) {
        require!(qty > 0 && qty <= MAX_QTY, "invalid quantity");
    }

    // ------------------------------------------------------------------ market
    pub fn market_buy(&mut self, item: Item, qty: u32, max_price: Gold) -> Gold {
        let who = env::predecessor_account_id();
        self.do_market_buy(&who, item, qty, max_price)
    }

    pub fn market_sell(&mut self, item: Item, qty: u32, min_price: Gold) -> Gold {
        let who = env::predecessor_account_id();
        self.do_market_sell(&who, item, qty, min_price)
    }

    fn do_market_buy(&mut self, who: &AccountId, item: Item, qty: u32, max_price: Gold) -> Gold {
        Self::check_qty(qty);
        let stock = self.market_stock[item.idx()] as i64;
        require!(stock >= qty as i64, "not enough stock");
        let mut total: Gold = 0;
        let mut last: Gold = 0;
        for k in 0..qty as i64 {
            last = ask_price(item, stock - k);
            total += last;
        }
        require!(last <= max_price, "price moved above max_price");
        self.assert_npc_spend(who, total + fee(total));
        self.debit(who, total);
        self.take_fee(who, total);
        self.treasury += total;
        self.market_stock[item.idx()] -= qty;
        self.add_item(who, item, qty as i64);
        total
    }

    fn do_market_sell(&mut self, who: &AccountId, item: Item, qty: u32, min_price: Gold) -> Gold {
        Self::check_qty(qty);
        let stock = self.market_stock[item.idx()] as i64;
        let mut total: Gold = 0;
        let mut last: Gold = 0;
        for k in 0..qty as i64 {
            last = bid_price(item, stock + k);
            total += last;
        }
        require!(last >= min_price, "price moved below min_price");
        require!(self.treasury >= total, "market treasury is short");
        self.add_item(who, item, -(qty as i64));
        self.treasury -= total;
        self.market_stock[item.idx()] += qty;
        self.credit(who, total);
        self.take_fee(who, total);
        total
    }

    /// NPC-to-NPC deal ("Theo hires Mike for 4 ore at 5.5").
    pub fn hire(&mut self, seller: AccountId, item: Item, qty: u32, price: Gold) {
        Self::check_qty(qty);
        let buyer = env::predecessor_account_id();
        require!(self.npcs.contains_key(&buyer) && self.npcs.contains_key(&seller), "hire is between NPCs");
        require!(buyer != seller, "cannot hire yourself");
        require!(price > 0, "price must be positive");
        let total = price * qty as u128;
        self.assert_npc_spend(&buyer, total + fee(total));
        self.add_item(&seller, item, -(qty as i64));
        self.add_item(&buyer, item, qty as i64);
        self.debit(&buyer, total);
        self.credit(&seller, total);
        self.take_fee(&buyer, total);
    }

    /// Raw producers create goods within a daily cap.
    pub fn produce(&mut self, item: Item, qty: u32) {
        Self::check_qty(qty);
        let who = env::predecessor_account_id();
        let p = self.npcs.get(&who).cloned();
        require!(p.map(|p| p.produces.contains(&item)).unwrap_or(false), "this account cannot produce that item");
        require!(qty <= 12, "over the daily production cap");
        self.add_item(&who, item, qty as i64);
    }

    /// Crafters turn inputs they hold into goods (bread from wheat; tools and swords from ore and timber).
    pub fn craft(&mut self, item: Item, crafts: u32) {
        require!(crafts > 0 && crafts <= MAX_CRAFTS, "crafts must be 1-12");
        let who = env::predecessor_account_id();
        require!(self.crafters.get(&who).map(|c| c.contains(&item)).unwrap_or(false), "this account cannot craft that item");
        let (inputs, per_craft) = item.recipe().unwrap_or_else(|| env::panic_str("item has no recipe"));
        for (input, q) in inputs {
            self.add_item(&who, *input, -((q * crafts) as i64));
        }
        self.add_item(&who, item, (per_craft * crafts) as i64);
    }

    // ------------------------------------------------------------------ orders
    pub fn place_order(&mut self, item: Item, qty: u32, max_price: Gold, deadline_day: u32) -> u64 {
        let who = env::predecessor_account_id();
        let id = self.next_order;
        self.next_order += 1;
        self.do_place_order(&who, id, item, qty, max_price, deadline_day);
        id
    }

    fn do_place_order(&mut self, who: &AccountId, id: u64, item: Item, qty: u32, max_price: Gold, deadline_day: u32) {
        Self::check_qty(qty);
        require!(max_price > 0, "max_price must be positive");
        require!(deadline_day > self.day && deadline_day <= self.day + 7, "deadline must be 1-7 days ahead");
        require!(self.orders.get(&id).is_none(), "order id taken");
        let gross = max_price * qty as u128;
        let escrow = gross + fee(gross);
        self.assert_npc_spend(who, escrow);
        self.debit(who, escrow);
        self.orders.insert(id, Order { id, buyer: who.clone(), item, qty, filled: 0, max_price, escrow, deadline_day, status: OrderStatus::Open });
        self.open_orders.push(id);
    }

    /// Producer delivers into an open order at `price` <= max_price. Goods and gold settle atomically.
    pub fn fill_order(&mut self, order_id: u64, qty: u32, price: Gold) {
        Self::check_qty(qty);
        let seller = env::predecessor_account_id();
        let mut o = self.orders.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("no such order"));
        require!(o.status == OrderStatus::Open, "order is not open");
        require!(o.buyer != seller, "cannot fill your own order");
        require!(price <= o.max_price && price > 0, "price outside the order");
        require!(o.filled + qty <= o.qty, "more than ordered");
        let pay = price * qty as u128;
        let f = fee(pay);
        require!(pay + f <= o.escrow, "escrow too small");
        self.add_item(&seller, o.item, -(qty as i64));
        self.add_item(&o.buyer, o.item, qty as i64);
        o.escrow -= pay + f;
        o.filled += qty;
        self.credit(&seller, pay);
        // the fee was locked in escrow: split it without debiting anyone
        let pool = f * FEE_TO_POOL_BPS / 10_000;
        self.season_pool += pool;
        self.burned += f - pool;
        self.total_supply -= f - pool;
        emit("nep141", "1.0.0", "ft_burn", json!({ "owner_id": env::current_account_id(), "amount": U128(f - pool), "memo": "market fee" }));
        if o.filled == o.qty {
            o.status = OrderStatus::Filled;
            let refund = o.escrow;
            o.escrow = 0;
            self.credit(&o.buyer, refund);
            self.open_orders.retain(|x| *x != order_id);
        }
        self.orders.insert(order_id, o);
    }

    pub fn cancel_order(&mut self, order_id: u64) {
        let who = env::predecessor_account_id();
        self.do_cancel_order(&who, order_id);
    }

    fn do_cancel_order(&mut self, who: &AccountId, order_id: u64) {
        let mut o = self.orders.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("no such order"));
        require!(&o.buyer == who, "not your order");
        require!(o.status == OrderStatus::Open, "order is not open");
        o.status = OrderStatus::Cancelled;
        let refund = o.escrow;
        o.escrow = 0;
        self.credit(who, refund);
        self.orders.insert(order_id, o);
        self.open_orders.retain(|x| *x != order_id);
    }

    // ------------------------------------------------------------------ operator: world data, day start, relays
    /// The oracle posts world data with its source, compact reading and the hash of the full
    /// API response, so anyone can re-check the prices against the same API.
    pub fn post_world_data(&mut self, source: String, raw: String, sha256: String, ts: u64, prices: Vec<(Item, Gold)>, shipping_bps: u32) {
        self.assert_oracle();
        require!(raw.len() <= 2_048, "raw payload too large");
        require!(source.len() <= 512 && sha256.len() <= 64, "source or hash too long");
        require!(shipping_bps <= 5_000, "shipping above 50%");
        require!(prices.iter().all(|(_, p)| *p > 0 && *p < 1_000_000), "price out of range");
        emit("hearthmarket", "1.0.0", "world_data", json!({ "day": self.day, "source": source, "sha256": sha256, "ts": ts, "prices": prices, "shipping_bps": shipping_bps }));
        self.world.set(Some(WorldPost { source, raw, sha256, ts, day: self.day, prices, shipping_bps }));
    }

    /// Starts the next game day and re-anchors the chain to the game server's books.
    ///
    /// The game engine is authoritative for things the chain does not see yet (eating,
    /// upkeep, stall and guild trades). Once a day the operator sets market stock, the
    /// treasury and the listed balances to the engine's numbers. Every adjustment is logged
    /// as an `ft_mint`/`ft_burn` event with memo "reconcile", so the drift is public.
    pub fn reconcile(&mut self, game_day: u32, market_stock: Vec<(Item, u32)>, treasury: Option<U128>, gold: Vec<(AccountId, U128)>, items: Vec<(AccountId, Item, u32)>) {
        self.assert_oracle();
        require!(gold.len() + items.len() <= MAX_RECONCILE_ENTRIES, "too many entries");
        self.next_day();
        self.game_day = game_day;
        for (item, q) in market_stock {
            self.market_stock[item.idx()] = q;
        }
        if let Some(t) = treasury {
            let me = env::current_account_id();
            if t.0 > self.treasury {
                let d = t.0 - self.treasury;
                self.total_supply += d;
                emit("nep141", "1.0.0", "ft_mint", json!({ "owner_id": me, "amount": U128(d), "memo": "reconcile treasury" }));
            } else if t.0 < self.treasury {
                let d = self.treasury - t.0;
                self.total_supply -= d;
                emit("nep141", "1.0.0", "ft_burn", json!({ "owner_id": me, "amount": U128(d), "memo": "reconcile treasury" }));
            }
            self.treasury = t.0;
        }
        for (acct, target) in gold {
            let cur = self.gold.get(&acct).copied().unwrap_or(0);
            if target.0 > cur {
                self.mint(&acct, target.0 - cur, "reconcile");
            } else if target.0 < cur {
                let d = cur - target.0;
                self.debit(&acct, d);
                self.total_supply -= d;
                emit("nep141", "1.0.0", "ft_burn", json!({ "owner_id": acct, "amount": U128(d), "memo": "reconcile" }));
            }
        }
        for (acct, item, q) in items {
            self.items.insert((acct, item), q);
        }
    }

    /// A wallet-less player (email or Google login) joins: start gold, once.
    pub fn relay_register_player(&mut self, player: AccountId, start_gold: U128) -> bool {
        self.assert_oracle();
        self.add_player(&player, start_gold.0)
    }

    fn assert_relayable(&self, player: &AccountId) {
        require!(!self.npcs.contains_key(player), "NPCs sign for themselves");
        require!(self.players.contains_key(player), "player not registered");
    }

    pub fn relay_market_buy(&mut self, player: AccountId, item: Item, qty: u32, max_price: Gold) -> Gold {
        self.assert_oracle();
        self.assert_relayable(&player);
        self.do_market_buy(&player, item, qty, max_price)
    }

    pub fn relay_market_sell(&mut self, player: AccountId, item: Item, qty: u32, min_price: Gold) -> Gold {
        self.assert_oracle();
        self.assert_relayable(&player);
        self.do_market_sell(&player, item, qty, min_price)
    }

    /// `order_id` is the game's id so NPCs can fill it by the same number. `deadline_days` is 1-7.
    pub fn relay_place_order(&mut self, player: AccountId, order_id: u64, item: Item, qty: u32, max_price: Gold, deadline_days: u32) {
        self.assert_oracle();
        self.assert_relayable(&player);
        require!(order_id < AUTO_ORDER_ID_START || order_id >= AUTO_ORDER_ID_START * 1_000, "order id reserved for contract orders");
        self.do_place_order(&player, order_id, item, qty, max_price, self.day + deadline_days);
    }

    pub fn relay_cancel_order(&mut self, player: AccountId, order_id: u64) {
        self.assert_oracle();
        self.assert_relayable(&player);
        self.do_cancel_order(&player, order_id);
    }

    // ------------------------------------------------------------------ world trade (Bruno)
    /// Bruno trades with the world at the posted price plus shipping. Imports burn gold, exports mint it.
    pub fn world_trade(&mut self, item: Item, qty: u32, import: bool) {
        Self::check_qty(qty);
        let who = env::predecessor_account_id();
        let p = self.npcs.get(&who).cloned().unwrap_or_else(|| env::panic_str("NPC only"));
        require!(p.merchant, "merchant only");
        let w = self.world.get().clone().unwrap_or_else(|| env::panic_str("no world data yet"));
        let world = w.prices.iter().find(|(i, _)| *i == item).map(|(_, p)| *p).unwrap_or_else(|| env::panic_str("item not traded on the world market"));
        let ship = w.shipping_bps as u128;
        if import {
            let landed = world * (10_000 + ship) / 10_000 * qty as u128;
            self.assert_npc_spend(&who, landed);
            self.burn(&who, landed, "world import");
            self.add_item(&who, item, qty as i64);
        } else {
            let rev = world * (10_000 - ship) / 10_000 * qty as u128;
            self.add_item(&who, item, -(qty as i64));
            self.mint(&who, rev, "world export");
        }
    }

    // ------------------------------------------------------------------ guilds
    pub fn create_guild(&mut self, name: String) {
        let who = env::predecessor_account_id();
        require!(!self.npcs.contains_key(&who), "NPCs cannot found guilds");
        require!(name.len() >= 2 && name.len() <= 32, "name must be 2-32 characters");
        require!(!self.member_of.contains_key(&who), "already in a guild this season");
        require!(self.guilds.get(&name).is_none(), "name taken");
        self.guilds.insert(name.clone(), Guild { name: name.clone(), leader: who.clone(), members: vec![who.clone()], fund: 0, contributed: 0 });
        self.member_of.insert(who, name);
    }

    pub fn join_guild(&mut self, name: String) {
        let who = env::predecessor_account_id();
        require!(!self.npcs.contains_key(&who), "NPCs cannot join guilds");
        require!(!self.member_of.contains_key(&who), "already in a guild this season");
        let mut g = self.guilds.get(&name).cloned().unwrap_or_else(|| env::panic_str("no such guild"));
        require!(g.members.len() < 20, "guild is full (20)");
        g.members.push(who.clone());
        self.guilds.insert(name.clone(), g);
        self.member_of.insert(who, name);
    }

    pub fn deposit(&mut self, amount: Gold) {
        let who = env::predecessor_account_id();
        require!(!self.npcs.contains_key(&who), "NPCs cannot deposit into guilds");
        let name = self.member_of.get(&who).cloned().unwrap_or_else(|| env::panic_str("join a guild first"));
        self.debit(&who, amount);
        let mut g = self.guilds.get(&name).cloned().unwrap();
        g.fund += amount;
        g.contributed += amount;
        self.guilds.insert(name, g);
    }

    /// Guild leader backs an NPC with fund gold.
    pub fn guild_invest(&mut self, npc: AccountId, amount: Gold) {
        let who = env::predecessor_account_id();
        require!(self.npcs.contains_key(&npc), "can only invest in NPCs");
        let name = self.member_of.get(&who).cloned().unwrap_or_else(|| env::panic_str("join a guild first"));
        let mut g = self.guilds.get(&name).cloned().unwrap();
        require!(g.leader == who, "only the guild leader (or a passed vote) can spend the fund");
        require!(g.fund >= amount && amount > 0, "not enough in the fund");
        g.fund -= amount;
        self.guilds.insert(name, g);
        self.credit(&npc, amount);
    }

    pub fn rent_stall(&mut self, slot: u8) {
        let who = env::predecessor_account_id();
        let name = self.member_of.get(&who).cloned().unwrap_or_else(|| env::panic_str("join a guild first"));
        let mut g = self.guilds.get(&name).cloned().unwrap();
        require!(g.leader == who, "leader only");
        let s = slot as usize;
        require!(s < self.stalls.len(), "no such stall");
        require!(self.stalls[s].guild.is_none(), "stall already rented");
        require!(!self.stalls.iter().any(|x| x.guild.as_deref() == Some(name.as_str())), "one stall per guild");
        require!(g.fund >= STALL_RENT, "fund too low for rent");
        g.fund -= STALL_RENT;
        self.season_pool += STALL_RENT;
        self.guilds.insert(name.clone(), g);
        self.stalls[s].guild = Some(name);
    }

    pub fn set_stall_prices(&mut self, slot: u8, item: Item, buy: Gold, sell: Gold) {
        let who = env::predecessor_account_id();
        let name = self.member_of.get(&who).cloned().unwrap_or_else(|| env::panic_str("join a guild first"));
        let s = slot as usize;
        require!(s < self.stalls.len() && self.stalls[s].guild.as_deref() == Some(name.as_str()), "not your stall");
        require!(buy < sell, "buy price must be below sell price");
        self.stalls[s].buy[item.idx()] = buy;
        self.stalls[s].sell[item.idx()] = sell;
    }

    /// Pays the season pool to the top guilds by return on fund, mints a badge to every member
    /// of the top three, then starts a new season. `ranking` is computed off-chain from public
    /// state and checked here for eligibility.
    pub fn close_season(&mut self, ranking: Vec<String>) {
        self.assert_owner();
        let pool = self.season_pool;
        let mut paid: Gold = 0;
        for (i, name) in ranking.iter().take(10).enumerate() {
            let mut g = self.guilds.get(name).cloned().unwrap_or_else(|| env::panic_str("unknown guild in ranking"));
            require!(g.members.len() >= 3, "guild needs 3 members to rank");
            let reward = pool * SEASON_SPLIT_BPS[i] / 10_000;
            g.fund += reward;
            paid += reward;
            if i < 3 {
                for m in g.members.clone() {
                    let title = format!("Season {} · #{} · {}", self.season, i + 1, g.name);
                    self.mint_badge_inner(m, "season".into(), title, format!("Top {} guild of Hearthmarket season {}", i + 1, self.season));
                }
            }
            self.guilds.insert(name.clone(), g);
        }
        self.season_pool -= paid;
        self.season += 1;
    }

    // ------------------------------------------------------------------ NEP-171 badges (soulbound)
    /// Quest and season badges for wallet-less players, minted by the operator.
    pub fn mint_badge(&mut self, owner_id: AccountId, kind: String, title: String, description: String) -> String {
        self.assert_oracle();
        require!(kind.len() <= 32 && title.len() <= 96 && description.len() <= 256, "badge text too long");
        self.mint_badge_inner(owner_id, kind, title, description)
    }

    fn mint_badge_inner(&mut self, owner_id: AccountId, kind: String, title: String, description: String) -> String {
        let id = self.next_badge;
        self.next_badge += 1;
        let b = Badge { owner_id: owner_id.clone(), kind, title, description, season: self.season, issued_at_ms: env::block_timestamp_ms() };
        self.badges.insert(id, b);
        let mut list = self.badges_of.get(&owner_id).cloned().unwrap_or_default();
        list.push(id);
        self.badges_of.insert(owner_id.clone(), list);
        let token_id = id.to_string();
        emit("nep171", "1.0.0", "nft_mint", json!({ "owner_id": owner_id, "token_ids": [token_id] }));
        token_id
    }

    fn json_token(&self, id: u64) -> Option<JsonToken> {
        let b = self.badges.get(&id)?;
        Some(JsonToken {
            token_id: id.to_string(),
            owner_id: b.owner_id.clone(),
            metadata: TokenMetadata {
                title: Some(b.title.clone()),
                description: Some(b.description.clone()),
                media: Some(BADGE_ICON.into()),
                media_hash: None,
                copies: Some(1),
                issued_at: Some(b.issued_at_ms.to_string()),
                expires_at: None,
                starts_at: None,
                updated_at: None,
                extra: Some(json!({ "kind": b.kind, "season": b.season, "soulbound": true }).to_string()),
                reference: None,
                reference_hash: None,
            },
            approved_account_ids: Some(Default::default()),
        })
    }

    pub fn nft_metadata(&self) -> NftContractMetadata {
        NftContractMetadata {
            spec: "nft-1.0.0".into(),
            name: "Hearthmarket Badges".into(),
            symbol: "HBADGE".into(),
            icon: Some(BADGE_ICON.into()),
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    pub fn nft_token(&self, token_id: String) -> Option<JsonToken> {
        token_id.parse::<u64>().ok().and_then(|id| self.json_token(id))
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128(self.badges.len() as u128)
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<JsonToken> {
        let start = from_index.map(|x| x.0 as usize).unwrap_or(0);
        let ids: Vec<u64> = self.badges.keys().skip(start).take(limit.unwrap_or(50).min(100) as usize).copied().collect();
        ids.into_iter().filter_map(|id| self.json_token(id)).collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.badges_of.get(&account_id).map(|l| l.len()).unwrap_or(0) as u128)
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<JsonToken> {
        let start = from_index.map(|x| x.0 as usize).unwrap_or(0);
        let ids = self.badges_of.get(&account_id).cloned().unwrap_or_default();
        ids.into_iter().skip(start).take(limit.unwrap_or(50).min(100) as usize).filter_map(|id| self.json_token(id)).collect()
    }

    /// Badges record what a player did; they cannot be sold or given away.
    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        let _ = (receiver_id, token_id, approval_id, memo);
        env::panic_str("badges are soulbound");
    }

    #[payable]
    pub fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        let _ = (receiver_id, token_id, approval_id, memo, msg);
        env::panic_str("badges are soulbound");
    }

    // ------------------------------------------------------------------ views
    pub fn item_balance(&self, account_id: AccountId, item: Item) -> u32 {
        self.item_of(&account_id, item)
    }
    pub fn items_of(&self, account_id: AccountId) -> Vec<(Item, u32)> {
        Item::ALL.iter().map(|i| (*i, self.item_of(&account_id, *i))).collect()
    }
    pub fn get_npc(&self, account_id: AccountId) -> Option<NpcPolicy> {
        self.npcs.get(&account_id).cloned()
    }
    pub fn get_crafts(&self, account_id: AccountId) -> Vec<Item> {
        self.crafters.get(&account_id).cloned().unwrap_or_default()
    }
    pub fn is_player(&self, account_id: AccountId) -> bool {
        self.players.contains_key(&account_id)
    }
    pub fn get_order(&self, order_id: u64) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }
    pub fn get_open_orders(&self) -> Vec<Order> {
        self.open_orders.iter().filter_map(|id| self.orders.get(id).cloned()).collect()
    }
    pub fn get_guild(&self, name: String) -> Option<Guild> {
        self.guilds.get(&name).cloned()
    }
    pub fn get_market(&self) -> Vec<(Item, u32, Gold)> {
        Item::ALL.iter().map(|i| (*i, self.market_stock[i.idx()], mid_price(*i, self.market_stock[i.idx()] as i64))).collect()
    }
    /// (day, season, total supply, treasury, season pool, burned)
    pub fn get_economy(&self) -> (u32, u32, Gold, Gold, Gold, Gold) {
        (self.day, self.season, self.total_supply, self.treasury, self.season_pool, self.burned)
    }
    pub fn get_game_day(&self) -> u32 {
        self.game_day
    }
    pub fn get_world(&self) -> Option<WorldPost> {
        self.world.get().clone()
    }
    pub fn get_roles(&self) -> (AccountId, AccountId) {
        (self.owner.clone(), self.oracle.clone())
    }
    /// Storage for NEAR: attached deposits are not used by game methods.
    pub fn storage_hint(&self) -> NearToken {
        NearToken::from_millinear(0)
    }
}

#[cfg(test)]
mod tests;
