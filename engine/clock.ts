/** Hands control back to the engine between slices. */
export function yieldNow($: { clock: { sleep(ms: number): Promise<void> } }): Promise<void> {
  return $.clock.sleep(0);
}
