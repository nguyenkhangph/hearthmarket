import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadState, mergeProofs, saver } from '../src/persist.ts';

describe('dashboard state across restarts', () => {
  it('saves the red-team score and proofs, and merges them with the committed history', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hm-')), 'state.json');
    expect(loadState(file)).toEqual({});
    const proofs = [{ at: 2, signer: 'theo', method: 'hire', ok: false, hash: 'B', redTeam: true }];
    const s = saver(file, () => ({ redTeam: { runs: 2, blocked: 2, bySigner: 1, byContract: 1, onChain: 1 }, proofs }));
    s.flush();
    const back = loadState(file);
    expect(back.redTeam?.blocked).toBe(2);
    expect(JSON.parse(readFileSync(file, 'utf8')).proofs).toHaveLength(1);
    const history = [{ at: 1, signer: 'op', method: 'mint_badge', ok: true, hash: 'A' }, { at: 2, signer: 'theo', method: 'hire', ok: false, hash: 'B' }];
    expect(mergeProofs(history, back.proofs).map((e) => e.hash)).toEqual(['A', 'B']);
  });

  it('the committed proof history holds real-looking NEAR hashes only', () => {
    const h = JSON.parse(readFileSync(join(__dirname, '../../../data/proof-history.json'), 'utf8')) as { events: { hash: string }[] };
    for (const e of h.events) expect(e.hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });
});
