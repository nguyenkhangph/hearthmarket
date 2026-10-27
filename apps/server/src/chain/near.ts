import { Account, type KeyPairString } from 'near-api-js';
import type { ChainAdapter } from './signer.ts';

/**
 * NEAR testnet adapter. Each NPC signs with its own function-call access key, which
 * NEAR itself restricts to the hearth contract (receiver) and a method list.
 * Keys come from env vars (NPC_KEY_MIKE=ed25519:...), never from the repo.
 *
 * Public RPC endpoints rate-limit (HTTP/JSON-RPC 429). Every call goes through one gate
 * (a few at a time, spaced out), and a 429 is retried on the next endpoint in the list
 * after a short backoff. Only 429s are retried: the node refused the request before
 * processing it, so a retry cannot run the same action twice.
 *
 * near-api-js 7.x API; verify on https://docs.near.org/tools/near-api before changing.
 */
export interface NearChainOptions {
  /** calls in flight at once across all keys */
  concurrency?: number;
  /** minimum gap between two calls starting, ms */
  spacingMs?: number;
  /** retries on 429 before giving up */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** tests: build the account object for (accountId, rpcUrl, key) */
  makeAccount?: (accountId: string, rpcUrl: string, key: string) => Pick<Account, 'callFunctionRaw'>;
}

export const isRateLimited = (e: unknown) => /-429|\b429\b|rate limit/i.test(String((e as Error)?.message ?? e));

export class NearChain implements ChainAdapter {
  readonly kind = 'near' as const;
  /** per signer, one Account per RPC endpoint */
  private accounts = new Map<string, Pick<Account, 'callFunctionRaw'>[]>();
  private rpc = 0;
  private inFlight = 0;
  private waiters: (() => void)[] = [];
  private lastStart = 0;
  readonly stats = { calls: 0, rateLimited: 0, retried: 0 };

  constructor(readonly rpcUrls: string[], keys: Record<string, string>, private opts: NearChainOptions = {}) {
    if (!rpcUrls.length) throw new Error('no NEAR RPC endpoint');
    const make = opts.makeAccount ?? ((id, url, key) => new Account(id, url, key as KeyPairString));
    for (const [accountId, key] of Object.entries(keys)) {
      if (key) this.accounts.set(accountId, rpcUrls.map((u) => make(accountId, u, key)));
    }
  }

  private sleep(ms: number) {
    return (this.opts.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms);
  }

  private async acquire() {
    while (this.inFlight >= (this.opts.concurrency ?? 3)) await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
    const wait = this.lastStart + (this.opts.spacingMs ?? 250) - Date.now();
    this.lastStart = Math.max(Date.now(), this.lastStart + (this.opts.spacingMs ?? 250));
    if (wait > 0) await this.sleep(wait);
  }

  private release() {
    this.inFlight--;
    this.waiters.shift()?.();
  }

  async call(signer: string, contract: string, method: string, args: Record<string, unknown>, tgas = 20): Promise<string> {
    const accounts = this.accounts.get(signer);
    if (!accounts) throw new Error(`no key configured for ${signer}`);
    const retries = this.opts.retries ?? 4;
    for (let attempt = 0; ; attempt++) {
      const i = this.rpc % accounts.length;
      await this.acquire();
      try {
        this.stats.calls++;
        const res = await accounts[i].callFunctionRaw({
          contractId: contract,
          methodName: method,
          args,
          gas: BigInt(tgas) * 1_000_000_000_000n,
          deposit: 0n,
        });
        const r = res as unknown as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };
        return r.transaction?.hash ?? r.transaction_outcome?.id ?? 'unknown';
      } catch (e) {
        if (!isRateLimited(e)) throw e;
        this.stats.rateLimited++;
        if (attempt >= retries) throw new Error(`RPC rate limit (tried ${attempt + 1}x on ${this.rpcUrls.length} endpoint${this.rpcUrls.length > 1 ? 's' : ''})`);
        this.stats.retried++;
        this.rpc = (i + 1) % accounts.length; // next endpoint for everyone
      } finally {
        this.release();
      }
      await this.sleep(Math.min(8000, 600 * 2 ** attempt) + Math.floor(Math.random() * 300));
    }
  }
}

/** NEAR_RPC_URL may list several endpoints, comma-separated. */
export const parseRpcUrls = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
