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
