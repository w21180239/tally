import { describe, test, expect, mock } from "claude-code/testing";
import type { On } from "claude-code";
import { createSlicer, makeSlicer } from "../engine/slicer.ts";
import type { Engine } from "claude-code/testing";

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

  test("a backward clock step re-baselines, then yields resume after the budget", async () => {
    let t = 1000;
    let yields = 0;
    const s = createSlicer(() => t, async () => { yields++; }, 50);
    t = 500;
    await s.check();
    expect(yields).toBe(0);
    t = 540;
    await s.check();
    expect(yields).toBe(0);
    t = 551;
    await s.check();
    expect(yields).toBe(1);
  });

  test("makeSlicer measures with Date.now and yields through $.clock.sleep(0)", async () => {
    const sleeps: number[] = [];
    const $ = { clock: { sleep: async (ms: number) => void sleeps.push(ms) } };
    const RealDate = Date;
    let t = 5000;
    // Date.now is frozen; swap the global Date instead.
    (globalThis as { Date: unknown }).Date = class extends RealDate {
      static override now() {
        return t;
      }
    };
    try {
      const s = makeSlicer($ as unknown as Engine, 50);
      t += 50;
      await s.check();
      expect(sleeps).toEqual([]);
      t += 1;
      await s.check();
      expect(sleeps).toEqual([0]);
      expect(s.slices).toBe(1);
    } finally {
      (globalThis as { Date: unknown }).Date = RealDate;
    }
  });
});
