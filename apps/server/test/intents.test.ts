import { describe, expect, it } from 'vitest';
import { createVillage } from '@hearth/economy';
import { fetchIntentsReading, readingFromTokens, XAUT_BASE_USD } from '../src/world/intents.ts';

// trimmed from GET https://1click.chaindefuser.com/v0/tokens (2026-11-01)
const payload = JSON.stringify([
  { assetId: 'nep141:wrap.near', decimals: 24, blockchain: 'near', symbol: 'wNEAR', price: 4.26, priceUpdatedAt: '2026-11-01T20:11:30.803Z', contractAddress: 'wrap.near' },
  { assetId: 'nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near', decimals: 6, blockchain: 'eth', symbol: 'XAUT', price: 3872.42, priceUpdatedAt: '2026-11-01T20:11:30.803Z', contractAddress: '0x68749665ff8d2d112fa859aa293f07a622782f38' },
]);

describe('world money from NEAR Intents', () => {
  it('turns the tokenized-gold price into a world-price factor, with the payload hash', () => {
    const r = readingFromTokens(payload);
    expect(r.factor).toBeCloseTo(XAUT_BASE_USD / 3872.42, 6);
    expect(r.quote).toBe('tokenized gold XAUT 3872.42 USD');
    expect(r.nearUsd).toBe(4.26);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a token list without a gold price', () => {
    expect(() => readingFromTokens('[{"symbol":"USDC","price":1}]')).toThrow('no XAUT');
    expect(() => readingFromTokens('{"error":"x"}')).toThrow();
  });

  it('reports HTTP errors', async () => {
    const f = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(fetchIntentsReading(f)).rejects.toThrow('HTTP 503');
  });

  it('nudges world prices in the engine, never more than 10%, and keeps the rate across days', () => {
    const v = createVillage({ seed: 3 });
    v.runDays(1);
    const before = v.s.world.price.ore!;
    v.setWorldFx({ ...readingFromTokens(payload) });
    expect(v.s.world.price.ore).toBe(Math.round(before * v.s.world.fx!.factor));
    v.setWorldFx({ factor: 50, quote: 'absurd', source: 'test', at: '' });
    expect(v.s.world.fx!.factor).toBe(1.1);
    v.setWorldFx({ factor: Number.NaN, quote: 'broken', source: 'test', at: '' });
    expect(v.s.world.fx!.factor).toBe(1);
    v.setWorldFx({ factor: 0.95, quote: 'q', source: 'test', at: '' });
    v.runDays(2);
    expect(v.s.world.fx!.factor).toBe(0.95);
  });
});
