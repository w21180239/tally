import { describe, expect, test } from "claude-code/testing";
import type { BreakdownSnapshot } from "../core/breakdown.ts";
import { HINT_RULES, runRules } from "../core/hint.ts";
import type { Hint, HintInput, HintRule } from "../core/hint.ts";
import type { InstalledPlugin } from "../core/plugins.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { BASELINE_RULES } from "../core/rules/index.ts";
import type { FlowItem, Paste } from "../core/flow.ts";
import type { Summary } from "../core/summary.ts";
import type { UsageDetail, UsageGroup } from "../core/usage-detail.ts";
import type { Rebuild } from "../core/cache-life.ts";

const NOW = Date.UTC(2026, 10, 27, 12);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const OPUS = "claude-opus-5-5";
const FABLE = "claude-fable-5-2";
const SONNET = "claude-sonnet-5-5";
const noTokens = { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 };
const money = (usd: number, requests = 1, tokens: Partial<typeof noTokens> = {}) => ({ usd, requests, tokens: { ...noTokens, ...tokens } });

const summaryOf = (over: Partial<Summary> = {}): Summary => ({
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
const inputOf = (over: Partial<HintInput> = {}): HintInput => ({ scope: "span", summary: summaryOf(), snaps: [], plugins: [], prices: BUILTIN_PRICES, nowMs: NOW, ...over });
const rule = (id: string): HintRule => {
  const r = BASELINE_RULES.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no rule ${id}`);
  return r;
};
const fire = (id: string, summary: Partial<Summary>, more: Partial<HintInput> = {}): Hint[] => rule(id).run(inputOf({ summary: summaryOf(summary), ...more }));
const only = (hints: Hint[]): Hint => {
  expect(hints.length).toBe(1);
  return hints[0]!;
};

const item = (source: FlowItem["source"], label: string, rereadUsd: number): FlowItem => ({ label, source, tokens: 1000, rereadTokens: 5000, rereadUsd });
const group = (key: string, usd: number): UsageGroup => ({ key, tokens: 1, usd, count: 1, items: [] });
// One main slice: `read` is the cache-read spend, `out` the output groups.
const usageOf = (read: number, out: UsageGroup[] = []): UsageDetail => {
  const amount = (usd: number) => ({ tokens: 1, usd });
  return { slices: { main: { totals: { input: amount(0), output: amount(out.reduce((n, g) => n + g.usd, 0)), cacheRead: amount(read), cacheWrite: amount(0) }, input: [], output: out, writes: [], big: [] } } };
};
const rebuild = (usd: number, tokens = 40_000, gapMs = 2 * HOUR): Rebuild => ({ sessionId: "s1", ts: NOW - HOUR, tokens, usd, gapMs, ttl: "5m" });
const paste = (tokens: number, rereadUsd: number): Paste => ({ sessionId: "s1", tokens, rereadUsd });
const snapOf = (over: Partial<BreakdownSnapshot> = {}): BreakdownSnapshot => ({ sessionId: "s1", ts: NOW - HOUR, skills: {}, mcp: {}, agents: {}, memory: {}, system: 0, tools: 0, ...over });
const plugin = (name: string, tokensPerRequest: number, used: boolean): InstalledPlugin => ({ name, tokensPerRequest, used });
// 100 main requests on opus 5.5 (cache read $0.2 per MTok): one resident token costs 100 * 0.2 / 1e6 = 0.00002.
const HUNDRED = { byModel: { [OPUS]: money(0, 100) }, main: money(0, 100) };

describe("rule registry", () => {
  test("14 baseline rules with unique ids; the shipped registry is that list", () => {
    expect(BASELINE_RULES.map((r) => r.id).sort()).toEqual(
      ["big-paste", "cache-rebuilt", "command-output", "costly-attribution", "fast-mode", "long-session", "near-limit", "repeat-compaction", "subagent-model", "thinking-output", "tool-output", "unused-mcp-server", "unused-plugin", "whole-reads"].sort(),
    );
    expect(HINT_RULES).toBe(BASELINE_RULES);
  });

  test("an empty span raises nothing, and every rule copes with it", async () => {
    for (const r of BASELINE_RULES) expect(r.run(inputOf())).toEqual([]);
    expect(await runRules(HINT_RULES, inputOf())).toEqual([]);
  });
});

describe("near-limit", () => {
  const win = (percentUsed: number, resetsAt = NOW + 2 * HOUR) => ({ percentUsed, resetsAt });
  test("fires above 80 percent and carries no dollar amount", () => {
    const h = only(rule("near-limit").run(inputOf({ limits: { fiveHour: win(80.1) } })));
    expect(h.rule).toBe("near-limit");
    expect(h.usd).toBe(0);
    expect(h.urgent).toBe(true);
    expect(h.short).toBe("5h cap at 80%");
    expect(h.evidence.map((e) => e.detail)).toEqual(["80% consumed; 2h 00m until reset"]);
  });
  test("stays quiet at 80 percent, with no limits, and once the window has reset", () => {
    expect(rule("near-limit").run(inputOf({ limits: { fiveHour: win(80), sevenDay: win(12) } }))).toEqual([]);
    expect(rule("near-limit").run(inputOf())).toEqual([]);
    expect(rule("near-limit").run(inputOf({ limits: { fiveHour: win(95, NOW - 1) } }))).toEqual([]);
  });
  test("a window with no reset time still fires, shows no reset and is never expired by the clock", () => {
    const h = only(rule("near-limit").run(inputOf({ limits: { fiveHour: { percentUsed: 95 } } })));
    expect(h.short).toBe("5h cap at 95%");
    expect(h.evidence.map((e) => e.detail)).toEqual(["95% consumed"]);
    expect(rule("near-limit").run(inputOf({ limits: { fiveHour: { percentUsed: 80 } } }))).toEqual([]);
  });
  test("a window with no reset time sits beside one with a reset time", () => {
    const h = only(rule("near-limit").run(inputOf({ limits: { fiveHour: { percentUsed: 90 }, sevenDay: win(85) } })));
    expect(h.evidence.map((e) => e.detail)).toEqual(["90% consumed", "85% consumed; 2h 00m until reset"]);
  });
  test("two windows over the line give two evidence rows, with days for the longer wait", () => {
    const h = only(rule("near-limit").run(inputOf({ limits: { fiveHour: win(91), sevenDay: win(85, NOW + 3 * DAY + 5 * HOUR) } })));
    expect(h.evidence.map((e) => `${e.label}|${e.detail}`)).toEqual(["5-hour window|91% consumed; 2h 00m until reset", "7-day window|85% consumed; 3d 5h until reset"]);
  });
});

describe("cache-rebuilt", () => {
  test("fires at 1 dollar of rebuilds and the amount is their sum (saving equals cost)", () => {
    const h = only(fire("cache-rebuilt", { cacheRebuilds: [rebuild(0.5), rebuild(0.5)], total: money(10) }));
    expect(Math.round((h.usd) * 1e9) / 1e9).toBe(1);
    expect(h.projected).toBeUndefined();
    expect(h.evidence.length).toBe(2);
    expect(h.metric).toEqual({ name: "rebuild share of cost", value: 0.1 });
  });
  test("stays quiet below 1 dollar", () => {
    expect(fire("cache-rebuilt", { cacheRebuilds: [rebuild(0.5), rebuild(0.49)] })).toEqual([]);
    expect(fire("cache-rebuilt", { cacheRebuilds: [] })).toEqual([]);
  });
  test("the metric is the rebuild share of the span cost, 0 with no cost", () => {
    const r = rule("cache-rebuilt");
    expect(r.metric?.(inputOf({ summary: summaryOf({ cacheRebuilds: [rebuild(2)], total: money(8) }) }))).toBe(0.25);
    expect(r.metric?.(inputOf())).toBe(0);
  });
  test("evidence lists the five largest rebuilds", () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map((n) => rebuild(n));
    const h = only(fire("cache-rebuilt", { cacheRebuilds: many }));
    expect(h.usd).toBe(28);
    expect(h.evidence.length).toBe(5);
    expect(h.evidence[0]!.detail).toContain("$7.00");
  });
});

describe("subagent-model", () => {
  // opus 5.5: 4 + 2 + 2 + 2.5 = 10.5. Sonnet 5.5: 2 + 1 + 1 + 1.25 = 5.25. Haiku 5.5: 0.1 + 0.05 + 0.1 + 0.0625 = 0.3125.
  const tokens = { input: 1_000_000, output: 100_000, cacheRead: 10_000_000, cw5m: 500_000, cw1h: 0 };
  const sub = (model: string, tools: Record<string, number>, usd = 10.5) => ({ Explore: { [model]: { ...money(usd, 20, tokens), tools } } });
  test("a type that only looks, run on opus, is priced on sonnet and its saving projected", () => {
    const h = only(fire("subagent-model", { bySubType: sub(OPUS, { Read: 5, Grep: 2, Bash: 1 }) }));
    expect(Math.round((h.usd) * 1e9) / 1e9).toBe(5.25);
    expect(h.projected).toBe(true);
    expect(h.evidence.map((e) => e.label)).toEqual(["Explore"]);
    expect(h.evidence[0]!.detail).toContain("$10.50");
    expect(h.evidence[0]!.detail).toContain("sonnet $5.25");
    expect(h.evidence[0]!.detail).toContain("haiku $0.31");
  });
  test("fable counts as a big family too", () => {
    const only1m = { Search: { [FABLE]: { ...money(8, 3, { ...noTokens, input: 1_000_000 }), tools: { Glob: 3 } } } };
    expect(Math.round((only(fire("subagent-model", { bySubType: only1m })).usd) * 1e9) / 1e9).toBe(6);
  });
  test("a type that writes, calls an MCP tool or runs on sonnet is left alone", () => {
    expect(fire("subagent-model", { bySubType: sub(OPUS, { Read: 5, Edit: 1 }) })).toEqual([]);
    expect(fire("subagent-model", { bySubType: sub(OPUS, { Read: 5, mcp__x__y: 1 }) })).toEqual([]);
    expect(fire("subagent-model", { bySubType: sub(SONNET, { Read: 5 }, 5.25) })).toEqual([]);
  });
  test("a type with no tool calls at all is trivially read-only and fires", () => {
    const h = only(fire("subagent-model", { bySubType: sub(OPUS, {}) }));
    expect(Math.round(h.usd * 1e9) / 1e9).toBe(5.25);
    expect(h.evidence.map((e) => e.label)).toEqual(["Explore"]);
  });
  test("a type that calls only hand-back tools counts as having no tool calls and fires", () => {
    expect(fire("subagent-model", { bySubType: sub(OPUS, { SubagentHandback: 2 }) }).length).toBe(1);
  });
  test("the catch-all unknown type is skipped", () => {
    expect(fire("subagent-model", { bySubType: { unknown: sub(OPUS, { Read: 5 }).Explore } })).toEqual([]);
  });
  test("hand-back tools do not count against a type", () => {
    expect(fire("subagent-model", { bySubType: sub(OPUS, { Read: 2, SubagentHandback: 1 }) }).length).toBe(1);
  });
});

describe("unused-plugin", () => {
  test("an unused plugin costs its tokens on every main request: 5000 * 100 * 0.2 / 1e6", () => {
    const h = only(fire("unused-plugin", HUNDRED, { plugins: [plugin("a", 5000, false), plugin("b", 3000, true), plugin("c", 0, false)] }));
    expect(Math.round((h.usd) * 1e9) / 1e9).toBe(0.1);
    expect(h.evidence.map((e) => e.label)).toEqual(["a"]);
    expect(h.evidence[0]!.detail).toContain("5k tokens per request");
  });
  test("stays quiet when every plugin is used or carries no tokens, or the span has no requests", () => {
    expect(fire("unused-plugin", HUNDRED, { plugins: [plugin("b", 3000, true), plugin("c", 0, false)] })).toEqual([]);
    expect(fire("unused-plugin", {}, { plugins: [plugin("a", 5000, false)] })).toEqual([]);
  });
  test("sub-agent requests carry no plugin listings, so only main requests count", () => {
    const summary = { byModel: { [OPUS]: money(0, 100) }, bySubType: { T: { [OPUS]: { ...money(0, 60), tools: {} } } }, main: money(0, 40) };
    expect(Math.round((only(fire("unused-plugin", summary, { plugins: [plugin("a", 5000, false)] })).usd) * 1e9) / 1e9).toBe(0.04);
  });
});

describe("long-session", () => {
  test("fires when a peak passes 70 percent on a 1M window", () => {
    const h = only(fire("long-session", { peakContext: { s1: 700_001 } }));
    expect(h.usd).toBe(0);
    expect(h.evidence[0]!.detail).toContain("700k");
  });
  test("stays quiet at 70 percent", () => {
    expect(fire("long-session", { peakContext: { s1: 700_000 } })).toEqual([]);
  });
  test("the window comes from the input when it is known", () => {
    expect(fire("long-session", { peakContext: { s1: 140_001 } }, { window: 200_000 }).length).toBe(1);
    expect(fire("long-session", { peakContext: { s1: 140_000 } }, { window: 200_000 })).toEqual([]);
  });
  test("a titled session shows its title before the peak row", () => {
    const top = { sessionId: "s1", repo: "r", started: 0, usd: 5, resume: "claude --resume s1", title: "Fix it" };
    const h = only(fire("long-session", { peakContext: { s1: 900_000, s2: 100 }, topSessions: [top, { ...top, sessionId: "s2", usd: 9 }] }));
    expect(h.usd).toBe(5);
    expect(h.evidence.map((e) => e.kind)).toEqual(["title", "text"]);
    expect(h.evidence[0]!.detail).toBe("Fix it");
  });
});

describe("costly-attribution", () => {
  const skills = (xs: number[]) => Object.fromEntries(xs.map((usd, i) => [`skill-${i}`, money(usd)]));
  test("a skill over 20 percent of the attributed spend fires, with its dollars", () => {
    const h = only(fire("costly-attribution", { bySkill: skills([21, 20, 20, 20, 19]) }));
    expect(h.usd).toBe(21);
    expect(h.evidence.map((e) => e.label)).toEqual(["Skill skill-0"]);
  });
  test("stays quiet when every entry is at or under 20 percent", () => {
    expect(fire("costly-attribution", { bySkill: skills([20, 20, 20, 20, 20]) })).toEqual([]);
    expect(fire("costly-attribution", {})).toEqual([]);
  });
  test("plugins are judged against plugin spend on their own, and the larger kind sets the amount", () => {
    const h = only(fire("costly-attribution", { bySkill: skills([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]), byPlugin: { p: money(30), q: money(70) } }));
    expect(h.usd).toBe(70);
    expect(h.evidence.map((e) => e.label)).toEqual(["Plugin q", "Plugin p"]);
  });
});

describe("whole-reads", () => {
  const flow = [item("read", "/w/a.ts", 3), item("read", "/w/b.ts", 9)];
  test("three full reads of a file fire; saving = cache-read cost of every copy but one", () => {
    const h = only(fire("whole-reads", { wholeReads: { "/w/a.ts": 3, "/w/b.ts": 2 }, flow }));
    expect(Math.round((h.usd) * 1e9) / 1e9).toBe(2);
    expect(h.projected).toBe(true);
    expect(h.evidence.map((e) => `${e.kind}|${e.detail}`)).toEqual(["path|/w/a.ts", "text|3 whole reads in one conversation"]);
  });
  test("title, summary, action and short carry the count only, never a path", () => {
    const h = only(fire("whole-reads", { wholeReads: { "/w/a.ts": 3, "/w/b.ts": 4 }, flow }));
    expect(h.short).toBe("2 files re-opened in full 3+ times");
    for (const text of [h.title, h.summary, h.action, h.short]) expect(text).not.toMatch(/a\.ts|b\.ts|\/w\//);
  });
  test("two whole reads are not enough", () => {
    expect(fire("whole-reads", { wholeReads: { "/w/a.ts": 2 }, flow })).toEqual([]);
  });
  test("a file outside the costliest parts still counts, with no amount", () => {
    expect(only(fire("whole-reads", { wholeReads: { "/w/z.ts": 4 }, flow })).usd).toBe(0);
  });
});

describe("command-output", () => {
  test("a command past 30 percent of all re-reading and at least 1 dollar fires", () => {
    const h = only(fire("command-output", { usage: usageOf(10), flow: [item("bash", "npm test", 3.5), item("bash", "ls", 0.5), item("read", "/w/a", 6)] }));
    expect(h.usd).toBe(3.5);
    expect(h.evidence.map((e) => `${e.kind}|${e.detail}`)).toEqual(["command|npm test", "text|35% of $10.00 re-read"]);
  });
  test("exactly 30 percent does not fire", () => {
    expect(fire("command-output", { usage: usageOf(10), flow: [item("bash", "npm test", 3)] })).toEqual([]);
  });
  test("under 1 dollar does not fire however large the share, and 1 dollar does", () => {
    expect(fire("command-output", { usage: usageOf(2), flow: [item("bash", "npm test", 0.99)] })).toEqual([]);
    expect(only(fire("command-output", { usage: usageOf(2), flow: [item("bash", "npm test", 1)] })).usd).toBe(1);
  });
  test("without usage figures the listed parts' re-read cost is the whole", () => {
    expect(only(fire("command-output", { flow: [item("bash", "make", 4), item("read", "/w/a", 6)] })).usd).toBe(4);
    expect(fire("command-output", { flow: [item("bash", "make", 3), item("read", "/w/a", 7)] })).toEqual([]);
  });
});

describe("tool-output", () => {
  test("a tool, MCP or read source over 30 percent and 1 dollar fires; bash is left to command-output", () => {
    const h = only(fire("tool-output", { usage: usageOf(10), flow: [item("mcp", "mcp__x__dump", 4), item("bash", "make", 5)] }));
    expect(h.usd).toBe(4);
    expect(h.evidence[0]!.detail).toBe("mcp__x__dump");
  });
  test("the advice follows the tool name, then the source, then a default", () => {
    const base = { usage: usageOf(10) };
    const adviceOf = (source: "read" | "mcp" | "tool", label: string) => only(fire("tool-output", { ...base, flow: [item(source, label, 5)] })).action;
    const cases: Array<["read" | "mcp" | "tool", string]> = [["read", "/w/big.ts"], ["mcp", "mcp__x__dump"], ["tool", "Notebook"], ["tool", "Grep"], ["tool", "Glob"], ["tool", "WebSearch"], ["tool", "WebFetch"], ["tool", "Agent"]];
    expect(new Set(cases.map(([s, l]) => adviceOf(s, l))).size).toBe(cases.length);
    expect(adviceOf("tool", "grep")).toBe(adviceOf("tool", "Grep"));
    expect(adviceOf("tool", "Task")).toBe(adviceOf("tool", "Agent"));
    expect(adviceOf("tool", "constructor")).toBe(adviceOf("tool", "Notebook"));
    expect(adviceOf("read", "/w/big.ts")).toContain("offset");
    expect(only(fire("tool-output", { ...base, flow: [item("read", "/w/big.ts", 5)] })).evidence[0]!.kind).toBe("path");
  });
  test("30 percent exactly, or under 1 dollar, stays quiet", () => {
    expect(fire("tool-output", { usage: usageOf(10), flow: [item("tool", "Grep", 3)] })).toEqual([]);
    expect(fire("tool-output", { usage: usageOf(1), flow: [item("tool", "Grep", 0.99)] })).toEqual([]);
  });
});

describe("thinking-output", () => {
  test("past 60 percent of output spend and at least 1 dollar fires; the amount is the thinking spend", () => {
    const h = only(fire("thinking-output", { usage: usageOf(0, [group("thinking", 6.01), group("reply", 3.99)]) }));
    expect(Math.round((h.usd) * 1e9) / 1e9).toBe(6.01);
    expect(h.evidence[0]!.detail).toBe("$6.01 of $10.00 output");
  });
  test("60 percent exactly stays quiet", () => {
    expect(fire("thinking-output", { usage: usageOf(0, [group("thinking", 6), group("reply", 4)]) })).toEqual([]);
  });
  test("under 1 dollar of thinking stays quiet, 1 dollar fires", () => {
    expect(fire("thinking-output", { usage: usageOf(0, [group("thinking", 0.9), group("reply", 0.1)]) })).toEqual([]);
    expect(only(fire("thinking-output", { usage: usageOf(0, [group("thinking", 1), group("reply", 0.5)]) })).usd).toBe(1);
  });
  test("without usage figures the rule has nothing to measure", () => {
    expect(fire("thinking-output", {})).toEqual([]);
  });
});

describe("fast-mode", () => {
  test("over 20 percent of the cost and at least 1 dollar fires; half of the fast cost is saved", () => {
    const h = only(fire("fast-mode", { fast: money(3), total: money(10) }));
    expect(h.usd).toBe(1.5);
    expect(h.projected).toBe(true);
    expect(h.metric).toEqual({ name: "fast share of cost", value: 0.3 });
  });
  test("20 percent exactly, or under 1 dollar, stays quiet", () => {
    expect(fire("fast-mode", { fast: money(2), total: money(10) })).toEqual([]);
    expect(fire("fast-mode", { fast: money(0.99), total: money(4) })).toEqual([]);
  });
  test("just over both lines fires", () => {
    expect(only(fire("fast-mode", { fast: money(1), total: money(4.9) })).usd).toBe(0.5);
  });
  test("the metric is the fast share, 0 with no cost", () => {
    expect(rule("fast-mode").metric?.(inputOf({ summary: summaryOf({ fast: money(1), total: money(4) }) }))).toBe(0.25);
    expect(rule("fast-mode").metric?.(inputOf())).toBe(0);
  });
});

describe("repeat-compaction", () => {
  test("three compactions in one session fire; the amount is what the flagged sessions cost", () => {
    const top = (sessionId: string, usd: number) => ({ sessionId, repo: "r", started: 0, usd, resume: "x" });
    const h = only(fire("repeat-compaction", { compactions: { s1: 3, s2: 2 }, topSessions: [top("s1", 7.5), top("s2", 4)] }));
    expect(h.usd).toBe(7.5);
    expect(h.evidence.map((e) => e.detail)).toEqual(["3 compactions"]);
  });
  test("twice is not enough", () => {
    expect(fire("repeat-compaction", { compactions: { s1: 2 } })).toEqual([]);
  });
});

describe("big-paste", () => {
  test("a prompt of 5000 tokens re-read for 1 dollar fires", () => {
    const h = only(fire("big-paste", { pastes: [paste(5000, 1), paste(4999, 9), paste(9000, 0.99)] }));
    expect(h.usd).toBe(1);
    expect(h.evidence.map((e) => e.detail)).toContain("5k tokens, $1.00 re-read");
  });
  test("under 5000 tokens, or under 1 dollar, stays quiet", () => {
    expect(fire("big-paste", { pastes: [paste(4999, 9)] })).toEqual([]);
    expect(fire("big-paste", { pastes: [paste(9000, 0.99)] })).toEqual([]);
  });
  test("pastes add up and name their session", () => {
    const top = { sessionId: "s1", repo: "r", started: 0, usd: 5, resume: "x", title: "Paste party" };
    const h = only(fire("big-paste", { pastes: [paste(6000, 2), paste(7000, 3)], topSessions: [top] }));
    expect(h.usd).toBe(5);
    expect(h.evidence.filter((e) => e.kind === "title").map((e) => e.detail)).toEqual(["Paste party", "Paste party"]);
  });
});

describe("unused-mcp-server", () => {
  const snaps = [snapOf({ mcp: { idle: { tokens: 3000, deferred: 1000 }, busy: { tokens: 4000, deferred: 0 }, lazy: { tokens: 800, deferred: 800 } } })];
  const used = { busy: { ...money(1), calls: 2 } };
  const live = { sessionId: "s1" } as never;
  test("a server with resident schemas and no calls costs its tokens on every main request: 2000 * 100 * 0.2 / 1e6", () => {
    const h = only(fire("unused-mcp-server", { ...HUNDRED, byMcp: used }, { snaps, live }));
    expect(Math.round((h.usd) * 1e9) / 1e9).toBe(0.04);
    expect(h.evidence.map((e) => e.label)).toEqual(["idle"]);
  });
  test("fires with no threshold at all, and says when the figure rests on another session's snapshot", () => {
    const h = only(fire("unused-mcp-server", { ...HUNDRED }, { live, snaps: [snapOf({ sessionId: "other", mcp: { idle: { tokens: 10, deferred: 0 } } })] }));
    expect(h.evidence.some((e) => e.label === "Estimate")).toBe(true);
  });
  test("quiet when every server was called or deferred, there is no snapshot, or no requests came in", () => {
    expect(fire("unused-mcp-server", { ...HUNDRED, byMcp: { ...used, idle: { ...money(0), calls: 1 } } }, { snaps })).toEqual([]);
    expect(fire("unused-mcp-server", HUNDRED, { snaps: [] })).toEqual([]);
    expect(fire("unused-mcp-server", {}, { snaps })).toEqual([]);
  });
  test("a server of a plugin already named unused is left to unused-plugin", () => {
    const s = [snapOf({ mcp: { plugin_foo_bar: { tokens: 1000, deferred: 0 }, solo: { tokens: 1000, deferred: 0 } } })];
    const h = only(fire("unused-mcp-server", HUNDRED, { live, snaps: s, plugins: [plugin("foo", 1000, false)] }));
    expect(h.evidence.map((e) => e.label)).toEqual(["solo"]);
  });
});

describe("ranking and shape", () => {
  test("hints from several rules come back costliest first", async () => {
    const input = inputOf({
      summary: summaryOf({ fast: money(3), total: money(10), cacheRebuilds: [rebuild(4)], peakContext: { s1: 900_000 } }),
      limits: { fiveHour: { percentUsed: 90, resetsAt: NOW + HOUR } },
    });
    const out = await runRules(HINT_RULES, input);
    // An urgent hint outranks every amount.
    expect(out.map((h) => h.rule)).toEqual(["near-limit", "cache-rebuilt", "fast-mode", "long-session"]);
    for (const h of out) {
      expect(Number.isFinite(h.usd) && h.usd >= 0).toBe(true);
      for (const text of [h.title, h.summary, h.action, h.short]) expect(text.length).toBeGreaterThan(0);
      for (const e of h.evidence) expect(["command", "path", "title", "text"]).toContain(e.kind);
    }
  });
});
