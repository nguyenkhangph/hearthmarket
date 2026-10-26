import { methodOf, checkNpcAction, NPC_DEFS, type Action, type Gold, type NpcId } from '@hearth/economy';

/** Something that can submit a function call to the hearth contract. */
export interface ChainAdapter {
  readonly kind: 'mock' | 'near';
  call(signer: string, contract: string, method: string, args: Record<string, unknown>): Promise<string>;
}

/** In-memory chain for local runs and tests. Records every call. */
export class MockChain implements ChainAdapter {
  readonly kind = 'mock' as const;
  calls: { signer: string; contract: string; method: string; args: Record<string, unknown>; hash: string }[] = [];
  async call(signer: string, contract: string, method: string, args: Record<string, unknown>) {
    const hash = `mock${this.calls.length.toString().padStart(6, '0')}`;
    this.calls.push({ signer, contract, method, args, hash });
    return hash;
  }
}

export type SignVerdict = { ok: true; tx: string; method: string } | { ok: false; reason: string; method: string; layer: 'signer' };

/**
 * The NPC signer holds the NPC function-call keys. It is the second line of defence:
 * whatever the LLM proposes, it only signs methods on the key, only towards the hearth
 * contract, and only within the daily budget. The contract checks the same rules again.
 */
export class NpcSigner {
  constructor(private chain: ChainAdapter, readonly contract: string) {}

  async submit(npc: NpcId, action: Action, spentToday: Gold): Promise<SignVerdict> {
    const receiver = action.type === 'call' && action.receiver ? action.receiver : this.contract;
    const verdict = checkNpcAction({
      contract: this.contract, receiver, action, spentToday, dailyBudget: NPC_DEFS[npc].dailyBudget,
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason, method: verdict.method, layer: 'signer' };
    const method = methodOf(action);
    const { type: _t, ...args } = action as Record<string, unknown>;
    const tx = await this.chain.call(NPC_DEFS[npc].account, receiver, method, args);
    return { ok: true, tx, method };
  }
}
