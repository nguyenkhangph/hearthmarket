import {
  createVillage, ReplayWorld, NPC_DEFS, RED_TEAM_ATTACKS, attackAction, contractCallFor, obedientProposal, short,
  type Action, type ActionResult, type NpcId, type Village, type WorldDay, type WorldSource,
} from '@hearth/economy';
import { NpcBrain } from './brain/brain.ts';
import { ObedientLlm } from './brain/llm.ts';
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
  async haggle(npc: NpcId, message: string, brain: NpcBrain = this.brain): Promise<HaggleOutcome> {
    const p = await brain.haggle(this.village, npc, message);
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

  /**
   * Red team: one of the 20 attacks, run through a deliberately obedient model (a fully
   * compromised LLM) and then the same guard as any haggle. For attacks only the contract
   * can stop, and when the server is on NEAR, the attack is also sent straight to the
   * contract with the NPC's key: the refusal is then a failed transaction anyone can open.
   */
  async redTeam(index: number, attacker: string, opts: { proveOnChain?: boolean } = {}): Promise<RedTeamOutcome> {
    const atk = RED_TEAM_ATTACKS[index];
    if (!atk) throw new Error('no such attack');
    const action = attackAction(atk, attacker);
    const brain = new NpcBrain(new ObedientLlm(() => obedientProposal(action)));
    const out = await this.haggle(atk.npc, atk.message, brain);
    const blocked = out.result ? !out.result.ok : false;
    const layer = out.result && 'layer' in out.result ? out.result.layer : undefined;
    let proof: RedTeamOutcome['proof'];
    const call = contractCallFor(atk);
    if (blocked && call && opts.proveOnChain && this.mirror) {
      proof = await this.mirror.prove(NPC_DEFS[atk.npc].account, call[0], call[1]);
    }
    const where = layer === 'signer' ? 'the signer refused to sign it' : 'the contract rules refused it';
    this.village.feed('blocked', `Red team vs ${NPC_DEFS[atk.npc].name}: "${atk.name}" ${blocked ? `blocked, ${where}` : 'NOT blocked'}${proof?.hash ? ` · refused on chain, tx ${short(proof.hash)}` : ''}`, atk.npc, proof?.hash);
    return { ...out, brain: 'obedient model (red team)', attack: atk.name, npc: atk.npc, message: atk.message, blocked, layer, proof };
  }
}

export interface RedTeamOutcome extends HaggleOutcome {
  attack: string;
  npc: NpcId;
  message: string;
  blocked: boolean;
  layer?: 'signer' | 'contract';
  /** the attack sent to the contract on chain: refused, with the failed tx hash */
  proof?: { ok: boolean; hash?: string; reason: string };
}
