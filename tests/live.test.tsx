import type { On, SessionRateLimit, TurnStepInput, TurnStepResult, TurnUsage } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";
import { addAgent, addTool, applyEarlier, applyStep, earlierSteps, emptyLive, stepTokens } from "../core/live-state.ts";
import type { Earlier, LiveState } from "../core/live-state.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { drain } from "../core/steps.ts";
import type { Shard } from "../core/shard.ts";
import { dayIdx, saveBuckets } from "../engine/project-store.ts";
import { req, T0 } from "./fixtures/rows.ts";
import { worldOf } from "./world.ts";
import type { World } from "./world.ts";

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const NOW = Date.UTC(2026, 10, 27, 12);
const CWD = "/work/demo";
const PROJECT = "-work-demo";
const CFG = "/home/u/.claude";
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// Opus 5.5: $4 in, $0.2 read, $8 1h write, $5 5m write, $20 out per MTok.
const STEP = { input: 1000, output: 500, cacheRead: 100_000, cw: 10_000 };
const STEP_USD = (1000 * 4 + 100_000 * 0.2 + 10_000 * 8 + 500 * 20) / 1e6;

function usageOf(model: string, p: Partial<TurnUsage> = {}): TurnUsage {
  return { input_tokens: STEP.input, output_tokens: STEP.output, cache_read_input_tokens: STEP.cacheRead, cache_creation_input_tokens: STEP.cw, model, ...p };
}

async function step($: Engine, input: Omit<TurnStepInput, "turnId" | "index" | "model"> & { model?: string; index?: number }): Promise<void> {
  const stream = $.turn.step({ turnId: "t1", index: 0, model: OPUS, ...input });
  for await (const chunk of stream) void chunk;
  await stream.result;
}

type Rig = { world: World; clock: ReturnType<typeof mock.clock>; sid: { v: string }; limits: { v: SessionRateLimit[] }; stored: Map<string, unknown>; live: () => LiveState };

/** The engine beneath tally (the plugin under test loads on its own): clock, env, store, the session's id and usage, the step answers, and an index in memory. */
function rig(on: On, usages: (e: TurnStepInput) => TurnUsage | null = (e) => usageOf(e.agentId === undefined ? OPUS : SONNET)): Rig {
  const world = worldOf();
  const sid = { v: "s-1" };
  const limits = { v: [] as SessionRateLimit[] };
  const clock = mock.clock(on, { now: NOW });
  mock.env(on, { HOME: "/home/u" });
  const stored = new Map<string, unknown>();
  on("store.get", (_, e) => ({ value: stored.get(e.key) }));
  on("store.set", (_, e) => {
    stored.set(e.key, e.value);
    return { value: undefined };
  });
  // The atom's cell as last written: `{ shape, value }`.
  let cell: LiveState | undefined;
  on("state.set", async (_, e, next) => {
    if (e.key === "live") cell = (e.value as { value: LiveState }).value;
    return next(e);
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("prompt.submit", (_, e) => ({ text: e.text }));
  on("session.id", () => ({ value: sid.v }));
  on("session.cwd", () => ({ value: CWD }));
  on("session.usage", () => ({ value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: limits.v, cost: { usd: 0 } } }));
  on("fs.read", async (_, e) => ({ value: await world.$.fs.read(e.path, { as: e.as, offset: e.offset, length: e.length } as never) }));
  on("fs.write", async (_, e) => ({ value: await world.$.fs.write(e.path, e.text) }));
  on("fs.list", async (_, e) => ({ value: await world.$.fs.list(e.path) }));
  on("fs.exists", async (_, e) => ({ value: await world.$.fs.exists(e.path) }));
  on("fs.stat", async (_, e) => ({ value: await world.$.fs.stat(e.path) }));
  on("session.info", () => ({ value: { platform: "linux" } }));
  on("turn.step", async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: usages(e) } as TurnStepResult;
  });
  on("tool.call", (_, e) => ({ result: {}, text: e.tool === "Read" ? "x".repeat(4_000) : "y".repeat(100) }));
  on("agent.spawn", () => ({ model: SONNET, agentId: "a1" }));
  return { world, clock, sid, limits, stored, live: () => cell ?? emptyLive("", 0) };
}

