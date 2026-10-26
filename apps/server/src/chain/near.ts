import { Account, type KeyPairString } from 'near-api-js';
import type { ChainAdapter } from './signer.ts';

/**
 * NEAR testnet adapter. Each NPC signs with its own function-call access key, which
 * NEAR itself restricts to the hearth contract (receiver) and a method list.
 * Keys come from env vars (NPC_KEY_MIKE=ed25519:...), never from the repo.
 *
 * near-api-js 7.x API; verify on https://docs.near.org/tools/near-api before changing.
 */
export class NearChain implements ChainAdapter {
  readonly kind = 'near' as const;
  private accounts = new Map<string, Account>();

  constructor(private rpcUrl: string, keys: Record<string, string>) {
    for (const [accountId, key] of Object.entries(keys)) {
      if (key) this.accounts.set(accountId, new Account(accountId, rpcUrl, key as KeyPairString));
    }
  }

  async call(signer: string, contract: string, method: string, args: Record<string, unknown>): Promise<string> {
    const account = this.accounts.get(signer);
    if (!account) throw new Error(`no key configured for ${signer}`);
    const res = await account.callFunctionRaw({
      contractId: contract,
      methodName: method,
      args,
      gas: 30_000_000_000_000n, // 30 Tgas
      deposit: 0n,
    });
    const r = res as unknown as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };
    return r.transaction?.hash ?? r.transaction_outcome?.id ?? 'unknown';
  }
}
