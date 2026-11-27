import { describe, expect, test } from "claude-code/testing";
import type { Hint } from "../core/hint.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { subagentModel } from "../core/rules/subagent-model.ts";
import type { Summary } from "../core/summary.ts";

const NOW = Date.UTC(2026, 10, 27, 12);
const DAY = 86_400_000;
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const LOW_ACTION = "Try sonnet for one week";
const noTokens = { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 };
const money = (usd: number, requests: number, tokens: Partial<typeof noTokens> = {}) => ({ usd, requests, tokens: { ...noTokens, ...tokens } });

const summaryOf = (over: Partial<Summary>): Summary => ({
  span: "30d",
  from: NOW - DAY,
  to: NOW,
  total: money(0, 0),
  main: money(0, 0),
  sub: money(0, 0),
  fast: money(0, 0),
  byModel: {},
  byRepo: {},
  bySubType: {},
  subStats: {},
  bySkill: {},
  byPlugin: {},
  byMcp: {},
  timeline: { bucketMs: DAY, points: [] },
  hourBands: [0, 0, 0, 0, 0],
  topSessions: [],
  unpriced: [],
  cacheRebuilds: [],
  peakContext: {},
  flow: [],
  flowByAgent: {},
  mcpReread: {},
  pastes: [],
  wholeReads: {},
  compactions: {},
  toolFill: {},
  ...over,
});

type Shape = { tools: Record<string, number>; requests: number; output: number; tasks: number; results: number; errors: number; model: string };
// A type that satisfies all four high conditions: read-only tools, 1000 output tokens per request, 2.5% failed
// tool results, 5 turns per task. Each case overrides one figure.
const GOOD: Shape = { tools: { Read: 5, Grep: 2 }, requests: 20, output: 20_000, tasks: 4, results: 40, errors: 1, model: OPUS };

function run(over: Partial<Shape> = {}, type = "Explore"): Hint[] {
  return runAll({ [type]: over });
}

function runAll(types: Record<string, Partial<Shape>>): Hint[] {
  const bySubType: Summary["bySubType"] = {};
  const subStats: Summary["subStats"] = {};
  for (const [type, over] of Object.entries(types)) {
    const s = { ...GOOD, ...over };
    bySubType[type] = { [s.model]: { ...money(10.5, s.requests, { input: 1_000_000, output: s.output, cacheRead: 10_000_000, cw5m: 500_000 }), tools: s.tools } };
    subStats[type] = { tasks: s.tasks, results: s.results, errors: s.errors };
  }
  return subagentModel.run({ scope: "span", summary: summaryOf({ bySubType, subStats }), snaps: [], plugins: [], prices: BUILTIN_PRICES, nowMs: NOW });
}

const one = (hints: Hint[]): Hint => {
  expect(hints.length).toBe(1);
  return hints[0]!;
};