const at = (row: ReturnType<typeof req>, offsetMs: number) => ({ ...row, ts: NOW + offsetMs });
const start = ($: Engine) => $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });

async function seedIndex(w: World, rows: ReturnType<typeof req>[], metas: Shard["metas"] = []): Promise<void> {
  const byDay = new Map<number, Shard>();
  for (const r of rows) {
    const d = dayIdx(r.ts);
    const sh = byDay.get(d) ?? { v: 1, project: PROJECT, files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
    sh.usage.push(r);
    byDay.set(d, sh);
  }
  const first = byDay.values().next().value as Shard;
  first.metas.push(...metas);
  await saveBuckets(w.$, CFG, PROJECT, { days: byDay }, {}, NOW);
}

describe("live tally: main thread", () => {
  test("three steps add up the main thread's tokens and dollars", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    for (let i = 0; i < 3; i++) await step($, { messageCount: 4 + i * 2, index: i });
    const s = r.live();
    expect(s.sessionId).toBe("s-1");
    expect(s.main.input).toBe(3000);
    expect(s.main.output).toBe(1500);
    expect(s.main.cacheRead).toBe(300_000);
    // Unsplit writes on the main thread are priced at the 1-hour life until the index says otherwise.
    expect(s.main.cw1h).toBe(30_000);
    expect(s.main.cw5m).toBe(0);
    expect(near(s.main.usd, 3 * STEP_USD)).toBe(true);
    expect(s.messageCount).toBe(8);
    expect(s.compactions).toBe(0);
  });

  test("a message count that falls from 40 to 5 notes one compaction", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    await step($, { messageCount: 38 });
    await step($, { messageCount: 40 });
    await step($, { messageCount: 5 });
    await step($, { messageCount: 7 });
    const s = r.live();
    expect(s.compactions).toBe(1);
    expect(s.messageCount).toBe(7);
  });

  test("a step with no usage changes nothing", async ($, on) => {
    const r = rig(on, () => null);
    await start($);
    await r.clock.settle();
    await step($, { messageCount: 3 });
    const s = r.live();
    expect(s.main.usd).toBe(0);
    expect(s.messageCount).toBe(0);
  });
});

describe("live tally: subagents and tools", () => {
  test("after agent.spawn a subagent's steps land under agents, not main", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    await $.agent.spawn({
      tool_use_id: "tu1",
      prompt: "find the bug in the parser",
      description: "find the bug",
      subagentType: "Explore",
      provider: { plugin: "engine", tier: "core" },
      parentModel: OPUS,
      background: false,
      fork: false,
    });
    await step($, { messageCount: 2, agentId: "a1" });
    await step($, { messageCount: 4, agentId: "a1" });
    await $.tool.call({ tool: "Read", file_path: "/work/a.ts", agentId: "a1" });
    await $.tool.call({ tool: "Bash", command: "ls" });
    const s = r.live();
    expect(s.main.usd).toBe(0);
    const a = s.agents.a1;
    expect(a.type).toBe("Explore");
    expect(a.description).toBe("find the bug");
    expect(a.firstPrompt).toBe("find the bug in the parser");
    expect(a.model).toBe(SONNET);
    // Sonnet 5.5, subagent writes at the 5-minute price: 1000*2 + 100000*0.1 + 10000*2.5 + 500*10 per request.
    expect(near(a.usd, (2 * (2000 + 10_000 + 25_000 + 5_000)) / 1e6)).toBe(true);
    expect(a.context).toBe(111_000);
    expect(a.peak).toBe(111_000);
    expect(a.tools).toEqual({ Read: 1 });
    expect(s.toolCalls).toEqual({ Read: 1, Bash: 1 });
    expect(s.toolChars).toEqual({ Read: 4_000, Bash: 100 });
  });

  test("a step from a subagent the plugin never saw spawn still counts", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    await step($, { messageCount: 2, agentId: "zz" });
    const s = r.live();
    expect(s.agents.zz.type).toBe("unknown");
    expect(s.agents.zz.usd > 0).toBe(true);
  });
});

