// Copied 2026-11-27 from https://platform.claude.com/docs/en/about-claude/pricing.md
// (snapshot: tests/fixtures/pricing-sample.md). USD per MTok.
// Cache hits: 0.025x on fable/mythos 5.1-5.2, 0.05x on opus/sonnet 5.5, 0.1x elsewhere.
// Fast mode (page: fable/mythos 5.2, opus 5.5/5/4.8) lists exactly 2x input and output.
// Long context: only haiku 5.5 tiers by prompt length (over 100,000 input tokens = 5x on every class).
import type { ModelPrice, PriceTable } from "./pricing.ts";

const p = (input: number, cw5m: number, cw1h: number, cacheRead: number, output: number, longContext?: ModelPrice["longContext"]): ModelPrice =>
  longContext ? { input, output, cacheRead, cw5m, cw1h, longContext } : { input, output, cacheRead, cw5m, cw1h };

export const BUILTIN_PRICES: PriceTable = {
  source: "builtin",
  updatedAt: Date.UTC(2026, 10, 27),
  fastMul: 2,
  models: {
    "claude-fable-5-2": p(8, 10, 16, 0.2, 40),
    "claude-mythos-5-2": p(8, 10, 16, 0.2, 40),
    "claude-fable-5-1": p(10, 12.5, 20, 0.25, 50),
    "claude-mythos-5-1": p(10, 12.5, 20, 0.25, 50),
    "claude-fable-5": p(10, 12.5, 20, 1, 50),
    "claude-mythos-5": p(10, 12.5, 20, 1, 50),
    "claude-opus-5-5": p(4, 5, 8, 0.2, 20),
    "claude-opus-5": p(5, 6.25, 10, 0.5, 25),
    "claude-opus-4-8": p(5, 6.25, 10, 0.5, 25),
    "claude-opus-4-7": p(5, 6.25, 10, 0.5, 25),
    "claude-opus-4-6": p(5, 6.25, 10, 0.5, 25),
    "claude-opus-4-5": p(5, 6.25, 10, 0.5, 25),
    "claude-opus-4-1": p(15, 18.75, 30, 1.5, 75),
    "claude-opus-4": p(15, 18.75, 30, 1.5, 75),
    "claude-sonnet-5-5": p(2, 2.5, 4, 0.1, 10),
    "claude-sonnet-5": p(2, 2.5, 4, 0.2, 10),
    "claude-sonnet-4-6": p(3, 3.75, 6, 0.3, 15),
    "claude-sonnet-4-5": p(3, 3.75, 6, 0.3, 15),
    "claude-sonnet-4": p(3, 3.75, 6, 0.3, 15),
    "claude-haiku-5-5": p(0.1, 0.125, 0.2, 0.01, 0.5, { threshold: 100000, inputMul: 5, outputMul: 5 }),
    "claude-haiku-4-5": p(1, 1.25, 2, 0.1, 5),
  },
};
