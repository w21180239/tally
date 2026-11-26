import type { Engine } from "claude-code/testing";
import { yieldNow } from "./clock.ts";

export interface Slicer {
  check(): Promise<void>;
  slices: number;
}

/** `now` must be synchronous; yields (and restarts the slice) once the budget is spent. */
export function createSlicer(now: () => number, yieldFn: () => Promise<void>, budgetMs = 50): Slicer {
  let start = now();
  const s: Slicer = {
    slices: 0,
    async check() {
      if (Math.max(0, now() - start) <= budgetMs) return;
      s.slices++;
      await yieldFn();
      start = now();
    },
  };
  return s;
}

/** Slicer wired to the engine: Date-based CPU clock, `$.clock.sleep(0)` yield. */
export function makeSlicer($: Engine, budgetMs = 50): Slicer {
  return createSlicer(() => Date.now(), () => yieldNow($), budgetMs);
}
