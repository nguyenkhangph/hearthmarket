import {
  createVillage, NEAR_CONFIG, ReplayWorld, NPC_ALLOWED_METHODS, short,
  type Action, type ActionResult, type NpcId, type Village, type WorldDay, type WorldSource,
} from '@hearth/economy';
import type { NpcBrain } from './brain/brain.ts';
import type { ChainAdapter, NpcSigner } from './chain/signer.ts';

export interface HaggleOutcome {
  reply: string;
  brain: string;
  proposed?: Action;
  result?: ActionResult & { layer?: 'signer' | 'contract' };
}

/**
 * Calls mirrored to the chain when CHAIN=near: raw production and NPC-to-NPC deals.
 * Kept small on purpose (a few tx per game day). Orders, market trades and crafting stay
 * in the engine until the contract becomes the full authority (see docs/plan.md).
 */
const MIRROR = new Set(['produce', 'hire']);
const RAW = new Set(['ore', 'timber', 'wheat']);

/**
 * The authoritative game service: one village, one clock, one brain, one signer.
 * Transport-agnostic so tests can drive it directly.
 */
export class Game {
  readonly village: Village;
  private pendingN = 0;

  constructor(
    opts: { seed: number; world?: WorldSource; replayDays?: WorldDay[] },
    readonly brain: NpcBrain,
    readonly signer: NpcSigner,
    readonly chain: ChainAdapter,
  ) {
    const world = opts.world ?? (opts.replayDays ? new ReplayWorld(opts.replayDays) : undefined);
    this.village = createVillage({ seed: opts.seed, world });
    if (chain.kind === 'near') this.village.chainHook = (signer, method, args) => this.mirror(signer, method, args);
  }

  tick() {
    this.village.step();
  }

  /** Mirror selected NPC calls to NEAR testnet; patch the local record with the real hash. */
  private mirror(signer: string, method: string, args: Record<string, unknown>): string | undefined {
    if (!MIRROR.has(method) || !signer.endsWith(`.${NEAR_CONFIG.contract}`)) return undefined;
    if (method === 'produce' && !RAW.has(String(args.item))) return undefined;
    if (!(NPC_ALLOWED_METHODS as readonly string[]).includes(method)) return undefined;
    const placeholder = `pending${(this.pendingN++).toString().padStart(6, '0')}xx`;
    this.chain
      .call(signer, this.signer.contract, method, args)
      .then((hash) => {
        console.log(`chain ok   ${signer} ${method} tx=${hash}`);
        this.patchHash(placeholder, hash);
      })
      .catch((e: Error) => {
        console.error(`chain FAIL ${signer} ${method}: ${e.message}`);
        this.patchHash(placeholder, `failed:${e.message.slice(0, 40)}`);
      });
    return placeholder;
  }

  private patchHash(placeholder: string, hash: string) {
    const s = this.village.s;
    for (const t of s.txs) if (t.hash === placeholder) t.hash = hash;
    for (const f of s.feed) {
      if (f.tx === placeholder) {
        f.tx = hash;
        f.text = f.text.replace(short(placeholder), short(hash));
      }
    }
    for (const d of s.diary) if (d.tx === placeholder) d.tx = hash;
  }

  join(playerId: string, name: string) {
    return this.village.addPlayer(playerId, name);
  }

  act(playerId: string, action: Action): ActionResult {
    return this.village.act({ kind: 'player', id: playerId }, action);
  }

  /**
   * A player haggles with an NPC. The brain may propose one action. It then has to pass
   * the signer (function-call key rules + budget) and the contract (here: the engine,
   * which mirrors the contract's checks). Either layer can block it.
   */
  async haggle(npc: NpcId, message: string): Promise<HaggleOutcome> {
    const p = await this.brain.haggle(this.village, npc, message);
    if (!p.action) return { reply: p.reply, brain: p.brain };
    const n = this.village.s.npcs[npc];
    const signed = await this.signer.submit(npc, p.action, n.spentToday);
    if (!signed.ok) {
      // log the refusal in the village exactly as the contract would
      this.village.npcAct(npc, p.action);
      return { reply: p.reply, brain: p.brain, proposed: p.action, result: { ok: false, reason: signed.reason, layer: 'signer' } };
    }
    const r = this.village.npcAct(npc, p.action);
    return { reply: p.reply, brain: p.brain, proposed: p.action, result: r.ok ? { ...r, tx: signed.tx } : { ...r, layer: 'contract' } };
  }
}