describe("live tally: session switches and the index", () => {
  test("a new session id zeroes the state; restoredUsd is what the index holds before this launch", async ($, on) => {
    const r = rig(on);
    // Two requests of s-2 before the launch (30 min and 20 min ago), one after it, one of another session.
    await seedIndex(r.world, [
      at(req({ id: "e1", session: "s-2", at: 0, tokens: { cacheRead: 1_000_000 } }), -30 * 60_000),
      at(req({ id: "e2", session: "s-2", at: 0, tokens: { input: 1_000_000 } }), -20 * 60_000),
      at(req({ id: "x1", session: "s-9", at: 0, tokens: { input: 1_000_000 } }), -10 * 60_000),
      at(req({ id: "n1", session: "s-2", at: 0, tokens: { input: 1_000_000 } }), 60_000),
    ]);
    await start($);
    await r.clock.settle();
    await step($, { messageCount: 4 });
    expect(r.live().main.usd > 0).toBe(true);
    expect(r.live().restoredUsd).toBe(0);

    r.sid.v = "s-2";
    await $.prompt.submit({ text: "go on", wait: false, origin: { kind: "composer" } } as never);
    await r.clock.settle();
    const s = r.live();
    expect(s.sessionId).toBe("s-2");
    expect(s.main.usd).toBe(0);
    expect(s.compactions).toBe(0);
    expect(s.messageCount).toBe(0);
    // e1: 1M cache reads at $0.2; e2: 1M input at $4; the launch's own n1 and s-9 are not earlier.
    expect(near(s.restoredUsd, 4.2)).toBe(true);
  });

  test("the cache life comes from the session's latest write in the index", async ($, on) => {
    const r = rig(on);
    await seedIndex(r.world, [
      at(req({ id: "w1", session: "s-1", at: 0, tokens: { cw1h: 50_000 } }), -3_600_000),
      at(req({ id: "w2", session: "s-1", at: 0, tokens: { cw5m: 60_000 } }), -3_599_999),
    ]);
    await start($);
    await r.clock.settle();
    expect(r.live().lastWrite).toEqual({ ts: NOW - 3_599_999, ttl: "5m" });
    // An unsplit write is now priced at the verified 5-minute life.
    await step($, { messageCount: 2 });
    const s = r.live();
    expect(s.main.cw5m).toBe(10_000);
    expect(s.main.cw1h).toBe(0);
    expect(near(s.main.usd, (1000 * 4 + 100_000 * 0.2 + 10_000 * 5 + 500 * 20) / 1e6)).toBe(true);
  });

  test("cost-state ledger less the priced steps is other requests", async ($, on) => {
    const r = rig(on);
    await seedIndex(
      r.world,
      [at(req({ id: "p1", session: "s-1", at: 0 }), -1000)],
      [{ sessionId: "s-1", key: "cost-state", value: { startTime: NOW - 5_000, totalCostUSD: 0.5, modelUsage: {} } }],
    );
    await start($);
    await r.clock.settle();
    await step($, { messageCount: 2 });
    await r.clock.set(NOW + 120_000);
    await r.clock.settle();
    await $.turn.complete({ turnId: "t1", answer: "", durationMs: 1, isAborted: false } as never);
    await r.clock.settle();
    const s = r.live();
    expect(near(s.other.usd, 0.5 - STEP_USD)).toBe(true);
  });

  test("rate limits are stored as lastLimits when the engine reports them", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    expect(r.stored.get("lastLimits")).toBeUndefined();
    r.limits.v = [{ kind: "five_hour", percentUsed: 41, resetsAt: new Date(NOW + 3_600_000).toISOString() }];
    await $.turn.complete({ turnId: "t1", answer: "", durationMs: 1, isAborted: false } as never);
    await r.clock.settle();
    expect(r.stored.get("lastLimits")).toEqual({ at: NOW, limits: r.limits.v });
  });
});

