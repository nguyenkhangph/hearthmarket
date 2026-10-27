import { NPCS, type NpcId, type Village } from '@hearth/economy';
import type { NpcBrain } from './brain.ts';

/**
 * Asks the LLM for each NPC's day plan, one NPC at a time and at most once per
 * `everyMs` per NPC, so token use stays small however fast the clock runs.
 * A failed or slow call just leaves yesterday's routine in place.
 */
export class DayPlanner {
  private last = new Map<NpcId, number>();
  private running = false;
  calls = 0;
  failures = 0;

  constructor(
    private brain: NpcBrain,
    private opts: { everyMs: number; log?: (line: string) => void; now?: () => number },
  ) {}

  /** Call at the start of each game day; returns the NPCs it will plan for. */
  onNewDay(v: Village): NpcId[] {
    if (this.running) return [];
    const now = (this.opts.now ?? Date.now)();
    const due = NPCS.filter((id) => now - (this.last.get(id) ?? -Infinity) >= this.opts.everyMs);
    if (!due.length) return [];
    for (const id of due) this.last.set(id, now);
    this.running = true;
    void this.run(v, due).finally(() => {
      this.running = false;
    });
    return due;
  }

  async run(v: Village, npcs: NpcId[]) {
    for (const id of npcs) {
      try {
        this.calls++;
        const { proposal, why, saw } = await this.brain.plan(v, id);
        v.setPlan(id, proposal, this.brain.name, why, saw);
      } catch (e) {
        this.failures++;
        this.opts.log?.(`brain plan failed for ${id}: ${(e as Error).message}`);
      }
    }
  }
}
