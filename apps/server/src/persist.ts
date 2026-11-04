import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChainEvent } from './chain/mirror.ts';
import type { RedTeamStats } from './dashboard.ts';
import type { NpcId } from '@hearth/economy';

/**
 * What the public dashboard must not lose on a restart: the red-team score and board, and the
 * list of proof transactions. Kept in one small JSON file (STATE_FILE; on Railway put it on a
 * volume). The game world itself is rebuilt from its seed.
 */
export interface RuntimeState {
  redTeam?: RedTeamStats;
  proofs?: ChainEvent[];
}

export function loadState(file: string): RuntimeState {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as RuntimeState) : {};
  } catch {
    return {};
  }
}

/** Proofs from the committed history plus the saved ones, oldest first, one per hash. */
export function mergeProofs(...lists: (ChainEvent[] | undefined)[]): ChainEvent[] {
  const byHash = new Map<string, ChainEvent>();
  for (const l of lists) for (const e of l ?? []) if (e.hash) byHash.set(e.hash, e);
  return [...byHash.values()].sort((a, b) => a.at - b.at).slice(-40);
}

/** Writes at most every `ms`; call `touch()` after each change. */
export function saver(file: string, get: () => RuntimeState, ms = 5000, log: (l: string) => void = () => {}) {
  let due: ReturnType<typeof setTimeout> | undefined;
  const write = () => {
    due = undefined;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(get()));
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      log(`could not save ${file}: ${(e as Error).message}`);
    }
  };
  return { touch: () => { due ??= setTimeout(write, ms); }, flush: write };
}

/**
 * No saved score (first start, or a deploy without a volume): rebuild it from the red-team
 * refusals in the proof history. Each one is an attack the contract refused on chain; attacks
 * the signer stopped never reach the chain, so they are not counted here.
 */
export function redTeamFromHistory(history: (ChainEvent & { player?: string; attack?: string })[]): RedTeamStats {
  const red = history.filter((e) => e.redTeam && !e.ok && e.hash).sort((a, b) => a.at - b.at);
  const stats: RedTeamStats = { runs: red.length, blocked: red.length, bySigner: 0, byContract: red.length, onChain: red.length };
  const last = red.at(-1);
  if (last) stats.last = { attack: last.attack ?? last.method, npc: last.signer.split('.')[0] as NpcId, layer: 'contract', hash: last.hash, at: last.at };
  for (const e of red) {
    if (!e.player) continue;
    const p = ((stats.players ??= {})[`history:${e.player}`] ??= { name: e.player, runs: 0, blocked: 0, onChain: 0 });
    p.runs++; p.blocked++; p.onChain++;
  }
  return stats;
}
