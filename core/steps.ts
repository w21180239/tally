// Cooperative computation: a generator yields at safe points; a caller that must not hold the event loop awaits between steps.
export type Steps<T> = Generator<void, T, void>;

/** Runs every step back to back. */
export function drain<T>(g: Steps<T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** Runs the steps, awaiting `tick` after each yield. */
export async function drainAsync<T>(g: Steps<T>, tick: () => Promise<void> | void): Promise<T> {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    await tick();
  }
}

/** Rows between two yields inside a loop. */
export const STEP_ROWS = 2048;

const SORT_RUN = 4096;

/** `items` sorted stably by `cmp` (a new array), yielding between runs and every STEP_ROWS merge steps. */
export function* sortSteps<T>(items: readonly T[], cmp: (a: T, b: T) => number): Steps<T[]> {
  let runs: T[][] = [];
  for (let i = 0; i < items.length; i += SORT_RUN) {
    runs.push(items.slice(i, i + SORT_RUN).sort(cmp));
    yield;
  }
  while (runs.length > 1) {
    const next: T[][] = [];
    for (let r = 0; r < runs.length; r += 2) {
      if (r + 1 === runs.length) {
        next.push(runs[r]);
        break;
      }
      const a = runs[r];
      const b = runs[r + 1];
      const out: T[] = [];
      let i = 0;
      let j = 0;
      let work = 0;
      while (i < a.length || j < b.length) {
        out.push(j >= b.length || (i < a.length && cmp(b[j], a[i]) >= 0) ? a[i++] : b[j++]);
        if (++work >= STEP_ROWS) {
          work = 0;
          yield;
        }
      }
      next.push(out);
    }
    runs = next;
  }
  return runs[0] ?? [];
}
