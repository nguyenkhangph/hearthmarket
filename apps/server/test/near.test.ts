import { describe, expect, it } from 'vitest';
import { NearChain, isRateLimited, parseRpcUrls } from '../src/chain/near.ts';

const LIMIT = '{"jsonrpc": "2.0", "error": {"code": -429, "message": "Rate limits exceeded."}, "id": "1"}';

function chain(behaviour: (url: string, n: number) => 'ok' | 'limit' | 'panic') {
  const seen: string[] = [];
  let n = 0;
  const c = new NearChain(['https://a', 'https://b'], { 'mike.h.testnet': 'ed25519:x' }, {
    sleep: async () => {},
    spacingMs: 0,
    makeAccount: (_id, url) => ({
      callFunctionRaw: (async () => {
        seen.push(url);
        const b = behaviour(url, n++);
        if (b === 'limit') throw new Error(LIMIT);
        if (b === 'panic') throw new Error('Smart contract panicked: over the daily budget');
        return { transaction: { hash: `H-${url}` } };
      }) as never,
    }),
  });
  return { c, seen };
}

describe('NEAR RPC adapter', () => {
  it('moves to the next endpoint on a 429 and succeeds there', async () => {
    const { c, seen } = chain((url) => (url === 'https://a' ? 'limit' : 'ok'));
    expect(await c.call('mike.h.testnet', 'h.testnet', 'produce', {})).toBe('H-https://b');
    expect(seen).toEqual(['https://a', 'https://b']);
    expect(c.stats.retried).toBe(1);
  });
  it('never retries a contract error (the action may have run)', async () => {
    const { c, seen } = chain(() => 'panic');
    await expect(c.call('mike.h.testnet', 'h.testnet', 'hire', {})).rejects.toThrow('over the daily budget');
    expect(seen).toHaveLength(1);
  });
  it('gives up after the retries with a short message', async () => {
    const { c } = chain(() => 'limit');
    await expect(c.call('mike.h.testnet', 'h.testnet', 'produce', {})).rejects.toThrow('RPC rate limit (tried 5x on 2 endpoints)');
  });
  it('recognises rate-limit errors and splits the URL list', () => {
    expect(isRateLimited(new Error(LIMIT))).toBe(true);
    expect(isRateLimited(new Error('Smart contract panicked: not enough goods'))).toBe(false);
    expect(parseRpcUrls(' https://a , https://b,')).toEqual(['https://a', 'https://b']);
  });
});