describe("live-state reducers", () => {
  const tok = (o: Partial<LiveState["main"]> = {}) => ({ input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0, ...o });
  const usage = (o = {}) => ({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 100, model: OPUS, ...o });

  test("stepTokens: a named split is taken as reported with the rest as 5m; an unnamed write goes whole under the life", () => {
    const split = stepTokens(usage({ ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 60 }), "1h", 0);
    expect(split.tokens.cw5m).toBe(40);
    expect(split.tokens.cw1h).toBe(60);
    expect(split.seen).toBe("1h");
    expect(stepTokens(usage(), "5m", 0)).toEqual({ tokens: { input: 1, output: 2, cacheRead: 3, cw5m: 100, cw1h: 0 } });
    expect(stepTokens(usage({ cache_creation_input_tokens: 0, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }), "5m", 0).seen).toBeUndefined();
  });

  test("applyStep never mutates its input and keeps the last known life when a write names none", () => {
    const s0 = emptyLive("s", 1);
    const s1 = applyStep(s0, { ts: 5, messageCount: 3, model: OPUS, tokens: tok({ cw5m: 10 }), usd: 1, seen: "5m" });
    const s2 = applyStep(s1, { ts: 9, messageCount: 5, model: OPUS, tokens: tok({ cw5m: 10 }), usd: 1 });
    expect(s0.main.usd).toBe(0);
    expect(s2.lastWrite).toEqual({ ts: 9, ttl: "5m" });
    expect(s2.main.cw5m).toBe(20);
  });

  test("the agent map is capped, oldest first", () => {
    let s = emptyLive("s", 1);
    for (let i = 0; i < 205; i++) s = addAgent(s, `a${i}`, "t", "d", "m", "p");
    expect(Object.keys(s.agents).length).toBe(200);
    expect(s.agents.a0).toBeUndefined();
    expect(s.agents.a204).toBeDefined();
  });

  test("addTool counts into the session and the loop; long texts are cut", () => {
    let s = addAgent(emptyLive("s", 1), "a", "t", "d".repeat(500), "m", "p".repeat(500));
    s = addTool(addTool(s, "a", "Read", 10), undefined, "Read", 5);
    expect(s.toolCalls).toEqual({ Read: 2 });
    expect(s.toolChars).toEqual({ Read: 15 });
    expect(s.agents.a.tools).toEqual({ Read: 1 });
    expect(s.agents.a.description.length).toBe(200);
    expect(s.agents.a.firstPrompt.length).toBe(200);
  });

  test("applyEarlier ignores an earlier launch's ledger line and clamps rounding to zero", () => {
    const s = { ...emptyLive("s", 1_000_000), main: { ...tok(), usd: 1 } };
    const old: Earlier = { restoredUsd: 2, ledger: { startTime: 1_000_000 - 300_000, totalCostUSD: 9 } };
    expect(applyEarlier(s, old).other.usd).toBe(0);
    expect(applyEarlier(s, old).restoredUsd).toBe(2);
    const mine: Earlier = { restoredUsd: 2, ledger: { startTime: 1_000_000 - 1000, totalCostUSD: 3.00001 } };
    expect(applyEarlier(s, mine).other.usd).toBe(0);
    expect(near(applyEarlier(s, { ...mine, ledger: { startTime: 999_000, totalCostUSD: 3.5 } }).other.usd, 0.5)).toBe(true);
  });

  test("earlierSteps picks the session's rows before the launch and its newest main write", () => {
    const rows = [
      req({ id: "a", session: "s", at: 0, tokens: { input: 1_000_000, cw1h: 5 } }),
      req({ id: "b", session: "s", at: 10, tokens: { cw5m: 7 } }),
      req({ id: "c", session: "s", at: 20, tokens: { cw1h: 9 }, sidechain: true }),
      req({ id: "d", session: "other", at: 5, tokens: { input: 1_000_000 } }),
    ];
    const shard: Shard = { v: 1, project: "p", files: {}, usage: rows, users: [], metas: [], compacts: [], snapshots: [] };
    const e = drain(earlierSteps(shard, "s", T0 + 15, BUILTIN_PRICES));
    expect(near(e.restoredUsd, 4 + (5 * 8 + 7 * 5) / 1e6)).toBe(true);
    expect(e.lastWrite).toEqual({ ts: T0 + 10, ttl: "5m" });
    expect(e.ledger).toBeUndefined();
  });
});