describe("subagent-model confidence", () => {
  test("a read-only, short-output, clean, short-task type is high confidence with the standing action", () => {
    const h = one(run());
    expect(h.confidence).toBe("high");
    expect(h.action).toContain("`model:` line");
    expect(h.action).not.toBe(LOW_ACTION);
  });

  test("a type that breaks every condition is low confidence with the trial action, and usd is the same figure", () => {
    const h = one(run({ tools: { Read: 1, Bash: 3 }, output: 20 * 5000, errors: 10, tasks: 1 }));
    expect(h.confidence).toBe("low");
    expect(h.action).toBe(LOW_ACTION);
    expect(h.usd).toBeGreaterThan(0);
  });

  test("usd matches between levels for identical spend", () => {
    expect(one(run({ tools: { Read: 1, Bash: 3 } })).usd).toBe(one(run()).usd);
  });

  describe("each high condition failing alone gives low", () => {
    test("a shell tool is not read-only", () => {
      const h = one(run({ tools: { Read: 4, Bash: 1 } }));
      expect(h.confidence).toBe("low");
      expect(h.action).toBe(LOW_ACTION);
    });
    test("average output of 2k tokens per request", () => {
      const h = one(run({ output: 20 * 2000 }));
      expect(h.confidence).toBe("low");
      expect(h.action).toBe(LOW_ACTION);
    });
    test("5% of tool results failing", () => {
      const h = one(run({ results: 40, errors: 2 }));
      expect(h.confidence).toBe("low");
      expect(h.action).toBe(LOW_ACTION);
    });
    test("more than 10 turns per task", () => {
      const h = one(run({ requests: 22, tasks: 2 }));
      expect(h.confidence).toBe("low");
      expect(h.action).toBe(LOW_ACTION);
    });
  });

  describe("values just inside each limit stay high", () => {
    test("output just under 2k per request", () => expect(one(run({ output: 20 * 2000 - 20 })).confidence).toBe("high"));
    test("error share just under 5%", () => expect(one(run({ results: 41, errors: 2 })).confidence).toBe("high"));
    test("exactly 10 turns per task", () => expect(one(run({ requests: 20, tasks: 2 })).confidence).toBe("high"));
    test("every read-only tool is allowed", () => expect(one(run({ tools: { Read: 1, Grep: 1, Glob: 1, LS: 1, WebFetch: 1, WebSearch: 1 } })).confidence).toBe("high"));
  });

  test("a type with no tool calls and no failures is high", () => {
    expect(one(run({ tools: {}, results: 0, errors: 0 })).confidence).toBe("high");
  });

  test("hand-back tools do not make a type low", () => {
    expect(one(run({ tools: { Read: 2, SubagentHandback: 1 } })).confidence).toBe("high");
  });

  test("a type with no task count (older shards) cannot show short tasks, so it is low", () => {
    const h = one(run({ tasks: 0 }));
    expect(h.confidence).toBe("low");
    expect(h.action).toBe(LOW_ACTION);
  });

  test("a type missing from subStats is low and does not throw", () => {
    const bySubType = { Explore: { [OPUS]: { ...money(10.5, 20, { input: 1_000_000, output: 20_000, cacheRead: 10_000_000, cw5m: 500_000 }), tools: { Read: 1 } } } };
    const h = one(subagentModel.run({ scope: "span", summary: summaryOf({ bySubType }), snaps: [], plugins: [], prices: BUILTIN_PRICES, nowMs: NOW }));
    expect(h.confidence).toBe("low");
  });

  test("figures of one type's models are pooled before the limits apply", () => {
    // two models alone average 2000 output per request (low); a third model of 20 requests at 500 pools it to 1250.
    const model = (requests: number, output: number) => ({ ...money(10.5, requests, { input: 1_000_000, output, cacheRead: 10_000_000, cw5m: 500_000 }), tools: { Read: 1 } });
    const bySubType = { Explore: { [OPUS]: model(10, 30_000), "claude-opus-5-4": model(10, 10_000), "claude-fable-5-2": model(20, 10_000) } };
    const subStats = { Explore: { tasks: 5, results: 40, errors: 0 } };
    const h = one(subagentModel.run({ scope: "span", summary: summaryOf({ bySubType, subStats }), snaps: [], plugins: [], prices: BUILTIN_PRICES, nowMs: NOW }));
    expect(h.confidence).toBe("high");
  });

  test("the hint is high only when every listed type is high", () => {
    const h = one(runAll({ Explore: {}, Plan: { tools: { Read: 1, Bash: 1 } } }));
    expect(h.confidence).toBe("low");
    expect(h.action).toBe(LOW_ACTION);
    expect(one(runAll({ Explore: {}, Plan: {} })).confidence).toBe("high");
  });

  test("sonnet-priced types are still left alone whatever their stats", () => {
    expect(run({ model: SONNET, tools: { Read: 1 } })).toEqual([]);
  });
});

describe("subagent-model families", () => {
  test("a Mythos sub-agent type is flagship like Opus and Fable", () => {
    const h = one(run({ model: "claude-mythos-5-2" }));
    expect(h.usd).toBeGreaterThan(0);
    expect(h.evidence[0]!.detail).toContain("mythos-5-2");
  });
});
