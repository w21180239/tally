import { describe, expect, test } from "claude-code/testing";
import { mcpResultUsd, mcpSchemaSteps, mcpServerOf, nearestSnapshot, residentTokens, snapshotOf } from "../core/breakdown.ts";
import type { BreakdownSnapshot } from "../core/breakdown.ts";
import { addActive, addAgent, applyEarlier, applyStep, earlierSteps, emptyLive } from "../core/live-state.ts";
import type { LiveState } from "../core/live-state.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { drain } from "../core/steps.ts";
import type { Shard } from "../core/shard.ts";
import type { Tokens } from "../core/types.ts";
import { agentCaches, kindRows, modelSplit, perActiveHour, topModel, totalUsd, whereItWent } from "../core/where.ts";
import { req, T0 } from "./fixtures/rows.ts";

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const tok = (o: Partial<Tokens> = {}): Tokens => ({ input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0, ...o });
const sumOf = (rows: Array<{ usd: number }>) => rows.reduce((a, r) => a + r.usd, 0);

// Opus 5.5 per MTok: $4 in, $20 out, $0.2 cache read, $5 5m write, $8 1h write.
// Before this launch: a main request of 1M input ($4) and an Explore sub-agent's of 500k input ($2).
// This launch: a main step of $1, a Plan sub-agent's step on Sonnet of $0.5. The ledger charged Opus $7.5 and Sonnet $0.75.
function session(): LiveState {
  const rows = [req({ id: "m1", session: "s", at: 0, tokens: { input: 1_000_000 } }), req({ id: "a1", session: "s", at: 5, tokens: { input: 500_000 }, sidechain: true, agentType: "Explore", agentId: "x" })];
  const shard: Shard = { v: 1, project: "p", files: {}, usage: rows, users: [], metas: [], compacts: [], snapshots: [] };
  const earlier = drain(earlierSteps(shard, "s", T0 + 100, BUILTIN_PRICES));
  let s = emptyLive("s", T0 + 100);
  s = applyStep(s, { ts: T0 + 200, messageCount: 2, model: OPUS, tokens: tok({ input: 250_000 }), usd: 1 });
  s = addAgent(s, "ag1", "Plan", "outline the change", SONNET, "go");
  s = applyStep(s, { agentId: "ag1", ts: T0 + 300, messageCount: 2, model: SONNET, tokens: tok({ input: 100_000 }), usd: 0.5 });
  return applyEarlier(s, { ...earlier, ledger: { startTime: T0 + 50, totalCostUSD: 8.25, costs: { [OPUS]: 7.5, [SONNET]: 0.75 } } });
}

describe("where it went", () => {
  test("rows sum to the total and name main, each sub-agent, earlier sub-agents and side requests by model", () => {
    const s = session();
    expect(near(totalUsd(s), 8.25)).toBe(true);
    const rows = whereItWent(s);
    expect(near(sumOf(rows), totalUsd(s))).toBe(true);
    const by = (kind: string) => rows.filter((r) => r.kind === kind);
    // Main: this launch's $1 and the earlier launch's $6 less its sub-agent's $2.
    expect(by("main").map((r) => [r.model, r.usd])).toEqual([[OPUS, 5]]);
    expect(by("agent").map((r) => [r.label, r.model, r.usd])).toEqual([["Plan \u{b7} outline the change", SONNET, 0.5]]);
    expect(by("earlier").map((r) => [r.label, r.usd])).toEqual([["Explore before resume", 2]]);
    expect(by("side").map((r) => [r.model, r.usd])).toEqual([
      [OPUS, 0.5],
      [SONNET, 0.25],
    ]);
  });

  test("a sub-agent dropped from the capped map comes back as one row, so the sum still holds", () => {
    const s = session();
    const lost: LiveState = { ...s, agents: {} };
    const rows = whereItWent(lost);
    expect(near(sumOf(rows), totalUsd(lost))).toBe(true);
    expect(rows.filter((r) => r.kind === "rest").map((r) => r.usd)).toEqual([0.5]);
  });

  test("a ledger with no per-model charge puts the side requests under one unnamed model", () => {
    let s = emptyLive("s", T0);
    s = applyStep(s, { ts: T0, messageCount: 2, model: OPUS, tokens: tok(), usd: 1 });
    s = applyEarlier(s, { restoredUsd: 0, ledger: { startTime: T0, totalCostUSD: 1.4 } });
    expect(s.otherByModel).toEqual({ "": s.other.usd });
    const rows = whereItWent(s);
    expect(rows.map((r) => [r.kind, r.model])).toEqual([["main", OPUS], ["side", ""]]);
    expect(near(sumOf(rows), 1.4)).toBe(true);
  });

  test("per-model side requests are scaled to the ledger's total gap", () => {
    let s = emptyLive("s", T0);
    s = applyStep(s, { ts: T0, messageCount: 2, model: OPUS, tokens: tok(), usd: 1 });
    // The ledger's per-model charges (1.8 and 0.6 beyond the live step) overshoot its total gap of 1.2 by 2x.
    s = applyEarlier(s, { restoredUsd: 0, ledger: { startTime: T0, totalCostUSD: 2.2, costs: { [OPUS]: 2.8, [SONNET]: 0.6 } } });
    expect(near(s.otherByModel[OPUS]!, 0.9)).toBe(true);
    expect(near(s.otherByModel[SONNET]!, 0.3)).toBe(true);
    expect(near(sumOf(whereItWent(s)), totalUsd(s))).toBe(true);
  });

  test("an empty session has no rows", () => {
    expect(whereItWent(emptyLive("s", 0))).toEqual([]);
    expect(totalUsd(emptyLive("s", 0))).toBe(0);
  });

  test("topModel is the costliest, empty for none", () => {
    expect(topModel({ a: 1, b: 3, c: 2 })).toBe("b");
    expect(topModel({})).toBe("");
  });

  test("modelSplit covers this launch, earlier launches and side requests, and adds up to the total", () => {
    const s = session();
    const split = modelSplit(s);
    expect(near(split.reduce((a, [, u]) => a + u, 0), totalUsd(s))).toBe(true);
    expect(split.map(([m]) => m)).toEqual([OPUS, SONNET]);
    expect(near(split[0]![1], 6 + 1 + 0.5)).toBe(true);
    expect(near(split[1]![1], 0.5 + 0.25)).toBe(true);
  });
});

