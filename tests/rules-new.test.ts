import { describe, expect, test } from "claude-code/testing";
import type { BreakdownSnapshot } from "../core/breakdown.ts";
import { drain, STEP_ROWS } from "../core/steps.ts";
import { ttlModelSteps } from "../core/cache-life.ts";
import type { TtlModel } from "../core/cache-life.ts";
import { analyzeFlow, HUGE_RESULT_MIN_TOKENS } from "../core/flow.ts";
import type { BigResult, CompactionEffect } from "../core/flow.ts";
import { HINT_RULES, runRules } from "../core/hint.ts";
import type { Hint, HintInput, HintRule } from "../core/hint.ts";
import { emptyLive } from "../core/live-state.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { BASELINE_RULES, NEW_RULES } from "../core/rules/index.ts";
import { summarize } from "../core/summary.ts";
import type { Summary, SubagentRuns } from "../core/summary.ts";
import type { Shard } from "../core/shard.ts";
import type { UsageRow } from "../core/types.ts";
import { NOW as MONTH_NOW, PRICES } from "./fixtures/month.ts";
import { MIN, READ_USD, T0, read, req, result, bash } from "./fixtures/rows.ts";

const NOW = Date.UTC(2026, 10, 27, 12);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const OPUS = "claude-opus-5-5";
const FABLE = "claude-fable-5-2";
const noTokens = { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 };
const money = (usd: number, requests = 1, tokens: Partial<typeof noTokens> = {}) => ({ usd, requests, tokens: { ...noTokens, ...tokens } });
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const NO_TTL: TtlModel = { requests: 0, actual: "5m", usd5m: 0, usd1h: 0, pauses: { short: 0, mid: 0, long: 0 } };
const NO_RUNS: SubagentRuns = { runs: 0, small: 0, smallStartupUsd: 0, byType: {} };
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
  hugeResults: [],
  cacheTtl: NO_TTL,
  subagentRuns: NO_RUNS,
  mainTools: {},
  ...over,
});
const inputOf = (over: Partial<HintInput> = {}): HintInput => ({ scope: "span", summary: summaryOf(), snaps: [], plugins: [], prices: BUILTIN_PRICES, nowMs: NOW, ...over });
const rule = (id: string): HintRule => {
  const r = NEW_RULES.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no rule ${id}`);
  return r;
};
const fire = (id: string, summary: Partial<Summary>, more: Partial<HintInput> = {}): Hint[] => rule(id).run(inputOf({ summary: summaryOf(summary), ...more }));
const fireAny = fire;
const only = (hints: Hint[]): Hint => {
  expect(hints.length).toBe(1);
  return hints[0]!;
};
const snapOf = (over: Partial<BreakdownSnapshot> = {}): BreakdownSnapshot => ({ sessionId: "s1", ts: NOW - HOUR, skills: {}, mcp: {}, agents: {}, memory: {}, system: 0, tools: 0, ...over });
const live = emptyLive("s1", NOW - DAY);
// 1000 main requests on opus 5.5 (cache read $0.2 per MTok): one resident token costs 1000 * 0.2 / 1e6 = 0.0002, so 5000 tokens cost $1.
const THOUSAND = { byModel: { [OPUS]: money(0, 1000) }, main: money(0, 1000) };

describe("rule registry", () => {
  test("13 new rules, 26 unique ids in the shipped registry", () => {
    expect(NEW_RULES.map((r) => r.id).sort()).toEqual([
      "cache-ttl-choice",
      "effort-max",
      "huge-tool-result",
      "idle-loop",
      "ineffective-compaction",
      "limit-pace",
      "long-prompt-tier",
      "main-model-overkill",
      "mcp-schema-heavy",
      "memory-heavy",
      "mid-session-switch",
      "skill-catalog-heavy",
      "subagent-overhead",
    ]);
    const ids = HINT_RULES.map((r) => r.id);
    expect(ids.length).toBe(26);
    expect(new Set(ids).size).toBe(26);
    expect(HINT_RULES).toEqual([...BASELINE_RULES, ...NEW_RULES]);
  });

  test("an empty span raises nothing from the new rules", async () => {
    for (const r of NEW_RULES) expect(r.run(inputOf())).toEqual([]);
    expect(await runRules(NEW_RULES, inputOf())).toEqual([]);
  });
});

describe("ineffective-compaction", () => {
  const effect = (over: Partial<CompactionEffect> = {}): CompactionEffect => ({
    sessionId: "s1",
    ts: NOW - HOUR,
    trigger: "manual",
    baseTokens: 80_000,
    preTokens: 300_000,
    postTokens: 270_000,
    requests: 40,
    savedTokens: 0,
    savedUsd: 0,
    keptTokens: 90_000,
    keptUsd: 1.5,
    ineffective: true,
    repeated: false,
    idleMs: 60_000,
    cold: false,
    ...over,
  });
  const stats = (ineffective: CompactionEffect[], count = 5): Summary["compaction"] => ({ count, savedTokens: 0, savedUsd: 0, bySession: {}, ineffective });

  test("flags compactions that left the context large; the amount is what they kept, re-read", () => {
    const h = only(fire("ineffective-compaction", { compaction: stats([effect(), effect({ sessionId: "s2", keptUsd: 0.5 })]) }));
    expect(h.rule).toBe("ineffective-compaction");
    expect(near(h.usd, 2)).toBe(true);
    expect(h.projected).toBeUndefined();
    expect(h.summary).toContain("2 of 5 compactions");
    expect(h.short).toBe("2 compactions left the context large");
    expect(h.evidence.filter((e) => e.label === "Compaction").map((e) => e.detail)).toEqual([
      "300k tokens before, 270k after; 86% of the 220k above the 80k fixed base left",
      "300k tokens before, 270k after; 86% of the 220k above the 80k fixed base left",
    ]);
    expect(h.summary).toContain("above the fixed opening part (system prompt, tools, memory, listings)");
    expect(h.summary).toContain("only compactions with 20k+ tokens above that base are judged");
  });

  test("the share is measured on what can be shed: 103k to 86k over an 80k base reads 26 percent, not 83", () => {
    const h = only(fire("ineffective-compaction", { compaction: stats([effect({ preTokens: 103_000, postTokens: 86_000, repeated: true, keptTokens: 0, keptUsd: 0 })], 3) }));
    expect(h.evidence.find((e) => e.label === "Compaction")!.detail).toBe("103k tokens before, 86k after; 26% of the 23k above the 80k fixed base left; compacted again after 40 requests");
  });

  test("a compaction followed by another within a few requests is flagged even when it shrank the context", () => {
    const h = only(fire("ineffective-compaction", { compaction: stats([effect({ postTokens: 50_000, keptTokens: 0, keptUsd: 0, requests: 2, repeated: true })], 3) }));
    expect(h.usd).toBe(0);
    expect(h.evidence.find((e) => e.label === "Compaction")!.detail).toBe("300k tokens before, 50k after; 0% of the 220k above the 80k fixed base left; compacted again after 2 requests");
  });

  test("a compaction that began after the cache expired is flagged with its idle time, and the action says to compact before stepping away", () => {
    const h = only(fire("ineffective-compaction", { compaction: stats([effect({ postTokens: 50_000, keptTokens: 0, keptUsd: 0, cold: true, idleMs: 2 * HOUR })], 3) }));
    expect(h.usd).toBe(0);
    expect(h.evidence.find((e) => e.label === "Compaction")!.detail).toBe("300k tokens before, 50k after; 0% of the 220k above the 80k fixed base left; began after 2h 00m idle, past the cache life");
    expect(h.summary).toContain("began after the cache had expired (1)");
    expect(h.action).toContain("before stepping away, not after");
  });

  test("quiet without compaction data or with none flagged; never tells anyone to compact less", () => {
    expect(fire("ineffective-compaction", {})).toEqual([]);
    expect(fire("ineffective-compaction", { compaction: stats([]) })).toEqual([]);
    const h = only(fire("ineffective-compaction", { compaction: stats([effect()]) }));
    for (const text of [h.title, h.summary, h.action, h.short]) expect(text).not.toMatch(/new session|avoid compact|fewer compact|too many|repeated/i);
    expect(h.action).toContain("task boundary");
  });

  test("each session shows its short id and repo (never a bare label), then its title when it has one, and the list is capped", () => {
    const top = { sessionId: "s1", repo: "r", started: 0, usd: 5, resume: "claude --resume s1", title: "Fix it" };
    const many = Array.from({ length: 9 }, (_, i) => effect({ sessionId: `s${i}` }));
    const h = only(fire("ineffective-compaction", { compaction: stats(many, 20), topSessions: [top] }));
    const at = h.evidence.findIndex((e) => e.kind === "title");
    expect(h.evidence[at]).toEqual({ label: "Title", detail: "Fix it", kind: "title" });
    expect(h.evidence[at - 1]).toEqual({ label: "Session", detail: "s1 (r)", kind: "text" });
    // The title sits right before its own compaction row.
    expect(h.evidence[at + 1]!.label).toBe("Compaction");
    // The costliest five: a Session row and a Compaction row each, plus the title row of the one that has a title.
    expect(h.evidence.length).toBe(11);
    // A session outside the costliest table has no repo to show: the short id alone.
    expect(h.evidence[0]).toEqual({ label: "Session", detail: "s0", kind: "text" });
    // Redacted, no row is left without a value except the title.
    expect(h.evidence.filter((e) => e.kind !== "title").every((e) => e.detail !== "")).toBe(true);
  });
});

describe("memory-heavy", () => {
  const memory = { "/p/CLAUDE.md": 3000, "/p/notes.md": 2000 };
  // 5000 tokens * 0.0002 = $1.00. The share is 1 / 19 = 5.26% of the span.
  test("1 dollar of memory over 5 percent of spend fires; the amount is the memory cost", () => {
    const h = only(fire("memory-heavy", { ...THOUSAND, total: money(19, 1000) }, { live, snaps: [snapOf({ memory })] }));
    expect(h.rule).toBe("memory-heavy");
    expect(near(h.usd, 1)).toBe(true);
    expect(h.projected).toBeUndefined();
    expect(h.urgent).toBeUndefined();
    expect(h.short).toBe("memory files cost $1.00");
    // Costliest file first: 3000 tokens = $0.60.
    expect(h.evidence[0]).toEqual({ label: "Memory file", detail: "/p/CLAUDE.md", kind: "path" });
    expect(h.evidence[1]).toEqual({ label: "Per request", detail: "3k tokens, 60\u00a2 over the span", kind: "text" });
    for (const text of [h.title, h.summary, h.action, h.short]) expect(text).not.toContain("/p/");
  });
  test("5 percent of spend exactly stays quiet (20 dollars total)", () => {
    expect(fire("memory-heavy", { ...THOUSAND, total: money(20, 1000) }, { live, snaps: [snapOf({ memory })] })).toEqual([]);
  });
  test("just under 1 dollar stays quiet: 4999 tokens = $0.9998", () => {
    expect(fire("memory-heavy", { ...THOUSAND, total: money(10, 1000) }, { live, snaps: [snapOf({ memory: { "/p/CLAUDE.md": 4999 } })] })).toEqual([]);
  });
  test("a snapshot from another session says the figure is an estimate; no snapshot or no requests is quiet", () => {
    const h = only(fire("memory-heavy", { ...THOUSAND, total: money(10, 1000) }, { live, snaps: [snapOf({ sessionId: "other", memory })] }));
    expect(h.evidence.some((e) => e.label === "Estimate")).toBe(true);
    expect(fire("memory-heavy", { ...THOUSAND, total: money(10, 1000) }, { live })).toEqual([]);
    expect(fire("memory-heavy", {}, { live, snaps: [snapOf({ memory })] })).toEqual([]);
  });
});

describe("skill-catalog-heavy", () => {
  // 1000 main requests: one resident token costs $0.0002. Four skills of 3750 tokens cost 15000 * 0.0002 = $3.00, which is 3% of a $100 span.
  const skills = { alpha: 3750, beta: 3750, gamma: 3750, delta: 3750 };
  const span = (total: number, over: Partial<Summary> = {}): Partial<Summary> => ({ ...THOUSAND, total: money(total, 1000), ...over });
  const called = (...names: string[]) => Object.fromEntries(names.map((n) => [n, money(1)]));
  // A window wide enough that the 1% listing budget (100k tokens) is not what the figures below test.
  const fire = (id: string, s: Partial<Summary>, more: Partial<HintInput>) => fireAny(id, s, { window: 10_000_000, ...more });
  test("the listing counts only up to 1% of the window: 15000 tokens on a 1M window (10000 budget) cost $2.00, not $3.00, and say so", () => {
    const h = only(fireAny("skill-catalog-heavy", span(50, { bySkill: called("alpha") }), { live, snaps: [snapOf({ skills })] }));
    // 3 idle skills of 3750 tokens, scaled by 10000 / 15000: 3 * 3750 * (2/3) * $0.0002 = $1.50.
    expect(near(h.usd, 1.5)).toBe(true);
    expect(h.evidence.map((e) => e.label)).toContain("Listing budget");
    expect(h.action).toContain("skillOverrides");
    expect(h.action).toContain("/skill-doctor");
    expect(h.action).toContain("being dropped");
    // On a wide window the same listing is under its budget: no budget row.
    expect(only(fire("skill-catalog-heavy", span(50, { bySkill: called("alpha") }), { live, snaps: [snapOf({ skills })] })).evidence.map((e) => e.label)).not.toContain("Listing budget");
  });
  test("a 3 dollar catalog (6% of spend) with 1 of 4 skills called fires; the amount is the cost of the 3 unused: $2.25", () => {
    const h = only(fire("skill-catalog-heavy", span(50, { bySkill: called("alpha") }), { live, snaps: [snapOf({ skills })] }));
    expect(near(h.usd, 2.25)).toBe(true);
    expect(h.projected).toBeUndefined();
    expect(h.summary).toContain("1 of 4");
    expect(h.evidence.map((e) => e.label)).toEqual(["Never called", "Never called", "Never called"]);
    expect(h.evidence[0]!.detail).toBe("beta: 4k tokens, 75\u00a2");
  });
  test("half the skills called stays quiet; a plugin prefix on the called name still matches", () => {
    expect(fire("skill-catalog-heavy", span(50, { bySkill: called("alpha", "beta") }), { live, snaps: [snapOf({ skills })] })).toEqual([]);
    expect(fire("skill-catalog-heavy", span(50, { bySkill: called("pkg:alpha", "pkg:beta") }), { live, snaps: [snapOf({ skills })] })).toEqual([]);
    expect(only(fire("skill-catalog-heavy", span(50, { bySkill: called("pkg:alpha") }), { live, snaps: [snapOf({ skills })] })).summary).toContain("1 of 4");
  });
  test("over 3 percent of spend fires, exactly 3 percent stays quiet: $99 vs $100 total", () => {
    expect(only(fire("skill-catalog-heavy", span(99), { live, snaps: [snapOf({ skills })] })).rule).toBe("skill-catalog-heavy");
    expect(fire("skill-catalog-heavy", span(100), { live, snaps: [snapOf({ skills })] })).toEqual([]);
  });
  test("a catalog just under 1 dollar stays quiet however big its share: 4 * 1249 tokens = $0.9992 of a $10 span", () => {
    const small = { alpha: 1249, beta: 1249, gamma: 1249, delta: 1249 };
    expect(fire("skill-catalog-heavy", span(10), { live, snaps: [snapOf({ skills: small })] })).toEqual([]);
    expect(only(fire("skill-catalog-heavy", span(10), { live, snaps: [snapOf({ skills: { alpha: 1250, beta: 1250, gamma: 1250, delta: 1250 } })] })).rule).toBe("skill-catalog-heavy");
  });
  test("no skills, no snapshot or no spend is quiet", () => {
    expect(fire("skill-catalog-heavy", span(50), { live, snaps: [snapOf()] })).toEqual([]);
    expect(fire("skill-catalog-heavy", span(50), { live })).toEqual([]);
    expect(fire("skill-catalog-heavy", { ...THOUSAND }, { live, snaps: [snapOf({ skills })] })).toEqual([]);
  });
});

describe("mcp-schema-heavy", () => {
  const server = (tokens: number, deferred = 0) => snapOf({ mcp: { alpha: { tokens, deferred } } });
  const calls = (n: number) => ({ byMcp: { alpha: { ...money(0), calls: n } } });
  // 1000 main requests: one resident token costs $0.0002, so 5000 tokens cost $1.00; fewer than 1 call per 100 requests means under 10 calls.
  // `$100` spans put that server at 1% of spend; the share bar is 0.25%.
  const MAIN = { ...THOUSAND, total: money(100, 1000) };
  test("1 dollar of schemas (1% of spend) and 9 calls in 1000 requests fires", () => {
    const h = only(fire("mcp-schema-heavy", { ...MAIN, ...calls(9) }, { live, snaps: [server(5000)] }));
    expect(near(h.usd, 1)).toBe(true);
    expect(h.projected).toBeUndefined();
    expect(h.evidence[0]!.detail).toBe("alpha: 5k schema tokens, $1.00; 9 calls in 1000 requests");
    expect(h.short).toBe("1 MCP server with rarely used schemas");
  });
  test("10 calls in 1000 requests (1 per 100) stays quiet", () => {
    expect(fire("mcp-schema-heavy", { ...MAIN, ...calls(10) }, { live, snaps: [server(5000)] })).toEqual([]);
  });
  test("a server with no calls at all is left to unused-mcp-server", () => {
    expect(fire("mcp-schema-heavy", { ...MAIN, ...calls(0) }, { live, snaps: [server(5000)] })).toEqual([]);
    expect(fire("mcp-schema-heavy", { ...MAIN }, { live, snaps: [server(5000)] })).toEqual([]);
  });
  test("only the resident part counts: 6000 tokens with 1000 deferred fire, 4999 resident ($0.9998) stay quiet", () => {
    expect(near(only(fire("mcp-schema-heavy", { ...MAIN, ...calls(1) }, { live, snaps: [server(6000, 1000)] })).usd, 1)).toBe(true);
    expect(fire("mcp-schema-heavy", { ...MAIN, ...calls(1) }, { live, snaps: [server(5999, 1000)] })).toEqual([]);
  });
  test("over 0.25 percent of spend fires, exactly 0.25 percent stays quiet: $399 vs $400 total", () => {
    expect(only(fire("mcp-schema-heavy", { ...THOUSAND, total: money(399, 1000), ...calls(1) }, { live, snaps: [server(5000)] })).rule).toBe("mcp-schema-heavy");
    expect(fire("mcp-schema-heavy", { ...THOUSAND, total: money(400, 1000), ...calls(1) }, { live, snaps: [server(5000)] })).toEqual([]);
  });
  test("a span with no spend is quiet", () => {
    expect(fire("mcp-schema-heavy", { ...THOUSAND, ...calls(1) }, { live, snaps: [server(5000)] })).toEqual([]);
  });
  test("a tool a plugin registers itself (its wire name is the plugin's name) is no MCP server the user can defer: left out, a real server beside it stays", () => {
    const snap = snapOf({ mcp: { alpha: { tokens: 5000, deferred: 0 }, "my-plugin": { tokens: 50_000, deferred: 0 } } });
    const byMcp = { alpha: { ...money(0), calls: 5 }, "my-plugin": { ...money(0), calls: 3 } };
    const plugins = [{ name: "my-plugin", tokensPerRequest: 0, used: true }];
    const h = only(fire("mcp-schema-heavy", { ...MAIN, byMcp }, { live, snaps: [snap], plugins }));
    expect(h.evidence.map((e) => e.detail.split(":")[0])).toEqual(["alpha"]);
    expect(near(h.usd, 1)).toBe(true);
    // Without the plugin in the inventory the same name is judged as a server.
    expect(fire("mcp-schema-heavy", { ...MAIN, byMcp }, { live, snaps: [snap] })[0]!.evidence.length).toBe(2);
    // A plugin's shipped MCP server (plugin_<plugin>_<server>) is a real server.
    const shipped = snapOf({ mcp: { plugin_my_plugin_db: { tokens: 5000, deferred: 0 } } });
    expect(only(fire("mcp-schema-heavy", { ...MAIN, byMcp: { plugin_my_plugin_db: { ...money(0), calls: 5 } } }, { live, snaps: [shipped], plugins })).evidence.length).toBe(1);
  });
  test("a server that is called at all must cost 25 dollars per 30 days to carry: $20 over 30 days stays quiet, $25 fires; a shorter window scales the bar", () => {
    const month = { from: NOW - 30 * DAY, to: NOW };
    // 1000 main requests: 5000 resident tokens cost $1.
    const costly = (usd: number) => snapOf({ mcp: { alpha: { tokens: usd * 5000, deferred: 0 } } });
    const span = { ...THOUSAND, total: money(2000, 1000), ...month, ...calls(3) };
    expect(fire("mcp-schema-heavy", span, { live, snaps: [costly(24)] })).toEqual([]);
    expect(only(fire("mcp-schema-heavy", span, { live, snaps: [costly(25)] })).rule).toBe("mcp-schema-heavy");
    // A day is 1/30 of the bar: $0.83, floored at 1 dollar, so $1 fires.
    expect(only(fire("mcp-schema-heavy", { ...MAIN, ...calls(3) }, { live, snaps: [costly(1)] })).rule).toBe("mcp-schema-heavy");
  });
  test("each server is judged alone, and the amount sums the ones that fire", () => {
    const snap = snapOf({ mcp: { alpha: { tokens: 5000, deferred: 0 }, busy: { tokens: 10_000, deferred: 0 }, small: { tokens: 100, deferred: 0 } } });
    const byMcp = { alpha: { ...money(0), calls: 5 }, busy: { ...money(0), calls: 500 }, small: { ...money(0), calls: 1 } };
    const h = only(fire("mcp-schema-heavy", { ...MAIN, byMcp }, { live, snaps: [snap] }));
    expect(h.evidence.length).toBe(1);
    expect(near(h.usd, 1)).toBe(true);
  });
});

describe("huge-tool-result", () => {
  const big = (tokens: number, over: Partial<BigResult> = {}): BigResult => ({ sessionId: "s1", tool: "Read", source: "read", label: "/p/dump.log", tokens, rereadUsd: 1.5, ...over });
  // Spans of $1000: a $1.50 re-read is 0.15% of spend; the share bar is 0.05%.
  const total = { total: money(1000) };
  test("a result of 25000 tokens fires with its re-read cost", () => {
    const h = only(fire("huge-tool-result", { ...total, hugeResults: [big(25_000)], topSessions: [{ sessionId: "s1", repo: "r", title: "Private title", started: NOW, usd: 1, resume: "" }] }));
    expect(HUGE_RESULT_MIN_TOKENS).toBe(25_000);
    expect(h.usd).toBe(1.5);
    expect(h.projected).toBeUndefined();
    expect(h.evidence).toEqual([
      { label: "Session", detail: "s1 (r)", kind: "text" },
      { label: "Title", detail: "Private title", kind: "title" },
      { label: "File", detail: "/p/dump.log", kind: "path" },
      { label: "Size", detail: "25k tokens, $1.50 re-read", kind: "text" },
    ]);
    for (const text of [h.title, h.summary, h.action, h.short]) {
      expect(text).not.toContain("/p/");
      expect(text).not.toContain("Private");
    }
  });
  test("24999 tokens stays quiet", () => {
    expect(fire("huge-tool-result", { ...total, hugeResults: [big(24_999)] })).toEqual([]);
  });
  test("several results add up; a command and a plain tool get their own evidence kinds", () => {
    const h = only(
      fire("huge-tool-result", {
        ...total,
        hugeResults: [big(40_000, { tool: "Bash", source: "bash", label: "cat /p/dump.log", rereadUsd: 0.5 }), big(30_000, { tool: "Grep", source: "tool", label: "Grep", rereadUsd: 0.75 }), big(20_000)],
      }),
    );
    expect(near(h.usd, 1.25)).toBe(true);
    // Each result is named by its session (an id even when the session is outside the costliest table), then what it was.
    expect(h.evidence.map((e) => `${e.label}:${e.kind}`)).toEqual(["Session:text", "Tool:text", "Size:text", "Session:text", "Command:command", "Size:text"]);
  });
  test("results that re-read for under 1 dollar in all stay quiet: $0.99 vs $1.00", () => {
    const small = { total: money(100) };
    expect(fire("huge-tool-result", { ...small, hugeResults: [big(25_000, { rereadUsd: 0.99 })] })).toEqual([]);
    expect(fire("huge-tool-result", { ...small, hugeResults: [big(30_000, { rereadUsd: 0.5 }), big(30_000, { rereadUsd: 0.49 })] })).toEqual([]);
    expect(only(fire("huge-tool-result", { ...small, hugeResults: [big(30_000, { rereadUsd: 0.5 }), big(30_000, { rereadUsd: 0.5 })] })).usd).toBe(1);
  });
  test("over 0.05 percent of spend fires, exactly 0.05 percent stays quiet: $1.50 of $2999 vs $3000", () => {
    expect(only(fire("huge-tool-result", { total: money(2999), hugeResults: [big(25_000)] })).rule).toBe("huge-tool-result");
    expect(fire("huge-tool-result", { total: money(3000), hugeResults: [big(25_000)] })).toEqual([]);
  });
  test("a span with no spend is quiet", () => {
    expect(fire("huge-tool-result", { hugeResults: [big(25_000)] })).toEqual([]);
  });
});

describe("limit-pace", () => {
  const win = (percentUsed: number, resetsAt: number) => ({ percentUsed, resetsAt });
  const FIVE = 5 * HOUR;
  const SEVEN = 7 * DAY;
  // 5h window with 1h left: 4h elapsed. 80% is exactly the pace that ends at the reset; 81% runs out
  // after 4h * (100/81 - 1) = 0.938h = 56m, about 3m before the reset.
  test("a pace that fills the 5h window before its reset fires as an urgent alert with the projected time", () => {
    const h = only(rule("limit-pace").run(inputOf({ limits: { fiveHour: win(81, NOW + HOUR) } })));
    expect(h.usd).toBe(0);
    expect(h.urgent).toBe(true);
    expect(h.projected).toBeUndefined();
    expect(h.short).toBe("5h limit full in 56m");
    expect(h.summary).toContain("56m");
    expect(h.evidence).toEqual([{ label: "5-hour window", detail: "81% used, 4h 00m into the window; full in 56m, 3m before the reset", kind: "text" }]);
  });
  test("80 percent with 1h left reaches 100 percent exactly at the reset, so it stays quiet", () => {
    expect(rule("limit-pace").run(inputOf({ limits: { fiveHour: win(80, NOW + HOUR) } }))).toEqual([]);
  });
  // 7d window with 2d left: 5d elapsed. 71.43% is the break-even pace: 71% stays quiet, 72% runs out after 5d * 28/72 = 1.94d = 1d 22h.
  test("the 7d window is judged on its own length", () => {
    const h = only(rule("limit-pace").run(inputOf({ limits: { sevenDay: win(72, NOW + 2 * DAY) } })));
    expect(h.short).toBe("7d limit full in 1d 22h");
    expect(rule("limit-pace").run(inputOf({ limits: { sevenDay: win(71, NOW + 2 * DAY) } }))).toEqual([]);
  });
  // 7d window with 6.5d left: 12h elapsed, 80% used would be full in 3h. A week's first day is too noisy to read.
  test("the 7d window waits 24 hours before its pace is read; the 5h window has no such wait", () => {
    expect(rule("limit-pace").run(inputOf({ limits: { sevenDay: win(80, NOW + 6.5 * DAY) } }))).toEqual([]);
    expect(only(rule("limit-pace").run(inputOf({ limits: { sevenDay: win(80, NOW + 6 * DAY) } }))).short.startsWith("7d")).toBe(true);
  });
  test("the action names /usage-credits", () => {
    expect(only(rule("limit-pace").run(inputOf({ limits: { fiveHour: win(81, NOW + HOUR) } }))).action).toContain("/usage-credits");
  });
  test("with both windows on pace the earlier fill leads and both get a row", () => {
    const h = only(rule("limit-pace").run(inputOf({ limits: { fiveHour: win(81, NOW + HOUR), sevenDay: win(72, NOW + 2 * DAY) } })));
    expect(h.short.startsWith("5h")).toBe(true);
    expect(h.evidence.map((e) => e.label)).toEqual(["5-hour window", "7-day window"]);
  });
  // 30 minutes into the 5h window, 69% would be full in 13 minutes; under 70% used it stays quiet, at 70% it fires.
  test("under 70 percent used stays quiet however steep the pace", () => {
    expect(rule("limit-pace").run(inputOf({ limits: { fiveHour: win(69, NOW + 4.5 * HOUR) } }))).toEqual([]);
    expect(only(rule("limit-pace").run(inputOf({ limits: { fiveHour: win(70, NOW + 4.5 * HOUR) } }))).short).toBe("5h limit full in 12m");
  });
  test("a window just begun, one with no reset time, a stale one and a full one are skipped", () => {
    // 6 minutes into the 5h window is under 5 percent of it: too early to extrapolate.
    expect(rule("limit-pace").run(inputOf({ limits: { fiveHour: win(90, NOW + FIVE - 6 * MIN) } }))).toEqual([]);
    expect(rule("limit-pace").run(inputOf({ limits: { fiveHour: { percentUsed: 90 } } }))).toEqual([]);
    expect(rule("limit-pace").run(inputOf({ limits: { fiveHour: win(90, NOW - 1) } }))).toEqual([]);
    expect(rule("limit-pace").run(inputOf({ limits: { fiveHour: win(100, NOW + HOUR) } }))).toEqual([]);
    expect(rule("limit-pace").run(inputOf({ limits: { fiveHour: win(0, NOW + HOUR) } }))).toEqual([]);
    expect(rule("limit-pace").run(inputOf())).toEqual([]);
    // A reset further away than the window is long cannot be right.
    expect(rule("limit-pace").run(inputOf({ limits: { fiveHour: win(90, NOW + SEVEN) } }))).toEqual([]);
  });
});

describe("cache-ttl-choice", () => {
  const ttl = (over: Partial<TtlModel>): Partial<Summary> => ({ cacheTtl: { requests: 60, actual: "5m", usd5m: 10, usd1h: 8, pauses: { short: 30, mid: 25, long: 5 }, ...over } });
  test("on 5m with the 1h replay $2 (20%) cheaper fires; the saving is projected", () => {
    const h = only(fire("cache-ttl-choice", ttl({})));
    expect(h.usd).toBe(2);
    expect(h.projected).toBe(true);
    expect(h.short).toBe("1-hour cache would save $2.00");
    expect(h.evidence).toEqual([
      { label: "Pauses", detail: "30 under 5 minutes, 25 from 5 minutes to 1 hour, 5 over 1 hour", kind: "text" },
      { label: "5-minute cache", detail: "$10.00 replayed at list price", kind: "text" },
      { label: "1-hour cache", detail: "$8.00 replayed at list price", kind: "text" },
    ]);
    // The action names the setting for the lifetime to switch to.
    expect(h.action).toContain("promptCacheTtl");
    expect(h.action).toContain("1h");
    expect(h.summary).toContain("list-price equivalents");
  });
  test("the 5m advice names promptCacheTtl and FORCE_PROMPT_CACHING_5M", () => {
    const h = only(fire("cache-ttl-choice", ttl({ actual: "1h", usd5m: 8, usd1h: 10 })));
    expect(h.action).toContain("promptCacheTtl to 5m");
    expect(h.action).toContain("FORCE_PROMPT_CACHING_5M=1");
  });
  test("exactly $1 and exactly 10 percent fires; $0.99 or 9.9 percent stays quiet", () => {
    expect(near(only(fire("cache-ttl-choice", ttl({ usd5m: 10, usd1h: 9 }))).usd, 1)).toBe(true);
    expect(fire("cache-ttl-choice", ttl({ usd5m: 10, usd1h: 9.01 }))).toEqual([]);
    // $0.99 of $5 is 19.8 percent: only the dollar floor holds it back.
    expect(fire("cache-ttl-choice", ttl({ usd5m: 5, usd1h: 4.01 }))).toEqual([]);
    // $1.98 of $20 is 9.9 percent.
    expect(fire("cache-ttl-choice", ttl({ usd5m: 20, usd1h: 18.02 }))).toEqual([]);
  });
  test("on 1h with the 5m replay cheaper, it advises 5m; the cheaper current choice is quiet", () => {
    const h = only(fire("cache-ttl-choice", ttl({ actual: "1h", usd5m: 8, usd1h: 10 })));
    expect(h.short).toBe("5-minute cache would save $2.00");
    expect(fire("cache-ttl-choice", ttl({ actual: "5m", usd5m: 8, usd1h: 10 }))).toEqual([]);
    expect(fire("cache-ttl-choice", ttl({ actual: "1h", usd5m: 10, usd1h: 8 }))).toEqual([]);
  });
});

describe("subagent-overhead", () => {
  const runs = (over: Partial<SubagentRuns>): Partial<Summary> => ({
    subagentRuns: { runs: 10, small: 6, smallStartupUsd: 1.5, byType: { Explore: { runs: 7, small: 5, startupUsd: 1.2 }, helper: { runs: 3, small: 1, startupUsd: 0.3 } }, ...over },
  });
  test("6 of 10 small runs with $1.50 of startup fires; the amount is the startup cost", () => {
    const h = only(fire("subagent-overhead", runs({})));
    expect(h.usd).toBe(1.5);
    expect(h.projected).toBeUndefined();
    expect(h.summary).toContain("6 of 10");
    expect(h.summary).toContain("2 requests or fewer");
    expect(h.evidence).toEqual([
      { label: "Agent type", detail: "Explore: 5 of 7 runs with 2 requests or fewer and little tool output, $1.20 startup", kind: "text" },
      { label: "Agent type", detail: "helper: 1 of 3 runs with 2 requests or fewer and little tool output, 30\u00a2 startup", kind: "text" },
    ]);
    expect(h.action).toContain("raw output would be large");
  });
  test("exactly half the runs stays quiet", () => {
    expect(fire("subagent-overhead", runs({ small: 5 }))).toEqual([]);
  });
  test("$0.99 of startup stays quiet, $1.00 fires", () => {
    expect(fire("subagent-overhead", runs({ smallStartupUsd: 0.99 }))).toEqual([]);
    expect(only(fire("subagent-overhead", runs({ smallStartupUsd: 1 }))).usd).toBe(1);
    expect(fire("subagent-overhead", {})).toEqual([]);
  });
});

describe("main-model-overkill", () => {
  // Read-only requests: 100k output and 10M cache read. On opus 5.5 that is 100k*20 + 10M*0.2 = $4.00;
  // on sonnet 5.5 (out 10, cache read 0.1) it is $1 + $1 = $2.00, so $2.00 is saved.
  const onlyReading = { output: 100_000, cacheRead: 10_000_000 };
  const tools = (turns: number, reading: number, usd = 4, model = OPUS): Partial<Summary> => ({ mainTools: { [model]: { turns, readOnly: money(usd, reading, onlyReading) } } });
  test("61 of 100 tool turns read-only with $2 saved on sonnet fires; the saving is projected", () => {
    const h = only(fire("main-model-overkill", tools(100, 61)));
    expect(h.usd).toBe(2);
    expect(h.projected).toBe(true);
    expect(h.short).toBe("61% of flagship tool turns were read-only");
    expect(h.evidence).toEqual([{ label: "Model", detail: "opus-5-5: 61 of 100 tool turns read-only; $4.00 spent, $2.00 on sonnet", kind: "text" }]);
  });
  test("60 percent exactly stays quiet", () => {
    expect(fire("main-model-overkill", tools(100, 60))).toEqual([]);
  });
  // The declared spend decides the saving: $3.00 - $2.00 = $1.00 fires, $2.99 leaves $0.99.
  test("a saving of exactly $1 fires and $0.99 stays quiet", () => {
    expect(only(fire("main-model-overkill", tools(100, 61, 3))).usd).toBe(1);
    expect(fire("main-model-overkill", tools(100, 61, 2.99))).toEqual([]);
  });
  test("the suggestion is low confidence, and under 50 flagship tool turns it stays quiet", () => {
    const h = only(fire("main-model-overkill", tools(100, 61)));
    expect(h.confidence).toBe("low");
    expect(h.action).toContain("run /model sonnet");
    expect(h.action).toContain("opusplan");
    expect(h.action).toContain("uncached");
    expect(fire("main-model-overkill", tools(49, 40))).toEqual([]);
    expect(only(fire("main-model-overkill", tools(50, 40))).rule).toBe("main-model-overkill");
  });
  test("when fable and mythos carry most of the saving, the first step down is the default flagship", () => {
    expect(only(fire("main-model-overkill", tools(100, 61, 4, FABLE))).action).toContain("default flagship");
    expect(only(fire("main-model-overkill", tools(100, 61))).action).not.toContain("default flagship");
  });
  test("a Mythos model counts as flagship", () => {
    const h = only(fire("main-model-overkill", tools(100, 61, 4, "claude-mythos-5-2")));
    expect(h.summary).toContain("opus, fable and mythos models");
  });
  test("opus and fable pool their turns; a model already cheaper than sonnet and an unpriceable one add nothing", () => {
    const h = only(
      fire("main-model-overkill", {
        mainTools: {
          [OPUS]: { turns: 50, readOnly: money(4, 30, onlyReading) },
          [FABLE]: { turns: 50, readOnly: money(4, 31, onlyReading) },
          "claude-haiku-4-5": { turns: 400, readOnly: money(0.5, 400, { output: 10 }) },
        },
      }),
    );
    expect(h.evidence.length).toBe(2);
    expect(h.summary).toContain("61%");
    expect(fire("main-model-overkill", tools(100, 61, 4, "claude-haiku-4-5"))).toEqual([]);
    expect(fire("main-model-overkill", {})).toEqual([]);
  });
});

describe("ranking", () => {
  test("limit-pace is urgent and leads; the amounts of the others follow costliest first", async () => {
    const out = await runRules(
      NEW_RULES,
      inputOf({
        summary: summaryOf({ cacheTtl: { ...NO_TTL, requests: 10, usd5m: 10, usd1h: 7 }, subagentRuns: { runs: 10, small: 8, smallStartupUsd: 1.5, byType: {} } }),
        limits: { fiveHour: { percentUsed: 81, resetsAt: NOW + HOUR } },
      }),
    );
    expect(out.map((h) => h.rule)).toEqual(["limit-pace", "cache-ttl-choice", "subagent-overhead"]);
    for (const h of out) {
      for (const text of [h.title, h.summary, h.action, h.short]) expect(text.length).toBeGreaterThan(0);
      for (const e of h.evidence) expect(["command", "path", "title", "text"]).toContain(e.kind);
    }
  });
});

// Scan figures the rules read.
const shardOf = (usage: UsageRow[]): Shard => ({ v: 1, project: "p", files: {}, usage, users: [], metas: [], compacts: [], snapshots: [] });
const run30d = (usage: UsageRow[]): Summary => summarize([shardOf(usage)], PRICES, { span: "30d", nowMs: MONTH_NOW, tzOffsetMin: 0 });
const run30dWith = (usage: UsageRow[], users: Shard["users"]): Summary => summarize([{ ...shardOf(usage), users }], PRICES, { span: "30d", nowMs: MONTH_NOW, tzOffsetMin: 0 });
const sub = (id: string, at: number, agentId: string, agentType: string, tokens: Partial<typeof noTokens>): UsageRow => req({ id, at, sidechain: true, agentId, agentType, tokens });

describe("bigResults (flow)", () => {
  // Request a opens with 10000 tokens; the result (4 chars per token) arrives before b, whose prompt grew by exactly its size; c re-reads it.
  const story = (resultTokens: number, counted: (r: UsageRow) => boolean = () => true) => {
    const rows = [
      req({ id: "a", at: 1, tokens: { input: 10_000 }, tools: [read("t1", "/p/big.log")] }),
      req({ id: "b", at: 5, tokens: { cacheRead: 10_000, input: resultTokens } }),
      req({ id: "c", at: 6, tokens: { cacheRead: 10_000 + resultTokens } }),
    ];
    return analyzeFlow({ rows, users: [result(2, "t1", resultTokens * 4)], compacts: [], counted, cacheReadUsd: () => READ_USD });
  };
  test("a result of 25000 tokens is listed with its tool, label and the cost of c re-reading it (25000 * $1/MTok = $0.025)", () => {
    const out = story(25_000);
    expect(out.bigResults.length).toBe(1);
    expect(out.bigResults[0]).toMatchObject({ sessionId: "s", tool: "Read", source: "read", label: "/p/big.log", tokens: 25_000 });
    expect(near(out.bigResults[0]!.rereadUsd, 25_000 * READ_USD)).toBe(true);
  });
  test("24999 tokens, an uncounted request, a prompt and a command's result of other size are not listed or are labelled right", () => {
    expect(story(24_999).bigResults).toEqual([]);
    expect(story(25_000, (r) => r.requestId !== "a" && r.requestId !== "b").bigResults).toEqual([]);
    const rows = [req({ id: "a", at: 1, tokens: { input: 10_000 } }), req({ id: "b", at: 5, tokens: { cacheRead: 10_000, input: 30_000 } })];
    const prompts = analyzeFlow({ rows, users: [{ sessionId: "s", ts: rows[0]!.ts - 1, kind: "prompt", chars: 120_000, text: "huge prompt" }], compacts: [], counted: () => true, cacheReadUsd: () => READ_USD });
    expect(prompts.bigResults).toEqual([]);
    const bashRows = [req({ id: "a", at: 1, tokens: { input: 10_000 }, tools: [bash("t1", "cat /p/x")] }), req({ id: "b", at: 5, tokens: { cacheRead: 10_000, input: 30_000 } })];
    const b = analyzeFlow({ rows: bashRows, users: [result(2, "t1", 120_000)], compacts: [], counted: () => true, cacheReadUsd: () => READ_USD });
    expect(b.bigResults.map((x) => [x.tool, x.source, x.label])).toEqual([["Bash", "bash", "cat /p/x"]]);
  });
  test("the summary carries them", () => {
    const rows = [
      req({ id: "a", at: 1, tokens: { input: 10_000 }, tools: [read("t1", "/p/big.log")] }),
      req({ id: "b", at: 5, tokens: { cacheRead: 10_000, input: 25_000 } }),
    ];
    const s = summarize([{ ...shardOf(rows), users: [result(2, "t1", 100_000)] }], PRICES, { span: "30d", nowMs: MONTH_NOW, tzOffsetMin: 0 });
    expect(s.hugeResults.map((x) => x.label)).toEqual(["/p/big.log"]);
  });
});

describe("ttl model (cache-life)", () => {
  const unit = () => ({ read: 1e-6, cw5m: 12.5e-6, cw1h: 20e-6 });
  const rowsOf = (): UsageRow[] => [
    req({ id: "r0", at: 0, tokens: { cw5m: 100_000 } }),
    req({ id: "r1", at: 2 * MIN, tokens: { cacheRead: 100_000, cw5m: 10_000 } }),
    req({ id: "r2", at: 12 * MIN, tokens: { cw5m: 120_000 } }),
    req({ id: "r3", at: 100 * MIN, tokens: { cw5m: 130_000 } }),
    req({ id: "r4", at: 101 * MIN, tokens: { cw5m: 20_000 } }),
  ];
  // Cached prompt C and its growth D per request after the first, then each request priced at read 1, 5m write 12.5, 1h write 20 ($/MTok):
  //   r1 C 110k D 10k, 2m pause (short): 5m 100k*1 + 10k*12.5 = 0.225      1h 100k*1 + 10k*20 = 0.30
  //   r2 C 120k D 10k, 10m (mid):        5m rebuild 120k*12.5   = 1.50       1h 110k*1 + 10k*20 = 0.31
  //   r3 C 130k D 10k, 88m (long):       5m rebuild 130k*12.5   = 1.625      1h rebuild 130k*20  = 2.60
  //   r4 C 20k < 130k so D = C, 1m:      5m 20k*12.5            = 0.25       1h 20k*20           = 0.40
  // Totals: 5m 3.60, 1h 3.61. The writes are all 5m ones, so that is the cache in use.
  test("replays the pauses at both lifetimes", () => {
    const m = drain(ttlModelSteps(rowsOf(), () => true, unit));
    expect(m.requests).toBe(4);
    expect(m.pauses).toEqual({ short: 2, mid: 1, long: 1 });
    expect(m.actual).toBe("5m");
    expect(near(m.usd5m, 3.6)).toBe(true);
    expect(near(m.usd1h, 3.61)).toBe(true);
  });
  test("pauses of exactly 5 minutes and 1 hour still count as inside", () => {
    const rows = [req({ id: "a", at: 0, tokens: { cw5m: 1000 } }), req({ id: "b", at: 5 * MIN, tokens: { cw5m: 2000 } }), req({ id: "c", at: 65 * MIN, tokens: { cw5m: 3000 } })];
    expect(drain(ttlModelSteps(rows, () => true, unit)).pauses).toEqual({ short: 1, mid: 1, long: 0 });
  });
  test("sub-agent rows are ignored, an uncounted request still sets the pause, and 1h writes name the 1h cache", () => {
    const rows = [
      req({ id: "a", at: 0, tokens: { cw1h: 50_000 } }),
      sub("x", 1 * MIN, "ag", "Explore", { cw1h: 50_000 }),
      req({ id: "b", at: 2 * MIN, tokens: { cacheRead: 50_000, cw1h: 10_000 } }),
      req({ id: "c", at: 3 * MIN, tokens: { cacheRead: 60_000, cw1h: 5_000 } }),
    ];
    const m = drain(ttlModelSteps(rows, (r) => r.requestId === "c", unit));
    // Only c is counted; its predecessor is b (not x): a 1m pause, C 65k, D 5k.
    expect(m.requests).toBe(1);
    expect(m.pauses).toEqual({ short: 1, mid: 0, long: 0 });
    expect(m.actual).toBe("1h");
    expect(near(m.usd5m, 60_000 * 1e-6 + 5_000 * 12.5e-6)).toBe(true);
    expect(near(m.usd1h, 60_000 * 1e-6 + 5_000 * 20e-6)).toBe(true);
  });
  test("no rows give an all-zero model on the 5m cache", () => {
    expect(drain(ttlModelSteps([], () => true, unit))).toEqual({ requests: 0, actual: "5m", usd5m: 0, usd1h: 0, pauses: { short: 0, mid: 0, long: 0 } });
  });
  test("yields during the pass instead of running it in one step", () => {
    const rows: UsageRow[] = [];
    for (let i = 0; i < 2 * STEP_ROWS + 10; i++) rows.push(req({ id: `r${i}`, at: i * 1000, tokens: { cacheRead: 1000 + i } }));
    const g = ttlModelSteps(rows, () => true, unit);
    let yields = 0;
    for (let r = g.next(); r.done !== true; r = g.next()) yields++;
    expect(yields).toBeGreaterThanOrEqual(2);
  });
  test("the summary carries the model", () => {
    const s = run30d(rowsOf());
    expect(s.cacheTtl.pauses).toEqual({ short: 2, mid: 1, long: 1 });
    expect(s.cacheTtl.requests).toBe(4);
  });
});

describe("subagentRuns and mainTools (summary)", () => {
  // Opus in the test prices: input $10, output $50, cache read $1, 5m write $12.5 per MTok.
  const agents = (): UsageRow[] => [
    // Explore a1: two requests and no tool results (small). The first one's startup: 1000*10 + 100k*1 + 20k*12.5 = $0.01 + $0.10 + $0.25 = $0.36.
    sub("a1-1", 1 * MIN, "a1", "Explore", { input: 1000, cacheRead: 100_000, cw5m: 20_000, output: 100 }),
    sub("a1-2", 2 * MIN, "a1", "Explore", { cacheRead: 120_000, output: 150 }),
    // Explore a2: one request but 20000 chars of tool results is not small, however short its answer.
    sub("a2-1", 3 * MIN, "a2", "Explore", { cacheRead: 50_000, output: 5 }),
    // helper a3: one request, a long answer (output size does not matter), startup 200k cache read = $0.20.
    sub("a3-1", 4 * MIN, "a3", "helper", { cacheRead: 200_000, output: 9000 }),
    // Explore a4: three requests is not small.
    sub("a4-1", 5 * MIN, "a4", "Explore", { cacheRead: 10_000, output: 5 }),
    sub("a4-2", 6 * MIN, "a4", "Explore", { cacheRead: 10_000, output: 5 }),
    sub("a4-3", 7 * MIN, "a4", "Explore", { cacheRead: 10_000, output: 5 }),
    req({ id: "m1", at: 8 * MIN, tokens: { cacheRead: 1_000_000, output: 90_000 } }),
  ];
  const agentResults = (): Shard["users"] => [{ sessionId: "s", ts: T0 + 3 * MIN + 1, kind: "toolResult", chars: 20_000, sidechain: true, agentId: "a2" }];
  test("runs are counted per sub-agent transcript; small ones made 2 requests or fewer with under 20000 chars of tool results, and their startup is summed", () => {
    const s = run30dWith(agents(), agentResults());
    expect(s.subagentRuns.runs).toBe(4);
    expect(s.subagentRuns.small).toBe(2);
    expect(near(s.subagentRuns.smallStartupUsd, 0.56)).toBe(true);
    expect(s.subagentRuns.byType.Explore!.runs).toBe(3);
    expect(s.subagentRuns.byType.Explore!.small).toBe(1);
    expect(near(s.subagentRuns.byType.Explore!.startupUsd, 0.36)).toBe(true);
    expect(s.subagentRuns.byType.helper).toMatchObject({ runs: 1, small: 1 });
    expect(near(s.subagentRuns.byType.helper!.startupUsd, 0.2)).toBe(true);
    // 19999 chars stays small.
    expect(run30dWith(agents(), [{ ...agentResults()[0]!, chars: 19_999 }]).subagentRuns.small).toBe(3);
  });
  test("a sub-agent row with no type reads as unknown, and no sub-agents give zeros", () => {
    const s = run30d([req({ id: "x", at: 1, sidechain: true, agentId: "q", tokens: { cacheRead: 1000, output: 5 } })]);
    expect(Object.keys(s.subagentRuns.byType)).toEqual(["unknown"]);
    expect(run30d([req({ id: "m", at: 1, tokens: { cacheRead: 1000 } })]).subagentRuns).toEqual(NO_RUNS);
  });
  test("mainTools counts main-thread tool turns per model and the read-only ones with their tokens and spend", () => {
    const t = (name: string) => ({ name, inputChars: 1 });
    const mcp = { name: "mcp__x__y", mcpServer: "x", inputChars: 1 };
    const s = run30d([
      req({ id: "r1", at: 1 * MIN, tokens: { input: 100_000 }, tools: [t("Read")] }),
      req({ id: "r2", at: 2 * MIN, tokens: { input: 100_000 }, tools: [t("Read"), t("Grep")] }),
      req({ id: "r3", at: 3 * MIN, tokens: { input: 100_000 }, tools: [t("Read"), t("Bash")] }),
      req({ id: "r4", at: 4 * MIN, tokens: { input: 100_000 } }),
      req({ id: "r5", at: 5 * MIN, tokens: { input: 100_000 }, tools: [mcp] }),
      { ...req({ id: "r6", at: 6 * MIN, tokens: { input: 100_000 }, tools: [t("Read")] }), model: "claude-sonnet-5-5" },
      sub("s1", 7 * MIN, "ag", "Explore", { input: 100_000 }),
    ]);
    // Opus: r1, r2, r3 and r5 called tools (4 turns); r1 and r2 only read: 2 requests of 100k input at $10/MTok = $2.00.
    expect(s.mainTools[OPUS]!.turns).toBe(4);
    expect(s.mainTools[OPUS]!.readOnly.requests).toBe(2);
    expect(s.mainTools[OPUS]!.readOnly.tokens.input).toBe(200_000);
    expect(near(s.mainTools[OPUS]!.readOnly.usd, 2)).toBe(true);
    expect(s.mainTools["claude-sonnet-5-5"]).toMatchObject({ turns: 1 });
    expect(s.mainTools["claude-sonnet-5-5"]!.readOnly.requests).toBe(1);
  });
  test("an empty summary has the new dimensions empty", () => {
    const s = summarize([], PRICES, { span: "30d", nowMs: MONTH_NOW, tzOffsetMin: 0 });
    expect([s.hugeResults, s.mainTools]).toEqual([[], {}]);
    expect(s.subagentRuns).toEqual(NO_RUNS);
    expect(s.cacheTtl).toEqual(NO_TTL);
    expect([s.cacheBreaks, s.loops, s.longPrompts]).toEqual([[], { ticks: 0, light: 0, lightUsd: 0, lightPromptTokens: 0, sessions: 0 }, {}]);
  });
});

describe("cacheBreaks (summary)", () => {
  // Opus in the test prices: cache read $1, 5m write $12.5 per MTok, so rewriting 100k tokens costs 100k * 11.5 / 1e6 = $1.15 over reading them.
  const warm = req({ id: "p", at: 1 * MIN, tokens: { cacheRead: 100_000 } });
  const after = (over: Partial<UsageRow>, tokens: Partial<typeof noTokens> = { cw5m: 100_000 }, at = 2 * MIN): UsageRow => ({ ...req({ id: "r", at, tokens }), ...over });
  test("a model change followed by a rewrite within the cache life is a break, priced over a warm read", () => {
    const [b, ...rest] = run30d([warm, after({ model: "claude-sonnet-5-5" })]).cacheBreaks!;
    expect(rest).toEqual([]);
    expect(b).toMatchObject({ kind: "model", from: OPUS, to: "claude-sonnet-5-5", tokens: 100_000 });
    // Priced at the request's own model (sonnet 5m write 2.5, read 0.2).
    expect(near(b!.usd, (100_000 * (2.5 - 0.2)) / 1e6)).toBe(true);
  });
  test("a speed change and an effort change are breaks too; the model decides first", () => {
    expect(run30d([warm, after({ fast: true })]).cacheBreaks![0]).toMatchObject({ kind: "fast", from: "standard", to: "fast" });
    expect(run30d([{ ...warm, effort: "high" }, after({ effort: "low" })]).cacheBreaks![0]).toMatchObject({ kind: "effort", from: "high", to: "low" });
    expect(run30d([warm, after({ model: "claude-sonnet-5-5", fast: true })]).cacheBreaks![0]!.kind).toBe("model");
  });
  test("no change, no rewrite, a pause past the cache life, growth alone and sub-agent rows are not breaks", () => {
    expect(run30d([warm, after({})]).cacheBreaks).toEqual([]);
    expect(run30d([warm, after({ fast: true }, { cacheRead: 100_000 })]).cacheBreaks).toEqual([]);
    expect(run30d([warm, after({ fast: true }, { cw5m: 100_000 }, 7 * MIN)]).cacheBreaks).toEqual([]);
    // 25000 written on a prompt that grew by 25000: nothing was rewritten.
    expect(run30d([warm, after({ fast: true }, { cacheRead: 100_000, cw5m: 25_000 })]).cacheBreaks).toEqual([]);
    expect(run30d([{ ...warm, sidechain: true, agentId: "a" }, { ...after({ fast: true }), sidechain: true, agentId: "a" }]).cacheBreaks).toEqual([]);
  });
  test("what grew with the switch is not counted as rewritten: 130000 written on a prompt 30000 larger is 100000", () => {
    expect(run30d([warm, after({ fast: true }, { cw5m: 130_000 })]).cacheBreaks![0]!.tokens).toBe(100_000);
  });
});

describe("mid-session-switch", () => {
  const brk = (usd: number, kind: "model" | "fast" | "effort" = "model", at = NOW - HOUR) => ({ sessionId: "s1", ts: at, kind, from: kind === "model" ? OPUS : "a", to: kind === "model" ? "claude-sonnet-5-5" : "b", tokens: 100_000, usd });
  test("1 dollar over a warm read fires; the amount is their sum", () => {
    const h = only(fire("mid-session-switch", { cacheBreaks: [brk(0.5), brk(0.5, "fast")] }));
    expect(h.usd).toBe(1);
    expect(h.projected).toBeUndefined();
    expect(h.summary).toContain("1 of model, 1 of speed");
    expect(h.action).toContain("start of a session");
    expect(h.evidence[0]!.label).toBe("Switch of model");
    expect(h.evidence[0]!.detail).toContain("opus-5-5 to sonnet-5-5");
  });
  test("under 1 dollar or no breaks stays quiet", () => {
    expect(fire("mid-session-switch", { cacheBreaks: [brk(0.99)] })).toEqual([]);
    expect(fire("mid-session-switch", { cacheBreaks: [] })).toEqual([]);
    expect(fire("mid-session-switch", {})).toEqual([]);
  });
  test("the list is capped at five rows, costliest first", () => {
    const h = only(fire("mid-session-switch", { cacheBreaks: [1, 2, 3, 4, 5, 6, 7].map((n) => brk(n)) }));
    expect(h.evidence.length).toBe(5);
    expect(h.evidence[0]!.detail).toContain("$7.00");
  });
});

describe("effort-max", () => {
  const efforts = (max: [number, number], high: [number, number]): Partial<Summary> => ({ byEffort: { max: money(max[0], max[1]), high: money(high[0], high[1]) } });
  test("over half of the requests at max and 5 dollars fires; the amount is the max spend and the metric the share", () => {
    const h = only(fire("effort-max", efforts([6, 60], [2, 40])));
    expect(h.usd).toBe(6);
    expect(h.action).toContain("run /effort high");
    expect(h.metric).toEqual({ name: "max-effort share of requests", value: 0.6 });
    expect(rule("effort-max").metric?.(inputOf({ summary: summaryOf(efforts([6, 60], [2, 40])) }))).toBe(0.6);
  });
  test("exactly half, under 5 dollars or no effort figures stays quiet", () => {
    expect(fire("effort-max", efforts([6, 50], [2, 50]))).toEqual([]);
    expect(fire("effort-max", efforts([4.99, 60], [2, 40]))).toEqual([]);
    expect(only(fire("effort-max", efforts([5, 60], [2, 40]))).usd).toBe(5);
    expect(fire("effort-max", {})).toEqual([]);
    expect(rule("effort-max").metric?.(inputOf())).toBe(0);
  });
});

describe("long-prompt-tier", () => {
  const lp = (extraUsd: number, over: Partial<{ requests: number; subRequests: number; sessions: number }> = {}) => ({ longPrompts: { "claude-haiku-5-5": { requests: 4, subRequests: 3, sessions: 2, extraUsd, ...over } } });
  test("a dollar added by the tier fires, naming the threshold from the price table", () => {
    const h = only(fire("long-prompt-tier", lp(1.5)));
    expect(h.usd).toBe(1.5);
    expect(h.projected).toBeUndefined();
    expect(h.evidence[0]!.detail).toBe("haiku-5-5: 4 requests over 100k tokens (3 from sub-agents) in 2 sessions, $1.50 above the base rates");
    expect(h.action).toContain("run /compact");
  });
  test("under a dollar, or nothing over the tier, stays quiet", () => {
    expect(fire("long-prompt-tier", lp(0.99))).toEqual([]);
    expect(fire("long-prompt-tier", {})).toEqual([]);
    expect(fire("long-prompt-tier", { longPrompts: {} })).toEqual([]);
  });
  test("summary counts requests past a model's threshold with the extra they billed: 200000 input at 4x the 0.10 base is $0.08", () => {
    const haiku = (id: string, input: number, extra: Partial<UsageRow> = {}): UsageRow => ({ ...req({ id, at: MIN, tokens: { input } }), model: "claude-haiku-5-5", ...extra });
    const s = summarize([shardOf([haiku("a", 200_000), haiku("b", 100_000), haiku("c", 200_000, { sidechain: true, agentId: "x" })])], BUILTIN_PRICES, { span: "30d", nowMs: MONTH_NOW, tzOffsetMin: 0 });
    const m = s.longPrompts!["claude-haiku-5-5"]!;
    // 100000 is at the threshold, not over it.
    expect(m).toMatchObject({ requests: 2, subRequests: 1, sessions: 1 });
    expect(near(m.extraUsd, 0.16)).toBe(true);
    expect(run30d([req({ id: "o", at: MIN, tokens: { input: 5_000_000 } })]).longPrompts).toEqual({});
  });
});

describe("loops (summary) and idle-loop", () => {
  const wake = { name: "ScheduleWakeup", inputChars: 1 };
  const bashTool = { name: "Bash", inputChars: 1 };
  // Opus: 100k cache read = $0.10 per request. Tick 1 (b, c): 2 requests. Tick 2 (d to h): 5 requests. Tick 3 (i): 1 request.
  const loop = (): UsageRow[] => {
    const at = (id: string, min: number, tools: UsageRow["tools"]) => req({ id, at: min * MIN, tokens: { cacheRead: 100_000 }, tools });
    return [
      at("a", 0, [wake]),
      at("b", 5, [bashTool]),
      at("c", 5.2, [wake]),
      at("d", 10, [bashTool]),
      at("e", 11, [bashTool]),
      at("f", 12, [bashTool]),
      at("g", 13, [bashTool]),
      at("h", 14, [wake]),
      at("i", 20, [bashTool]),
    ];
  };
  test("a tick runs from the request after a wake-up call to the call that schedules the next; ticks of 3 requests or fewer and little output are light", () => {
    const l = run30d(loop()).loops!;
    expect(l).toMatchObject({ ticks: 3, light: 2, lightPromptTokens: 100_000, sessions: 1 });
    expect(near(l.lightUsd, 0.1 * 3)).toBe(true);
  });
  test("a request right after the wake-up call, a sub-agent and a stream with no wake-up are not ticks", () => {
    const quick = [req({ id: "a", at: 0, tools: [wake] }), req({ id: "b", at: 10_000, tools: [bashTool] })];
    expect(run30d(quick).loops!.ticks).toBe(0);
    expect(run30d(loop().map((r) => ({ ...r, sidechain: true, agentId: "z" }))).loops!.ticks).toBe(0);
    expect(run30d([req({ id: "x", at: MIN, tools: [bashTool] })]).loops!.ticks).toBe(0);
  });
  test("a long answer makes a tick heavy: 1500 output tokens is not light", () => {
    const rows = loop();
    rows[8] = { ...rows[8]!, tokens: { ...rows[8]!.tokens, output: 1500 } };
    expect(run30d(rows).loops!.light).toBe(1);
  });
  test("3 light ticks and a dollar fire; the amount is their cost, and Esc stops the loop", () => {
    const l = { ticks: 10, light: 3, lightUsd: 1, lightPromptTokens: 300_000, sessions: 2 };
    const h = only(fire("idle-loop", { loops: l }));
    expect(h.usd).toBe(1);
    expect(h.summary).toContain("3 of 10");
    expect(h.action).toContain("Esc");
    expect(h.evidence.map((e) => e.label)).toEqual(["Light ticks", "Largest prompt"]);
    expect(fire("idle-loop", { loops: { ...l, light: 2 } })).toEqual([]);
    expect(fire("idle-loop", { loops: { ...l, lightUsd: 0.99 } })).toEqual([]);
    expect(fire("idle-loop", {})).toEqual([]);
  });
});
