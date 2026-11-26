import { describe, test, expect } from "claude-code/testing";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { costOf, resolvePrice } from "../core/pricing.ts";
import type { UsageRow } from "../core/types.ts";

const row = (model: string, t: Partial<UsageRow["tokens"]> = {}, extra: Partial<UsageRow> = {}): UsageRow => ({
  requestId: "r",
  sessionId: "s",
  ts: 1,
  model,
  tokens: { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0, ...t },
  fast: false,
  sidechain: false,
  synthetic: false,
  thinkingChars: 0,
  replyChars: 0,
  tools: [],
  ...extra,
});

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe("builtin table", () => {
  test("cache multipliers follow the page", () => {
    for (const [id, p] of Object.entries(BUILTIN_PRICES.models)) {
      expect(near(p.cw5m, 1.25 * p.input)).toBe(true);
      expect(near(p.cw1h, 2 * p.input)).toBe(true);
      const ratio = p.cacheRead / p.input;
      expect([0.1, 0.05, 0.025].some((m) => near(ratio, m))).toBe(true);
      expect(id.startsWith("claude-")).toBe(true);
    }
  });
  test("fast multiplier is 2", () => {
    expect(BUILTIN_PRICES.fastMul).toBe(2);
  });
});

describe("resolvePrice", () => {
  test("exact with date suffix and [1m]", () => {
    const a = resolvePrice("claude-opus-4-5-20251101", BUILTIN_PRICES)!;
    expect(a.exact).toBe(true);
    expect(a.price.input).toBe(5);
    expect(resolvePrice("claude-sonnet-4-5[1m]", BUILTIN_PRICES)!.exact).toBe(true);
    expect(resolvePrice("claude-haiku-4-5-20251001", BUILTIN_PRICES)!.price.output).toBe(5);
    expect(resolvePrice("claude-opus-4-20250514", BUILTIN_PRICES)!.price.input).toBe(15);
  });
  test("unknown version falls back to newest in family", () => {
    const r = resolvePrice("claude-opus-9-9", BUILTIN_PRICES)!;
    expect(r.exact).toBe(false);
    expect(r.price).toEqual(BUILTIN_PRICES.models["claude-opus-5-5"]);
    expect(resolvePrice("claude-fable-5-2", BUILTIN_PRICES)!.exact).toBe(true);
  });
  test("non-claude is null", () => {
    expect(resolvePrice("gpt-4o", BUILTIN_PRICES)).toBeNull();
    expect(resolvePrice("claude-unknownfamily-1", BUILTIN_PRICES)).toBeNull();
  });
});

describe("costOf", () => {
  test("plain cost", () => {
    const c = costOf(row("claude-opus-4-5", { input: 1e6, output: 1e6, cacheRead: 1e6, cw5m: 1e6, cw1h: 1e6 }), BUILTIN_PRICES);
    expect(near(c.usd, 5 + 25 + 0.5 + 6.25 + 10)).toBe(true);
    expect(c.priced).toBe(true);
    expect(c.exact).toBe(true);
  });
  test("synthetic is free", () => {
    const c = costOf(row("claude-opus-4-5", { input: 1e6 }, { synthetic: true }), BUILTIN_PRICES);
    expect(c).toEqual({ usd: 0, exact: true, priced: true });
  });
  test("unknown model is unpriced", () => {
    const c = costOf(row("gpt-4o", { input: 1e6 }), BUILTIN_PRICES);
    expect(c.priced).toBe(false);
    expect(c.usd).toBe(0);
  });
  test("fast multiplies by fastMul", () => {
    const t = { input: 1000, output: 500, cacheRead: 2000 };
    const a = costOf(row("claude-opus-5-5", t), BUILTIN_PRICES).usd;
    const b = costOf(row("claude-opus-5-5", t, { fast: true }), BUILTIN_PRICES).usd;
    expect(near(b, a * BUILTIN_PRICES.fastMul)).toBe(true);
  });
  test("long-context tier applies above threshold only", () => {
    const m = BUILTIN_PRICES.models["claude-haiku-5-5"];
    const lc = m.longContext!;
    expect(lc.threshold).toBe(100000);
    const at = costOf(row("claude-haiku-5-5", { input: 60000, cacheRead: 40000, output: 1000 }), BUILTIN_PRICES).usd;
    expect(near(at, (60000 * m.input + 40000 * m.cacheRead + 1000 * m.output) / 1e6)).toBe(true);
    const over = costOf(row("claude-haiku-5-5", { input: 60000, cacheRead: 30000, cw5m: 5000, cw1h: 5001, output: 1000 }), BUILTIN_PRICES).usd;
    const base = (60000 * m.input + 30000 * m.cacheRead + 5000 * m.cw5m + 5001 * m.cw1h) * lc.inputMul + 1000 * m.output * lc.outputMul;
    expect(near(over, base / 1e6)).toBe(true);
  });
});
