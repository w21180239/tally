import type { Engine } from "claude-code/testing";

/** Hands control back to the engine between slices. */
export function yieldNow($: Engine): Promise<void> {
  return $.clock.sleep(0);
}
