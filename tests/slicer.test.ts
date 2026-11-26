import { describe, test, expect } from "claude-code/testing";
import { createSlicer } from "../engine/slicer.ts";

describe("slicer", () => {
  test("yields once on the 3rd check when each check advances 20 ms", async () => {
    let t = 0;
    let yields = 0;
    const s = createSlicer(
      () => t,
      async () => {
        yields++;
      },
    );
    for (let i = 0; i < 3; i++) {
      t += 20;
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

  test("engine exposes Date.now", () => {
    expect(typeof Date.now()).toBe("number");
    expect(typeof (globalThis as any).performance).toBe("object");
  });
});
