import type { Action } from './types.ts';
import type { Gold } from './money.ts';
import { fmt } from './money.ts';

/**
 * The spending guard. The same rules exist in three places on purpose:
 *  1. here, so the simulation and the client behave like the chain,
 *  2. in the server signer, which refuses to sign anything outside them,
 *  3. in the `hearth` contract, which is the final authority.
 * The LLM only *proposes* actions. It can never widen these rules.
 */

/** Methods an NPC function-call key may call on the hearth contract. */
export const NPC_ALLOWED_METHODS = ['produce', 'market_buy', 'market_sell', 'hire', 'fill_order', 'place_order'] as const;
export type NpcMethod = (typeof NPC_ALLOWED_METHODS)[number];

export const ACTION_METHOD: Record<Action['type'], string> = {
  market_buy: 'market_buy',
  market_sell: 'market_sell',
  place_order: 'place_order',
  cancel_order: 'cancel_order',
  invest: 'guild_invest',
  create_guild: 'create_guild',
  join_guild: 'join_guild',
  deposit: 'deposit',
  rent_stall: 'rent_stall',
  set_stall_prices: 'set_stall_prices',
  propose_vote: 'propose_vote',
  cast_vote: 'cast_vote',
  hire: 'hire',
  fill_order: 'fill_order',
  produce: 'produce',
  transfer: 'ft_transfer',
  call: 'call',
};

export const methodOf = (a: Action): string => (a.type === 'call' ? a.method : ACTION_METHOD[a.type] ?? 'unknown');

/** Upper bound of gold an action can move out of the actor's account. */
export function maxSpend(a: Action): Gold {
  switch (a.type) {
    case 'market_buy':
      return a.qty * a.maxPrice;
    case 'place_order':
      return a.qty * a.maxPrice;
    case 'hire':
      return a.qty * a.price;
    case 'invest':
    case 'deposit':
    case 'transfer':
      return a.amount;
    default:
      return 0;
  }
}

export interface GuardInput {
  contract: string; // contract the key is restricted to
  receiver: string; // contract the action targets
  action: Action;
  spentToday: Gold;
  dailyBudget: Gold;
}

export type GuardVerdict = { ok: true; method: string; spend: Gold } | { ok: false; method: string; reason: string };

export function checkNpcAction(input: GuardInput): GuardVerdict {
  const method = methodOf(input.action);
  if (input.receiver !== input.contract) {
    return { ok: false, method, reason: `key can only call ${input.contract}` };
  }
  if (!(NPC_ALLOWED_METHODS as readonly string[]).includes(method)) {
    return { ok: false, method, reason: `method not on the key (${method})` };
  }
  const spend = maxSpend(input.action);
  if (spend < 0 || !Number.isFinite(spend)) {
    return { ok: false, method, reason: 'invalid amount' };
  }
  if ('qty' in input.action && (!Number.isInteger(input.action.qty) || input.action.qty <= 0 || input.action.qty > 1000)) {
    return { ok: false, method, reason: 'invalid quantity' };
  }
  if (input.spentToday + spend > input.dailyBudget) {
    return {
      ok: false,
      method,
      reason: `over the daily budget (${fmt(input.spentToday + spend)} / ${fmt(input.dailyBudget)})`,
    };
  }
  return { ok: true, method, spend };
}