describe("pace and kinds", () => {
  test("hourly pace divides this launch's spend by its turn time, and is absent before a turn ends", () => {
    let s = session();
    expect(perActiveHour(s)).toBeNull();
    s = addActive(addActive(s, 900_000), 900_000);
    // This launch: $1 + $0.5 + $0.75 side requests, over half an hour.
    expect(near(perActiveHour(s)!, 2.25 / 0.5)).toBe(true);
    expect(addActive(s, -5)).toBe(s);
    expect(perActiveHour(emptyLive("s", 0))).toBeNull();
  });

  test("kinds are tokens and list-price shares of the exact cost, and the cache write splits by life", () => {
    let s = emptyLive("s", T0);
    s = applyStep(s, { ts: T0, messageCount: 2, model: OPUS, tokens: tok({ input: 1000, output: 500, cacheRead: 100_000, cw1h: 10_000, cw5m: 2_000 }), usd: 0.124 });
    const k = Object.fromEntries(kindRows(s, BUILTIN_PRICES).map((r) => [r.kind, r]));
    expect(k.input!.tokens).toBe(1000);
    expect(k.cacheWrite!.tokens).toBe(12_000);
    expect(k.cw1h!.tokens).toBe(10_000);
    expect(k.cw5m!.tokens).toBe(2_000);
    expect(near(k.input!.usd, 0.004)).toBe(true);
    expect(near(k.cacheRead!.usd, 0.02)).toBe(true);
    expect(near(k.cw1h!.usd, 0.08)).toBe(true);
    expect(near(k.cw5m!.usd, 0.01)).toBe(true);
    expect(near(k.cacheWrite!.usd, 0.09)).toBe(true);
    expect(near(k.input!.usd + k.output!.usd + k.cacheRead!.usd + k.cacheWrite!.usd, 0.124)).toBe(true);
  });

  test("when the exact cost differs from list price (a long-context request) the kinds are scaled to it", () => {
    let s = emptyLive("s", T0);
    s = applyStep(s, { ts: T0, messageCount: 2, model: OPUS, tokens: tok({ input: 1_000_000 }), usd: 8 });
    const k = kindRows(s, BUILTIN_PRICES);
    expect(near(k.reduce((a, r) => (r.kind === "cw1h" || r.kind === "cw5m" ? a : a + r.usd), 0), 8)).toBe(true);
  });

  test("earlier launches' tokens count in the kinds", () => {
    const s = session();
    const k = Object.fromEntries(kindRows(s, BUILTIN_PRICES).map((r) => [r.kind, r]));
    expect(k.input!.tokens).toBe(1_500_000 + 250_000 + 100_000);
  });
});

describe("cache timers of sub-agents", () => {
  test("a warm sub-agent has its time left and a refill price; a cold one is left out", () => {
    const now = T0 + 1_000_000;
    let s = emptyLive("s", T0);
    s = addAgent(s, "warm", "Plan", "", OPUS, "go");
    s = addAgent(s, "cold", "Explore", "", OPUS, "go");
    s = applyStep(s, { agentId: "warm", ts: now - 120_000, messageCount: 2, model: OPUS, tokens: tok({ input: 100_000, cw5m: 100_000 }), usd: 0.1 });
    s = applyStep(s, { agentId: "cold", ts: now - 400_000, messageCount: 2, model: OPUS, tokens: tok({ input: 1 }), usd: 0.1 });
    const rows = agentCaches(s, now, BUILTIN_PRICES);
    expect(rows.map((r) => [r.id, r.leftMs])).toEqual([["warm", 180_000]]);
    // 200k prompt tokens written at the 5-minute price of $5 per MTok.
    expect(near(rows[0]!.refillUsd!, 1)).toBe(true);
  });
});

