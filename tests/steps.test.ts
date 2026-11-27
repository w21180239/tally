import { describe, test, expect } from "claude-code/testing";
import { STEP_ROWS, drain, sortSteps } from "../core/steps.ts";

type Item = { k: number; id: number };
const items = (n: number, mod: number): Item[] => Array.from({ length: n }, (_, i) => ({ k: (i * 7919) % mod, id: i }));
const byK = (a: Item, b: Item): number => a.k - b.k;

describe("sortSteps", () => {
  test("matches a stable Array.sort for runs, odd run counts, ties and empty input", () => {
    for (const n of [0, 1, 5, 4096, 4097, 10_000, 3 * 4096 + 1]) {
      const xs = items(n, 50);
      expect(drain(sortSteps(xs, byK))).toEqual([...xs].sort(byK));
    }
  });

  test("hands control back while sorting a large input and leaves the input untouched", () => {
    const xs = items(STEP_ROWS * 8, 1_000_003);
    const copy = [...xs];
    const g = sortSteps(xs, byK);
    let yields = 0;
    for (let r = g.next(); !r.done; r = g.next()) yields++;
    expect(yields).toBeGreaterThanOrEqual(8);
    expect(xs).toEqual(copy);
  });
});
