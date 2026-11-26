import { describe, test, expect, mock } from "claude-code/testing";
import type { On } from "claude-code";
import { createSlicer, makeSlicer } from "../engine/slicer.ts";
import { worldOf } from "./world.ts";

// MockClock needs a hook registry (`on`); a no-op one is enough as the slicer only reads its time.
const noOn = (() => {}) as unknown as On;

describe("slicer", () => {
  test("yields once on the 3rd check when each check advances 20 ms", async () => {
    const clock = mock.clock(noOn, { now: 0 });
    let yields = 0;
    const s = createSlicer(
      () => clock.now(),
      async () => {
        yields++;
      },
    );
    for (let i = 0; i < 3; i++) {
      await clock.advance(20);
      await s.check();
      if (i < 2) expect(yields).toBe(0);
    }
    expect(yields).toBe(1);
    expect(s.slices).toBe(1);
  });

  test("restarts the timer after a yield and honours a custom budget", async () => {
    let t = 0;
    let yields = 0;
    const s = createSlicer(() => t, async () => { yields++; }, 10);
    t += 11;
    await s.check();
    await s.check();
    expect(yields).toBe(1);
    t += 11;
    await s.check();
    expect(yields).toBe(2);
    expect(s.slices).toBe(2);
  });

  test("a backward clock step never forces a yield", async () => {
    let t = 1000;
    let yields = 0;
    const s = createSlicer(() => t, async () => { yields++; }, 0);
    t = 500;
    await s.check();
    expect(yields).toBe(0);
  });

  test("makeSlicer yields through $.clock.sleep(0)", async () => {
    const w = worldOf();
    const sleeps: number[] = [];
    const $ = { ...w.$, clock: { ...w.$.clock, sleep: async (ms: number) => void sleeps.push(ms) } };
    const s = makeSlicer($ as never, -1);
    await s.check();
    expect(sleeps).toEqual([0]);
    expect(s.slices).toBe(1);
  });
});