describe("breakdown snapshots", () => {
  const snap = (sessionId: string, ts: number): BreakdownSnapshot => ({ sessionId, ts, skills: {}, mcp: {}, agents: {}, memory: {}, system: 0, tools: 0 });

  test("nearestSnapshot is the one closest in time, and a proxy", () => {
    const list = [snap("a", 100), snap("b", 500), snap("c", 900)];
    expect(nearestSnapshot(list, 560)).toEqual({ snap: list[1], proxy: true });
    expect(nearestSnapshot(list, 10)?.snap.sessionId).toBe("a");
    expect(nearestSnapshot(list, 5_000)?.snap.sessionId).toBe("c");
    // A tie goes to the earlier one.
    expect(nearestSnapshot(list, 300)?.snap.sessionId).toBe("a");
    expect(nearestSnapshot([], 1)).toBeNull();
  });

  test("a snapshot taken in the session itself is not a proxy, even when another is nearer in time", () => {
    const list = [snap("a", 100), snap("b", 500)];
    expect(nearestSnapshot(list, 510, "a")).toEqual({ snap: list[0], proxy: false });
    expect(nearestSnapshot(list, 510, "zzz")?.proxy).toBe(true);
  });

  test("snapshotOf reads skills, MCP servers (loaded or deferred), agents, memory, and the two fixed rows", () => {
    const s = snapshotOf("s-1", 42, {
      categories: [
        { name: "System prompt", tokens: 3000, kind: "used" },
        { name: "System tools", tokens: 8000, kind: "used" },
        { name: "MCP tools (deferred)", tokens: 9999, kind: "deferred" },
        { name: "Messages", tokens: 500, kind: "used" },
      ],
      mcpTools: [
        { name: "mcp__demo__a", serverName: "demo", tokens: 600, isLoaded: true },
        { name: "mcp__demo__b", serverName: "demo", tokens: 400, isLoaded: false },
        { name: "mcp__other_srv__c", serverName: "other srv", tokens: 50, isLoaded: true },
      ],
      agents: [{ agentType: "helper", tokens: 70 }],
      memoryFiles: [{ path: "/p/CLAUDE.md", tokens: 300 }],
      skills: { skillFrontmatter: [{ name: "deploy", tokens: 90 }, { name: "review", tokens: 10 }] },
    });
    expect(s).toEqual({
      sessionId: "s-1",
      ts: 42,
      skills: { deploy: 90, review: 10 },
      mcp: { demo: { tokens: 1000, deferred: 400 }, other_srv: { tokens: 50, deferred: 0 } },
      agents: { helper: 70 },
      memory: { "/p/CLAUDE.md": 300 },
      system: 3000,
      tools: 8000,
    });
    expect(residentTokens(s)).toEqual({ demo: 600, other_srv: 50 });
  });

  test("a breakdown with nothing in it is a snapshot of zeros", () => {
    expect(snapshotOf("s", 1, {})).toEqual({ sessionId: "s", ts: 1, skills: {}, mcp: {}, agents: {}, memory: {}, system: 0, tools: 0 });
  });

  test("the server of a wire tool name", () => {
    expect(mcpServerOf("mcp__demo__list")).toBe("demo");
    expect(mcpServerOf("Read")).toBeNull();
    expect(mcpServerOf("mcp__")).toBeNull();
  });

  test("schema cost is resident tokens times the cache-read price of each main request; sub-agents and synthetic rows add none", () => {
    const rows = [
      req({ id: "r1", at: 0 }),
      req({ id: "r2", at: 1 }),
      req({ id: "r3", at: 2 }),
      req({ id: "r4", at: 3, sidechain: true, agentType: "x", agentId: "x" }),
      { ...req({ id: "r5", at: 4 }), synthetic: true },
    ];
    const s: BreakdownSnapshot = { ...snap("s", 0), mcp: { demo: { tokens: 1000, deferred: 200 }, idle: { tokens: 500, deferred: 500 } } };
    const cost = drain(mcpSchemaSteps(rows, s, BUILTIN_PRICES));
    // 800 resident tokens x $0.2 per MTok x 3 main requests; a fully deferred server costs nothing.
    expect(near(cost.demo!, 800 * 0.2e-6 * 3)).toBe(true);
    expect(cost.idle).toBeUndefined();
  });

  test("result re-read cost is summed per server from the context flow's mcp parts only", () => {
    const usd = mcpResultUsd([
      { label: "mcp__demo__a", source: "mcp", tokens: 10, rereadUsd: 0.5 },
      { label: "mcp__demo__b", source: "mcp", tokens: 10, rereadUsd: 0.25 },
      { label: "mcp__other__a", source: "mcp", tokens: 10, rereadUsd: 1 },
      { label: "Read", source: "read", tokens: 10, rereadUsd: 9 },
    ]);
    expect(usd).toEqual({ demo: 0.75, other: 1 });
  });
});
