import { describe, expect, it } from 'vitest';
import { OpenAiCompatible, modelStatus, shortReason } from '../src/brain/llm.ts';

describe('model status', () => {
  it('records the last error in short, without the key, and the last answer', async () => {
    const ep = { name: 'NEAR AI Cloud', baseUrl: 'https://x/v1', apiKey: 'sk-secret-123', model: 'm' };
    const bad = new OpenAiCompatible(ep, (async () => new Response('{"error":"insufficient credits for Bearer sk-secret-123"}', { status: 402 })) as typeof fetch);
    await expect(bad.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/402/);
    expect(modelStatus.lastError).toMatch(/^NEAR AI Cloud: HTTP 402: .*insufficient credits/);
    expect(modelStatus.lastError).not.toContain('sk-secret');
    const good = new OpenAiCompatible(ep, (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))) as typeof fetch);
    expect(await good.complete([{ role: 'user', content: 'hi' }])).toBe('ok');
    expect(modelStatus.lastOkAt! >= modelStatus.lastErrorAt!).toBe(true);
  });
  it('says "timed out" for an aborted call', () => {
    expect(shortReason(new Error('The operation was aborted due to timeout'))).toBe('timed out');
  });
});
