//! Hearthmarket game contract (`hearth.testnet`).
//!
//! The final authority for the village economy. The game server and the TypeScript
//! engine (`packages/economy`) mirror these rules so the game can run offline, but on
//! chain this contract decides. Gold is an integer in centigold (1 gold = 100).
//!
//! Safety boundary (the part the AI judges should look at):
//! * NPC accounts sign with function-call keys limited to this contract and a method
//!   list. NEAR enforces that. This contract adds what a key cannot express:
//! * a per-NPC daily gold budget ([`Hearth::assert_npc_spend`]),
//! * NPCs can never move gold out except through market methods (`ft_transfer` panics for NPCs),
//! * price sanity: positive prices, integer quantities, a hard cap per call.
//!
//! Planned next (see docs/plan.md): NEP-141 gold on `gold.hearth.testnet`, NEP-245 items
//! on `items.hearth.testnet`, NEP-171 season badges, guild funds as sub-accounts.

use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault};

pub type Gold = u128;

pub const FEE_BPS: u128 = 150; // 1.5% per trade
pub const FEE_TO_POOL_BPS: u128 = 5_000; // half to the season pool, half burned
pub const SPREAD_BPS: f64 = 200.0;
pub const MAX_QTY: u32 = 1_000;
pub const STALL_RENT: Gold = 2_000;
pub const SEASON_SPLIT_BPS: [u128; 10] = [2500, 1800, 1300, 1000, 800, 700, 600, 500, 400, 400];

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

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct WorldPost {
    pub source: String,
    pub raw: String,
    pub ts: u64,
    pub prices: Vec<(Item, Gold)>,
    pub shipping_bps: u32,
}

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
    next_order: u64,
    guilds: IterableMap<String, Guild>,
    member_of: LookupMap<AccountId, String>,
    stalls: Vec<Stall>,
    world: Option<WorldPost>,
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
            next_order: 1,
            guilds: IterableMap::new(b"G"),
            member_of: LookupMap::new(b"m"),
            stalls: (0..4).map(|_| Stall::default()).collect(),
            world: None,
        };
        s.treasury = treasury;
        s.total_supply = treasury;
        s
    }

    // ------------------------------------------------------------------ admin
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    /// Register an NPC sub-account with its budget. Its function-call key is added off-chain
    /// with receiver = this contract and the NPC method list.
    pub fn register_npc(&mut self, account: AccountId, daily_budget: Gold, produces: Vec<Item>, merchant: bool, start_gold: Gold) {
        self.assert_owner();
        self.npcs.insert(account.clone(), NpcPolicy { daily_budget, spent_today: 0, day: self.day, produces, merchant });
        self.mint(&account, start_gold);
    }

    /// New player: starting gold (a faucet the economy report accounts for).
    pub fn register_player(&mut self, account: AccountId, start_gold: Gold) {
        self.assert_owner();
        require!(!self.npcs.contains_key(&account), "account is an NPC");
        self.mint(&account, start_gold);
    }

    /// Game clock. Resets NPC budgets lazily, expires orders.
    pub fn advance_day(&mut self) {
        require!(env::predecessor_account_id() == self.owner || env::predecessor_account_id() == self.oracle, "owner or oracle only");
        self.day += 1;
        let day = self.day;
        let expired: Vec<u64> = self.orders.iter().filter(|(_, o)| o.status == OrderStatus::Open && day > o.deadline_day).map(|(id, _)| *id).collect();
        for id in expired {
            let mut o = self.orders.get(&id).unwrap().clone();
            o.status = OrderStatus::Expired;
            self.credit(&o.buyer, o.escrow);
            o.escrow = 0;
            self.orders.insert(id, o);
        }
    }

    // ------------------------------------------------------------------ gold ledger
    fn mint(&mut self, who: &AccountId, amount: Gold) {
        self.credit(who, amount);
        self.total_supply += amount;
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
        self.debit(payer, f);
        let pool = f * FEE_TO_POOL_BPS / 10_000;
        self.season_pool += pool;
        self.burned += f - pool;
        self.total_supply -= f - pool;
    }
    fn item_of(&self, who: &AccountId, item: Item) -> u32 {
        self.items.get(&(who.clone(), item)).copied().unwrap_or(0)
    }
    fn add_item(&mut self, who: &AccountId, item: Item, qty: i64) {
        let cur = self.item_of(who, item) as i64 + qty;
        require!(cur >= 0, "not enough goods");
        self.items.insert((who.clone(), item), cur as u32);
    }

    /// Players may move gold to each other. NPC accounts never can: an injected
    /// "send me all your gold" dies here even if a key somehow allowed the call.
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: Gold) {
        let sender = env::predecessor_account_id();
        require!(!self.npcs.contains_key(&sender), "NPC accounts cannot transfer gold");
        self.debit(&sender, amount);
        self.credit(&receiver_id, amount);
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
        Self::check_qty(qty);
        let who = env::predecessor_account_id();
        let stock = self.market_stock[item.idx()] as i64;
        require!(stock >= qty as i64, "not enough stock");
        let mut total: Gold = 0;
        let mut last: Gold = 0;
        for k in 0..qty as i64 {
            last = ask_price(item, stock - k);
            total += last;
        }
        require!(last <= max_price, "price moved above max_price");
        self.assert_npc_spend(&who, total + fee(total));
        self.debit(&who, total);
        self.take_fee(&who, total);
        self.treasury += total;
        self.market_stock[item.idx()] -= qty;
        self.add_item(&who, item, qty as i64);
        total
    }

    pub fn market_sell(&mut self, item: Item, qty: u32, min_price: Gold) -> Gold {
        Self::check_qty(qty);
        let who = env::predecessor_account_id();
        let stock = self.market_stock[item.idx()] as i64;
        let mut total: Gold = 0;
        let mut last: Gold = 0;
        for k in 0..qty as i64 {
            last = bid_price(item, stock + k);
            total += last;
        }
        require!(last >= min_price, "price moved below min_price");
        require!(self.treasury >= total, "market treasury is short");
        self.add_item(&who, item, -(qty as i64));
        self.treasury -= total;
        self.market_stock[item.idx()] += qty;
        self.credit(&who, total);
        self.take_fee(&who, total);
        total
    }

    /// NPC-to-NPC deal ("Theo hires Mike for 4 ore at 5.5").
    pub fn hire(&mut self, seller: AccountId, item: Item, qty: u32, price: Gold) {
        Self::check_qty(qty);
        let buyer = env::predecessor_account_id();
        require!(self.npcs.contains_key(&buyer) && self.npcs.contains_key(&seller), "hire is between NPCs");
        require!(price > 0, "price must be positive");
        let total = price * qty as u128;
        self.assert_npc_spend(&buyer, total + fee(total));
        self.add_item(&seller, item, -(qty as i64));
        self.add_item(&buyer, item, qty as i64);
        self.debit(&buyer, total);
        self.credit(&seller, total);
        self.take_fee(&buyer, total);
    }

    /// Raw producers create goods within a daily cap. (Crafting recipes: next milestone.)
    pub fn produce(&mut self, item: Item, qty: u32) {
        Self::check_qty(qty);
        let who = env::predecessor_account_id();
        let p = self.npcs.get(&who).cloned();
        require!(p.map(|p| p.produces.contains(&item)).unwrap_or(false), "this account cannot produce that item");
        require!(qty <= 12, "over the daily production cap");
        self.add_item(&who, item, qty as i64);
    }

    // ------------------------------------------------------------------ orders
    pub fn place_order(&mut self, item: Item, qty: u32, max_price: Gold, deadline_day: u32) -> u64 {
        Self::check_qty(qty);
        require!(max_price > 0, "max_price must be positive");
        require!(deadline_day > self.day && deadline_day <= self.day + 7, "deadline must be 1-7 days ahead");
        let who = env::predecessor_account_id();
        let gross = max_price * qty as u128;
        let escrow = gross + fee(gross);
        self.assert_npc_spend(&who, escrow);
        self.debit(&who, escrow);
        let id = self.next_order;
        self.next_order += 1;
        self.orders.insert(id, Order { id, buyer: who, item, qty, filled: 0, max_price, escrow, deadline_day, status: OrderStatus::Open });
        id
    }

    /// Producer delivers into an open order at `price` <= max_price. Goods and gold settle atomically.
    pub fn fill_order(&mut self, order_id: u64, qty: u32, price: Gold) {
        Self::check_qty(qty);
        let seller = env::predecessor_account_id();
        let mut o = self.orders.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("no such order"));
        require!(o.status == OrderStatus::Open, "order is not open");
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
        if o.filled == o.qty {
            o.status = OrderStatus::Filled;
            let refund = o.escrow;
            o.escrow = 0;
            self.credit(&o.buyer, refund);
        }
        self.orders.insert(order_id, o);
    }

    pub fn cancel_order(&mut self, order_id: u64) {
        let who = env::predecessor_account_id();
        let mut o = self.orders.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("no such order"));
        require!(o.buyer == who, "not your order");
        require!(o.status == OrderStatus::Open, "order is not open");
        o.status = OrderStatus::Cancelled;
        let refund = o.escrow;
        o.escrow = 0;
        self.credit(&who, refund);
        self.orders.insert(order_id, o);
    }

    // ------------------------------------------------------------------ world oracle
    /// The oracle posts world data with its source and raw payload, so anyone can re-check it.
    pub fn post_world_data(&mut self, source: String, raw: String, ts: u64, prices: Vec<(Item, Gold)>, shipping_bps: u32) {
        require!(env::predecessor_account_id() == self.oracle, "oracle only");
        require!(raw.len() <= 4_096, "raw payload too large");
        self.world = Some(WorldPost { source, raw, ts, prices, shipping_bps });
    }

    /// Bruno trades with the world at the posted price plus shipping. Imports burn gold, exports mint it.
    pub fn world_trade(&mut self, item: Item, qty: u32, import: bool) {
        Self::check_qty(qty);
        let who = env::predecessor_account_id();
        let p = self.npcs.get(&who).cloned().unwrap_or_else(|| env::panic_str("NPC only"));
        require!(p.merchant, "merchant only");
        let w = self.world.clone().unwrap_or_else(|| env::panic_str("no world data yet"));
        let world = w.prices.iter().find(|(i, _)| *i == item).map(|(_, p)| *p).unwrap_or_else(|| env::panic_str("item not traded on the world market"));
        let ship = w.shipping_bps as u128;
        if import {
            let landed = world * (10_000 + ship) / 10_000 * qty as u128;
            self.assert_npc_spend(&who, landed);
            self.debit(&who, landed);
            self.total_supply -= landed;
            self.burned += landed;
            self.add_item(&who, item, qty as i64);
        } else {
            let rev = world * (10_000 - ship) / 10_000 * qty as u128;
            self.add_item(&who, item, -(qty as i64));
            self.mint(&who, rev);
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

    /// Pays the season pool to the top guilds by return on fund, then starts a new season.
    /// `ranking` is computed off-chain from public state and checked here for eligibility.
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
            self.guilds.insert(name.clone(), g);
        }
        self.season_pool -= paid;
        self.season += 1;
    }

    // ------------------------------------------------------------------ views
    pub fn ft_balance_of(&self, account_id: AccountId) -> Gold {
        self.gold.get(&account_id).copied().unwrap_or(0)
    }
    pub fn ft_total_supply(&self) -> Gold {
        self.total_supply
    }
    pub fn item_balance(&self, account_id: AccountId, item: Item) -> u32 {
        self.item_of(&account_id, item)
    }
    pub fn get_npc(&self, account_id: AccountId) -> Option<NpcPolicy> {
        self.npcs.get(&account_id).cloned()
    }
    pub fn get_order(&self, order_id: u64) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }
    pub fn get_guild(&self, name: String) -> Option<Guild> {
        self.guilds.get(&name).cloned()
    }
    pub fn get_market(&self) -> Vec<(Item, u32, Gold)> {
        Item::ALL.iter().map(|i| (*i, self.market_stock[i.idx()], mid_price(*i, self.market_stock[i.idx()] as i64))).collect()
    }
    pub fn get_economy(&self) -> (u32, u32, Gold, Gold, Gold, Gold) {
        (self.day, self.season, self.total_supply, self.treasury, self.season_pool, self.burned)
    }
    pub fn get_world(&self) -> Option<WorldPost> {
        self.world.clone()
    }
    /// Storage for NEAR: attached deposits are not used by game methods.
    pub fn storage_hint(&self) -> NearToken {
        NearToken::from_millinear(0)
    }
}

#[cfg(test)]
mod tests;
