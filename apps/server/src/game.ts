import {
  createVillage, ReplayWorld,
  type Action, type ActionResult, type NpcId, type Village, type WorldDay, type WorldSource,
} from '@hearth/economy';
import type { NpcBrain } from './brain/brain.ts';
import type { ChainAdapter, NpcSigner } from './chain/signer.ts';
import type { ChainMirror, WorldPostInput } from './chain/mirror.ts';

export interface HaggleOutcome {
  reply: string;
  brain: string;
  proposed?: Action;
  result?: ActionResult & { layer?: 'signer' | 'contract' };
}

export interface GameOptions {
  seed: number;
  world?: WorldSource;
  replayDays?: WorldDay[];
  /** mirrors accepted actions onto the hearth contract (CHAIN=near) */
  mirror?: ChainMirror;
  /** world data for the day's on-chain post (source, compact reading, payload hash) */
  worldPost?: () => WorldPostInput | undefined;
  /** called once per game day, before the chain sync (the LLM brain plans here) */
  onNewDay?: (v: Village) => void;
}

/**
 * The authoritative game service: one village, one clock, one brain, one signer.
 * Transport-agnostic so tests can drive it directly.
 */
export class Game {
  readonly village: Village;
  readonly mirror?: ChainMirror;

  constructor(
    private opts: GameOptions,
    readonly brain: NpcBrain,
    readonly signer: NpcSigner,
    readonly chain: ChainAdapter,
  ) {
    const world = opts.world ?? (opts.replayDays ? new ReplayWorld(opts.replayDays) : undefined);
    this.village = createVillage({ seed: opts.seed, world });
    this.mirror = opts.mirror;
    if (this.mirror) {
      this.village.chainHook = this.mirror.hook;
      this.village.badgeHook = this.mirror.badgeHook;
      this.mirror.onSettled = (placeholder, hash) => this.village.patchTx(placeholder, hash);
    }
  }

  tick() {
    this.village.step();
    if (this.village.hour === 0) {
      this.opts.onNewDay?.(this.village);
      this.mirror?.startDay(this.village, this.opts.worldPost?.());
    }
  }

  join(playerId: string, name: string) {
    const p = this.village.addPlayer(playerId, name);
    this.mirror?.registerPlayer(playerId);
    return p;
  }

  act(playerId: string, action: Action): ActionResult {
    return this.village.act({ kind: 'player', id: playerId }, action);
  }

  /**
   * A player haggles with an NPC. The brain may propose one action. It then has to pass
   * the signer (function-call key rules + budget) and the contract (the engine mirrors the
   * contract's checks; with CHAIN=near the contract checks it again). Either layer can block it.
   */
  async haggle(npc: NpcId, message: string): Promise<HaggleOutcome> {
    const p = await this.brain.haggle(this.village, npc, message);
    if (!p.action) return { reply: p.reply, brain: p.brain };
    const n = this.village.s.npcs[npc];
    const verdict = this.signer.check(npc, p.action, n.spentToday);
    if (!verdict.ok) {
      // log the refusal in the village exactly as the contract would; nothing is signed
      this.village.npcAct(npc, p.action);
      return { reply: p.reply, brain: p.brain, proposed: p.action, result: { ok: false, reason: verdict.reason, layer: 'signer' } };
    }
    // accepted by the signer: the engine applies it and, online, the mirror signs it with the NPC key
    const r = this.village.npcAct(npc, p.action);
    return { reply: p.reply, brain: p.brain, proposed: p.action, result: r.ok ? r : { ...r, layer: 'contract' } };
  }
}
