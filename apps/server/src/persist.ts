import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChainEvent } from './chain/mirror.ts';
import type { RedTeamStats } from './dashboard.ts';

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
