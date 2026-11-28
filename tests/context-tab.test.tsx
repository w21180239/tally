import type { AgentInfo } from "claude-code";
import type { On, RenderInput, TurnStepInput, TurnStepResult, TurnUsage } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";
import { analyzeFlow } from "../core/flow.ts";
import { contextOf, unusedIn } from "../core/context.ts";
import type { ContextInput } from "../core/context.ts";
import { liveMcp } from "../core/breakdown.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { lastAnswer, oneLine, transcriptBuilder } from "../core/subagent-view.ts";
import type { Shard } from "../core/shard.ts";
import { summarize } from "../core/summary.ts";
import type { UsageRow } from "../core/types.ts";
import { needsAgentStates, needsContext, isActive, mergeUsed } from "../engine/context-view.ts";
import { dayIdx, saveBuckets } from "../engine/project-store.ts";
import { saveShard } from "../engine/store-index.ts";
import { needsTranscript } from "../engine/subagent-transcript.ts";
import { keyLine } from "../view/keys.ts";
import { agentOrderOf } from "../view/tabs/context.tsx";
import { PRICES } from "./fixtures/month.ts";
import { READ_USD, T0, inAgent, req, result } from "./fixtures/rows.ts";
import { worldOf } from "./world.ts";
import type { World } from "./world.ts";

const PLUGIN = "tally";
const NOW = Date.UTC(2026, 10, 27, 12);
const CWD = "/work/demo";
const PROJECT = "-work-demo";
const CFG = "/home/u/.claude";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

const PANE: Omit<RenderInput<"Pane">, "surface"> = {
  component: "Pane",
  requestId: PLUGIN,
  viewport: { columns: 200, rows: 60, isFullscreen: true },
  props: { title: "tally", isFocused: true, bodyColumns: 89, placement: "dock", scroll: { offset: 0, bodyRows: 120 }, view: {} },
};
const TEXT = (re: RegExp) => ({ type: "Text" as const, text: re });

type Breakdown = ContextInput & Record<string, unknown>;
type Rig = {
  world: World;
  clock: ReturnType<typeof mock.clock>;
  stored: Map<string, unknown>;
  breakdown: { summary?: Breakdown; full?: Breakdown };
  agents: { v: Array<Partial<AgentInfo>> | "fail" };
  spawnId: { v: string };
  calls: Array<string | undefined>;
};

const usageOf = (model: string, isMain: boolean): TurnUsage => ({
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_input_tokens: 100_000,
  cache_creation_input_tokens: 10_000,
  model,
  ...(isMain && { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 }),
});

function rig(on: On): Rig {
  const world = worldOf();
  const r: Rig = { world, clock: mock.clock(on, { now: NOW }), stored: new Map(), breakdown: {}, agents: { v: [] }, spawnId: { v: "ag1" }, calls: [] };
  mock.env(on, { HOME: "/home/u" });
  on("store.get", (_, e) => ({ value: r.stored.get(e.key) }));
  on("store.set", (_, e) => {
    r.stored.set(e.key, e.value);
    return { value: undefined };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("session.measure", (_, e) => ({ changed: e.changed }));
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.close", () => ({ value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.panes", () => ({ value: [] }));
  on("session.id", () => ({ value: "s-1" }));
  on("session.cwd", () => ({ value: CWD }));
  on("session.model", () => ({ value: OPUS }));
  on("session.info", () => ({ value: { platform: "linux" } }));
  on("session.usage", (_, e) => {
    r.calls.push(e.breakdown);
    const b = e.breakdown === undefined ? undefined : r.breakdown[e.breakdown];
    if (e.breakdown !== undefined && b === undefined && e.breakdown === "full") throw new Error("the token count is unavailable");
    return { value: { startedAt: NOW, context: { tokens: 236_000, window: 1_000_000, percent: 24, ...(b !== undefined && { breakdown: b }) }, rateLimits: [], cost: { usd: 0 } } as never };
  });
  on("agent.list", () => {
    if (r.agents.v === "fail") throw new Error("no agent list");
    return { value: r.agents.v as AgentInfo[] };
  });
  on("agent.spawn", () => ({ model: SONNET, agentId: r.spawnId.v }));
  on("fs.read", async (_, e) => ({ value: await world.$.fs.read(e.path, { as: e.as, offset: e.offset, length: e.length } as never) }));
  on("fs.write", async (_, e) => ({ value: await world.$.fs.write(e.path, e.text) }));
  on("fs.list", async (_, e) => ({ value: await world.$.fs.list(e.path) }));
  on("fs.exists", async (_, e) => ({ value: await world.$.fs.exists(e.path) }));
  on("fs.stat", async (_, e) => ({ value: await world.$.fs.stat(e.path) }));
  on("config.list", () => ({ value: [] }));
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("prompt.submit", (_, e) => ({ text: e.text }));
  on("turn.step", async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: usageOf(e.agentId === undefined ? OPUS : SONNET, e.agentId === undefined) } as TurnStepResult;
  });
  on("tool.call", () => ({ result: {}, text: "ok" }));
  return r;
}

const bd = (extra: Partial<Breakdown> = {}): Breakdown => ({
  categories: [
    { name: "System prompt", tokens: 3000, kind: "used", isDeferred: false },
    { name: "System tools", tokens: 8000, kind: "used", isDeferred: false },
    { name: "Messages", tokens: 20_000, kind: "used", isDeferred: false },
    { name: "MCP tools (deferred)", tokens: 900, kind: "deferred", isDeferred: true },
    { name: "Free space", tokens: 960_000, kind: "free", isDeferred: false },
  ],
  mcpTools: [
    { name: "mcp__demo__lookup", serverName: "demo", tokens: 4000, isLoaded: true },
    { name: "mcp__lazy__find", serverName: "lazy", tokens: 900, isLoaded: false },
    { name: "mcp__idle__ping", serverName: "idle", tokens: 500, isLoaded: true },
  ],
  agents: [{ agentType: "reviewer", tokens: 300 }],
  memoryFiles: [{ path: "/work/demo/CLAUDE.md", tokens: 1200 }],
  skills: { skillFrontmatter: [{ name: "deploy", tokens: 40 }, { name: "lint", tokens: 30 }] },
  totalTokens: 36_000,
  rawMaxTokens: 1_000_000,
  ...extra,
});

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
const step = async ($: Engine, index: number, agentId?: string) => {
  const input: TurnStepInput = { turnId: "t1", index, model: OPUS, messageCount: 2 + index, ...(agentId !== undefined && { agentId }) } as TurnStepInput;
  const stream = $.turn.step(input);
  for await (const chunk of stream) void chunk;
  await stream.result;
};
const spawn = (r: Rig, $: Engine, id: string, type: string, description: string, prompt: string) => {
  r.spawnId.v = id;
  return $.agent.spawn({ tool_use_id: `tu-${id}`, prompt, description, subagentType: type, provider: { plugin: "engine", tier: "core" }, parentModel: OPUS, background: false, fork: false });
};
const status = (id: string, s: AgentInfo["status"]): Partial<AgentInfo> => ({ id, status: s, contextWindowSize: 200_000 });

// A session of s-1 in the index: a main request that used the `deploy` skill and called the `demo` server, and a
// sub-agent request of type Explore.
async function seedIndex(w: World): Promise<void> {
  const main = {
    ...req({ id: "a", session: "s-1", at: 0, tokens: { input: 100, cacheRead: 50_000 }, tools: [{ name: "mcp__demo__lookup", mcpServer: "demo", id: "tu0", inputChars: 5 }] }),
    ts: NOW - 3_600_000,
    skill: "deploy",
  };
  const sub = { ...inAgent(req({ id: "x", session: "s-1", at: 0, tokens: { cw5m: 4000 }, agentType: "Explore" }), "ag9"), ts: NOW - 3_000_000 };
  const byDay = new Map<number, Shard>();
  for (const row of [main, sub]) {
    const d = dayIdx(row.ts);
    const sh = byDay.get(d) ?? { v: 1, project: PROJECT, files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
    sh.usage.push(row);
    byDay.set(d, sh);
  }
  await saveBuckets(w.$, CFG, PROJECT, { days: byDay }, {}, NOW);
}

// Draws the open window, lets the loads that draw asked for finish, and draws again to show them.
async function redraw(ui: Awaited<ReturnType<Engine["ui"]["mount"]>>, r: Rig) {
  await ui.redraw();
  await r.clock.settle();
  await ui.redraw();
}

async function openContext($: Engine, r: Rig) {
  await start($);
  await r.clock.settle();
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
  await ui.press({ key: "tab-context" });
  await r.clock.settle();
  return ui;
}

describe("context tab: what every request carries", () => {
  test("the estimate shows first with ~ and the counted figures replace it", async ($, on) => {
    const r = rig(on);
    r.breakdown = { summary: bd() };
    const ui = await openContext($, r);
    expect(await ui.find({ key: "body-context" })).toBeDefined();
    expect(await ui.find(TEXT(/^In every request$/))).toBeDefined();
    expect(await ui.find(TEXT(/estimated, counting follows/))).toBeDefined();
    expect(await ui.find(TEXT(/^~36k$/))).toBeDefined();
    expect(await ui.find({ key: "part-system" })).toBeDefined();
    expect(await ui.find({ key: "part-tools" })).toBeDefined();
    expect(await ui.find({ key: "part-messages" })).toBeDefined();
    expect(await ui.find({ key: "part-free" })).toBeDefined();
    for (const heading of ["Skills", "MCP servers", "Agents", "Memory files"]) expect(await ui.find(TEXT(new RegExp(`^${heading}$`)))).toBeDefined();
    await ui.unmount();
  });

  test("a counted breakdown drops the ~ and says so", async ($, on) => {
    const r = rig(on);
    r.breakdown = { summary: bd(), full: bd({ totalTokens: 38_000 }) };
    const ui = await openContext($, r);
    expect(await ui.find(TEXT(/^38k$/))).toBeDefined();
    expect(await ui.find(TEXT(/^counted/))).toBeDefined();
    expect(await ui.find(TEXT(/estimated, counting follows/))).toBeUndefined();
    expect(await ui.find(TEXT(/^~/))).toBeUndefined();
    expect(r.calls.filter((c) => c === "full").length).toBeGreaterThan(0);
    await ui.unmount();
  });

  test("a deferred MCP server carries the deferred mark, a loaded one does not", async ($, on) => {
    const r = rig(on);
    r.breakdown = { summary: bd(), full: bd() };
    const ui = await openContext($, r);
    // A wholly deferred row's figure is starred, and the list's last line says what the star means.
    expect(await ui.find(TEXT(/^lazy$/))).toBeDefined();
    expect(await ui.find(TEXT(/^900\*$/))).toBeDefined();
    expect(await ui.find(TEXT(/^demo/))).toBeDefined();
    expect(await ui.find(TEXT(/^demo.*deferred/))).toBeUndefined();
    expect(await ui.find(TEXT(/^\* 900 deferred: not loaded until searched for$/))).toBeDefined();
    expect(await ui.find(TEXT(/900 also deferred/))).toBeDefined();
    await ui.unmount();
  });

  test("entries nothing called in the index or the live tally are marked unused; called ones are not", async ($, on) => {
    const r = rig(on);
    r.breakdown = { summary: bd(), full: bd() };
    await seedIndex(r.world);
    const ui = await openContext($, r);
    expect(await ui.find(TEXT(/^lint \u{b7} unused$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^idle \u{b7} unused$/u))).toBeDefined();
    // A list where nothing was called says so once in its title and does not repeat it on every row.
    expect(await ui.find(TEXT(/^reviewer$/))).toBeDefined();
    expect(await ui.find(TEXT(/^reviewer .*unused/))).toBeUndefined();
    expect(await ui.find(TEXT(/^1 \u{b7} none called in 30 days$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^deploy/))).toBeDefined();
    expect(await ui.find(TEXT(/^deploy .*unused/))).toBeUndefined();
    expect(await ui.find(TEXT(/^demo .*unused/))).toBeUndefined();
    expect(await ui.find(TEXT(/no call in this project in the past 30 days/))).toBeDefined();
    await ui.unmount();
  });

  test("a read failure shows its reason, and no breakdown is no figures", async ($, on) => {
    const r = rig(on);
    const ui = await openContext($, r);
    expect(await ui.find(TEXT(/^Could not read the context: the engine returned no breakdown for this session$/))).toBeDefined();
    expect(await ui.find({ key: "part-system" })).toBeUndefined();
    await ui.unmount();
  });

  test("negative: with no index nothing is marked unused, and the caption says the index is not read", async ($, on) => {
    const r = rig(on);
    r.breakdown = { summary: bd(), full: bd() };
    const ui = await openContext($, r);
    expect(await ui.find(TEXT(/^lint/))).toBeDefined();
    expect(await ui.find(TEXT(/unused$/u))).toBeUndefined();
    expect(await ui.find(TEXT(/unused: marked once the index has been read/))).toBeUndefined();
    expect(await ui.find(TEXT(/unused: shown after the project index loads/))).toBeDefined();
    expect(await ui.find(TEXT(/no call in this project in the past 30 days/))).toBeUndefined();
    await ui.unmount();
  });

  test("a stale index (written by another format) marks nothing either", async ($, on) => {
    const r = rig(on);
    r.breakdown = { summary: bd(), full: bd() };
    // A manifest stamped with another index format is ignored like a missing one.
    await saveShard(r.world.$, CFG, { v: 1, project: PROJECT, files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [], days: {}, fmt: 0 });
    const ui = await openContext($, r);
    expect(await ui.find(TEXT(/^lint/))).toBeDefined();
    expect(await ui.find(TEXT(/unused$/u))).toBeUndefined();
    await ui.unmount();
  });

  test("a live call to a server marks it used even when the index lists none of its calls", async ($, on) => {
    const r = rig(on);
    r.breakdown = { summary: bd(), full: bd() };
    await seedIndex(r.world);
    await start($);
    await r.clock.settle();
    await $.tool.call({ tool: "mcp__idle__ping", input: {} } as never);
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-context" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^idle/))).toBeDefined();
    expect(await ui.find(TEXT(/^idle .*unused/))).toBeUndefined();
    expect(await ui.find(TEXT(/^lazy .*unused/))).toBeDefined();
    await ui.unmount();
  });

  test("lists past six entries fold under m, which opens them", async ($, on) => {
    const r = rig(on);
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, tokens: 10 + i }));
    r.breakdown = { summary: bd({ skills: { skillFrontmatter: many } }), full: bd({ skills: { skillFrontmatter: many } }) };
    const ui = await openContext($, r);
    expect(await ui.find({ key: "skill-s8" })).toBeDefined();
    expect(await ui.find({ key: "skill-s3" })).toBeDefined();
    expect(await ui.find({ key: "skill-s2" })).toBeUndefined();
    expect((await ui.find({ key: "lists-more" }))?.props.hotkey).toBe("m");
    await ui.press({ key: "lists-more" });
    expect(await ui.find({ key: "skill-s0" })).toBeDefined();
    await ui.press({ key: "lists-more" });
    expect(await ui.find({ key: "skill-s0" })).toBeUndefined();
    await ui.unmount();
  });
});

describe("context tab: sub-agents", () => {
  async function withAgents($: Engine, r: Rig) {
    r.breakdown = { summary: bd(), full: bd() };
    await start($);
    await r.clock.settle();
    await spawn(r, $, "ag1", "Explore", "find the bug", "find the bug in the parser\nand report the file");
    await spawn(r, $, "ag2", "Plan", "plan the fix", "plan the fix");
    await step($, 1, "ag1");
    await step($, 2, "ag2");
    await $.tool.call({ tool: "Read", file_path: "/a.ts", agentId: "ag1" } as never);
    await $.tool.call({ tool: "Bash", command: "ls", agentId: "ag1" } as never);
    await $.tool.call({ tool: "Bash", command: "ls b", agentId: "ag1" } as never);
    await r.clock.settle();
  }

  test("a running agent is picked first; its detail has type, description, model, context, peak, prompt and tool counts; b goes back", async ($, on) => {
    const r = rig(on);
    r.agents.v = [status("ag1", "completed"), status("ag2", "running")];
    await withAgents($, r);
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-context" });
    await r.clock.settle();
    // From the main view, next lands on the running agent, not on the older finished one.
    expect((await ui.find({ key: "agent-next" }))?.props.hotkey).toBe("n");
    expect((await ui.find({ key: "agent-prev" }))?.props.hotkey).toBe("p");
    expect((await ui.find({ key: "agent-list" }))?.props.hotkey).toBe("a");
    await ui.press({ key: "agent-next" });
    expect(await ui.find(TEXT(/^Plan$/))).toBeDefined();
    expect(await ui.find(TEXT(/plan the fix \u{b7} running \u{b7} sonnet-5-5/u))).toBeDefined();
    await ui.press({ key: "agent-list" });
    await ui.press({ key: "agent-ag1" });
    expect(await ui.find(TEXT(/^Explore$/))).toBeDefined();
    expect(await ui.find(TEXT(/find the bug \u{b7} finished \u{b7} sonnet-5-5/u))).toBeDefined();
    // 111k of the agent's own 200k window.
    expect(await ui.find(TEXT(/^Current context \u{b7} 56% of its window$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^111k$/))).toBeDefined();
    expect(await ui.find(TEXT(/^Highest context \u{b7} 56% of its window$/u))).toBeDefined();
    // The prompt is one wrapped text, its lines kept.
    expect(await ui.find(TEXT(/^find the bug in the parser\nand report the file$/))).toBeDefined();
    expect(await ui.find({ key: "agent-tool-Bash" })).toBeDefined();
    expect(await ui.find(TEXT(/^2$/))).toBeDefined();
    expect(await ui.find(TEXT(/v open/))).toBeDefined();
    expect(await ui.find(TEXT(/b back/))).toBeDefined();
    expect((await ui.find({ key: "agent-transcript" }))?.props.hotkey).toBe("v");
    expect((await ui.find({ key: "agent-back" }))?.props.hotkey).toBe("b");
    // The tab's own lists are not drawn for an agent.
    expect(await ui.find({ key: "part-system" })).toBeUndefined();
    await ui.press({ key: "agent-back" });
    expect(await ui.find({ key: "part-system" })).toBeDefined();
    expect(await ui.find(TEXT(/b back/))).toBeUndefined();
    await ui.unmount();
  });

  test("an agent the engine no longer lists reads as finished; an unreadable list leaves the rest working", async ($, on) => {
    const r = rig(on);
    r.agents.v = "fail";
    await withAgents($, r);
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-context" });
    await r.clock.settle();
    await ui.press({ key: "agent-next" });
    expect(await ui.find(TEXT(/ \u{b7} finished/u))).toBeDefined();
    expect(await ui.find(TEXT(/ \u{b7} running/u))).toBeUndefined();
    await ui.unmount();
  });

  test("the chosen agent is kept apart from the Usage tab's agent filter", async ($, on) => {
    const r = rig(on);
    r.agents.v = [status("ag1", "running"), status("ag2", "running")];
    await withAgents($, r);
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-context" });
    await r.clock.settle();
    await ui.press({ key: "agent-next" });
    await ui.press({ key: "tab-usage" });
    await r.clock.settle();
    expect(await ui.find({ key: "body-usage" })).toBeDefined();
    await ui.press({ key: "tab-context" });
    await r.clock.settle();
    // Back on Context the same agent is still the one shown.
    expect(await ui.find({ key: "agent-back" })).toBeDefined();
    await ui.unmount();
  });
});

// A sub-agent transcript of `pairs` tool calls, each with a 2400-character result, ending in a last answer.
function transcript(pairs: number): string {
  const ts = (i: number) => new Date(NOW - 3_000_000 + i * 1000).toISOString();
  const out: string[] = [JSON.stringify({ type: "user", timestamp: ts(0), sessionId: "s-1", isSidechain: true, message: { role: "user", content: "find the bug in the parser" } })];
  for (let i = 0; i < pairs; i++) {
    out.push(
      JSON.stringify({
        type: "assistant",
        timestamp: ts(2 * i + 1),
        requestId: `rq${i}`,
        sessionId: "s-1",
        isSidechain: true,
        message: { id: `m${i}`, model: SONNET, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "tool_use", id: `tu${i}`, name: "Bash", input: { command: `echo step-${i}` } }] },
      }),
    );
    out.push(JSON.stringify({ type: "user", timestamp: ts(2 * i + 2), sessionId: "s-1", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu${i}`, content: "x".repeat(2400) }] } }));
  }
  out.push(closingLine(pairs, "All done: the bug is in the lexer."));
  return `${out.join("\n")}\n`;
}

const closingLine = (pairs: number, text: string): string =>
  JSON.stringify({ type: "assistant", timestamp: new Date(NOW - 3_000_000 + (2 * pairs + 1) * 1000).toISOString(), requestId: `rq-last${pairs}`, sessionId: "s-1", isSidechain: true, message: { id: `m-last${pairs}`, model: SONNET, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text }] } });

// Lines to append to `transcript(from)`: calls from..to-1, then a new closing text.
function transcriptMore(from: number, to: number, answer: string): string {
  const ts = (i: number) => new Date(NOW - 3_000_000 + i * 1000).toISOString();
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    out.push(JSON.stringify({ type: "assistant", timestamp: ts(2 * i + 3), requestId: `rq${i}`, sessionId: "s-1", isSidechain: true, message: { id: `m${i}`, model: SONNET, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "tool_use", id: `tu${i}`, name: "Bash", input: { command: `echo step-${i}` } }] } }));
    out.push(JSON.stringify({ type: "user", timestamp: ts(2 * i + 4), sessionId: "s-1", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu${i}`, content: "x".repeat(2400) }] } }));
  }
  out.push(closingLine(to + 1, answer));
  return `${out.join("\n")}\n`;
}

describe("context tab: transcript view", () => {
  const FILE = (id: string) => `${CFG}/projects/${PROJECT}/s-1/subagents/agent-${id}.jsonl`;

  async function openTranscript($: Engine, r: Rig, id: string, state: AgentInfo["status"] = "completed") {
    r.breakdown = { summary: bd(), full: bd() };
    r.agents.v = [status(id, state)];
    await start($);
    await r.clock.settle();
    await spawn(r, $, id, "Explore", "find the bug", "find the bug in the parser");
    await step($, 1, id);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-context" });
    await r.clock.settle();
    await ui.press({ key: "agent-next" });
    await ui.press({ key: "agent-transcript" });
    await r.clock.settle();
    return ui;
  }

  test("a 6 MiB sub-agent transcript opens in chunks of at most 4 MiB and lists its tool calls", async ($, on) => {
    const r = rig(on);
    const text = transcript(2400);
    expect(text.length).toBeGreaterThan(6 * 1_048_576);
    r.world.put(FILE("big1"), text);
    const ui = await openTranscript($, r, "big1");
    const reads = r.world.reads.filter((x) => x.path === FILE("big1"));
    expect(reads.length).toBeGreaterThan(2);
    expect(Math.max(...reads.map((x) => x.length ?? 0))).toBeLessThanOrEqual(4_194_304);
    // Every call is counted; the newest 40 are listed, latest last, each with its result's size.
    expect(await ui.find(TEXT(/^2400 calls$/))).toBeDefined();
    expect(await ui.find(TEXT(/^2360 older calls hidden$/))).toBeDefined();
    expect(await ui.find({ key: "call-2399" })).toBeDefined();
    expect(await ui.find({ key: "call-2360" })).toBeDefined();
    expect(await ui.find({ key: "call-2359" })).toBeUndefined();
    expect(await ui.find(TEXT(/^Bash$/))).toBeDefined();
    expect(await ui.find(TEXT(/^echo step-2399$/))).toBeDefined();
    expect(await ui.find(TEXT(/^~600$/))).toBeDefined();
    expect(await ui.find(TEXT(/^find the bug in the parser$/))).toBeDefined();
    expect(await ui.find(TEXT(/^All done: the bug is in the lexer\.$/))).toBeDefined();
    expect(await ui.find(TEXT(/b back/))).toBeDefined();
    // b returns to the agent's detail, then v opens it again.
    await ui.press({ key: "transcript-back" });
    expect(await ui.find({ key: "agent-transcript" })).toBeDefined();
    expect(await ui.find({ key: "call-2399" })).toBeUndefined();
    await ui.unmount();
  });

  test("a small transcript lists every call and keeps the same rows when read again", async ($, on) => {
    const r = rig(on);
    r.world.put(FILE("small1"), transcript(3));
    const ui = await openTranscript($, r, "small1");
    expect(await ui.find(TEXT(/^3 calls$/))).toBeDefined();
    expect(await ui.find({ key: "call-0" })).toBeDefined();
    expect(await ui.find({ key: "call-2" })).toBeDefined();
    expect(await ui.find(TEXT(/older call/))).toBeUndefined();
    await ui.unmount();
  });

  test("an agent read while it ran shows its last calls and reply once it has finished", async ($, on) => {
    const r = rig(on);
    r.world.put(FILE("grow1"), transcript(3));
    const ui = await openTranscript($, r, "grow1", "running");
    expect(await ui.find(TEXT(/^3 calls$/))).toBeDefined();
    expect(await ui.find(TEXT(/^All done: the bug is in the lexer\.$/))).toBeDefined();
    const sizeBefore = r.world.size(FILE("grow1"))!;
    r.world.append(FILE("grow1"), transcriptMore(3, 5, "Fixed it in lexer.ts."));
    r.agents.v = [status("grow1", "completed")];
    await r.clock.advance(16_000);
    await redraw(ui, r);
    expect(await ui.find(TEXT(/^5 calls$/))).toBeDefined();
    expect(await ui.find({ key: "call-4" })).toBeDefined();
    expect(await ui.find(TEXT(/^Fixed it in lexer\.ts\.$/))).toBeDefined();
    expect(await ui.find(TEXT(/^All done: the bug is in the lexer\.$/))).toBeUndefined();
    // The second read continues from the end of the first, so no call is listed twice.
    const reads = r.world.reads.filter((x) => x.path === FILE("grow1"));
    expect(reads.some((x) => x.offset === sizeBefore)).toBe(true);
    await ui.unmount();
  });

  test("negative: a file that has not grown is not read again, finished agent or not", async ($, on) => {
    const r = rig(on);
    r.world.put(FILE("still1"), transcript(3));
    const ui = await openTranscript($, r, "still1");
    expect(await ui.find(TEXT(/^3 calls$/))).toBeDefined();
    const before = r.world.reads.filter((x) => x.path === FILE("still1")).length;
    await r.clock.advance(60_000);
    await redraw(ui, r);
    expect(r.world.reads.some((x) => x.path === FILE("still1") && x.offset > 0)).toBe(false);
    expect(await ui.find(TEXT(/^3 calls$/))).toBeDefined();
    expect(r.world.reads.filter((x) => x.path === FILE("still1")).length).toBe(before);
    await ui.unmount();
  });

  test("a finished agent's transcript grows after the list of agents failed to read", async ($, on) => {
    const r = rig(on);
    r.world.put(FILE("lost1"), transcript(2));
    const ui = await openTranscript($, r, "lost1", "running");
    r.agents.v = "fail";
    expect(await ui.find(TEXT(/^2 calls$/))).toBeDefined();
    r.world.append(FILE("lost1"), transcriptMore(2, 4, "Done."));
    await r.clock.advance(16_000);
    await redraw(ui, r);
    expect(await ui.find(TEXT(/^4 calls$/))).toBeDefined();
    await ui.unmount();
  });

  test("a transcript not on disk says so instead of failing", async ($, on) => {
    const r = rig(on);
    const ui = await openTranscript($, r, "gone1");
    expect(await ui.find(TEXT(/^no transcript file for this agent yet$/))).toBeDefined();
    await ui.unmount();
  });
});

describe("context pieces", () => {
  test("contextOf splits loaded and deferred tokens, sorts by weight and totals the deferred category", () => {
    const c = contextOf("s", 1, "counted", bd());
    expect(c.system).toBe(3000);
    expect(c.tools).toBe(8000);
    expect(c.messages).toBe(20_000);
    expect(c.deferred).toBe(900);
    expect(c.mcp.map((m) => [m.name, m.tokens, m.deferred])).toEqual([
      ["demo", 4000, 0],
      ["lazy", 0, 900],
      ["idle", 500, 0],
    ]);
    // The free space and the deferred row are not the window's own parts.
    expect(c.system + c.tools + c.messages).toBe(31_000);
  });

  test("unusedIn matches a plugin's entry by its bare name and marks nothing before the index is read", () => {
    const rows = [{ name: "plug:deploy", tokens: 1, deferred: 0 }, { name: "other", tokens: 1, deferred: 0 }];
    expect([...unusedIn("skills", rows, { skills: ["deploy"], mcp: [], agents: [] })]).toEqual(["other"]);
    expect(unusedIn("skills", rows, null).size).toBe(0);
  });

  test("mergeUsed adds the live tally's servers and agent types", () => {
    const used = mergeUsed({ skills: ["a"], mcp: ["x"], agents: [] }, { toolCalls: { mcp__live__t: 1, Read: 3 }, agents: { g: { id: "g", type: "Explore", description: "", model: "", context: 0, peak: 0, firstPrompt: "", tools: {}, usd: 0, lastTs: 0 } } });
    expect(used).toEqual({ skills: ["a"], mcp: ["x", "tally", "live"], agents: ["Explore"] });
    expect(mergeUsed({ skills: [], mcp: [], agents: [] }, { toolCalls: {}, agents: {} }).mcp).toEqual(["tally"]);
  });

  test("needsContext, needsAgentStates, needsTranscript and isActive", () => {
    expect(needsContext({ sessionId: "", at: 0 }, "s", 1)).toBe(true);
    expect(needsContext({ sessionId: "s", at: 1000 }, "s", 1000 + 119_999)).toBe(false);
    expect(needsContext({ sessionId: "s", at: 1000 }, "s", 1000 + 120_000)).toBe(true);
    expect(needsContext({ sessionId: "other", at: 1000 }, "s", 1001)).toBe(true);
    expect(needsContext({ sessionId: "", at: 0 }, "", 1)).toBe(false);
    expect(needsAgentStates({ at: 0 }, 9999)).toBe(false);
    expect(needsAgentStates({ at: 0 }, 10_000)).toBe(true);
    expect(needsTranscript(undefined, 0)).toBe(true);
    expect(needsTranscript({ status: "loading", at: 0 }, 99_999)).toBe(false);
    // A finished agent's file is checked again too: it can have grown since the last read.
    expect(needsTranscript({ status: "ready", at: 0 }, 14_999)).toBe(false);
    expect(needsTranscript({ status: "ready", at: 0 }, 15_000)).toBe(true);
    expect(needsTranscript({ status: "failed", at: 0 }, 15_000)).toBe(true);
    expect(["running", "waiting", "idle", "pending"].map(isActive)).toEqual([true, true, true, true]);
    expect(["completed", "failed", "killed", undefined].map(isActive)).toEqual([false, false, false, false]);
  });

  test("agents are ordered running first, then newest request first", () => {
    const a = (id: string, lastTs: number) => ({ id, type: "t", description: "", model: "", context: 0, peak: 0, firstPrompt: "", tools: {}, usd: 0, lastTs });
    const live = { agents: { old: a("old", 1), new: a("new", 5), run: a("run", 2) } };
    const order = agentOrderOf(live, { byId: { run: { status: "running" }, old: { status: "completed" }, new: { status: "completed" } } });
    expect(order.map((x) => x.id)).toEqual(["run", "new", "old"]);
  });

  test("the key line names v, b and the agent keys only when the tab has them", () => {
    expect(keyLine("context")).toEqual(["0-5 switch tab", "esc collapse"]);
    const line = keyLine("context", { agents: true, canView: true, canGoBack: true, more: true });
    expect(line).toContain("a agent list");
    expect(line).toContain("v open agent");
    expect(line).toContain("b return");
    expect(line).toContain("m full lists");
  });

  test("the transcript builder drops a call a split request repeats, keeps the newest calls and pairs results", () => {
    const b = transcriptBuilder(3);
    const call = (id: string, command: string): UsageRow => ({ ...req({ id: `r-${id}`, at: 0 }), tools: [{ name: "Bash", id, command, inputChars: 1 }] });
    b.add({ t: "user", row: { sessionId: "s", ts: 1, kind: "prompt", chars: 3, text: "do it" } });
    for (const id of ["a", "b", "b", "c", "d", "e"]) b.add({ t: "usage", row: call(id, `cmd ${id}`) });
    b.add({ t: "user", row: { sessionId: "s", ts: 2, kind: "toolResult", chars: 80, toolUseId: "e", results: [{ toolUseId: "e", chars: 80 }] } });
    // The result of a call that fell out of the kept window is ignored.
    b.add({ t: "user", row: { sessionId: "s", ts: 3, kind: "toolResult", chars: 9, toolUseId: "a", results: [{ toolUseId: "a", chars: 9 }] } });
    const v = b.view("fin");
    expect(v.prompt).toBe("do it");
    expect(v.total).toBe(5);
    expect(v.calls.map((c) => [c.item, c.resultChars])).toEqual([["cmd c", null], ["cmd d", null], ["cmd e", 80]]);
    expect(v.answer).toBe("fin");
  });

  test("oneLine joins whitespace runs, trims, and ends a long text with an ellipsis at the cap", () => {
    expect(oneLine("  a \n\t b   c  ", 80)).toBe("a b c");
    expect(oneLine("abcdef", 6)).toBe("abcdef");
    expect(oneLine("abcdefg", 6)).toBe("abcde\u{2026}");
    expect(oneLine("ab cd ef", 5)).toBe("ab c\u{2026}");
    expect(oneLine("", 5)).toBe("");
    expect(oneLine(" ".repeat(100_000), 5)).toBe("");
    expect(oneLine(`word ${"x ".repeat(100_000)}`, 10).length).toBe(10);
  });

  test("the transcript builder takes the first user prompt only", () => {
    const b = transcriptBuilder();
    const user = (text: string) => ({ t: "user", row: { kind: "prompt", text } }) as never;
    b.add(user("first"));
    b.add(user("second"));
    expect(b.view("").prompt).toBe("first");
  });

  test("lastAnswer reads the last assistant text and skips a cut first line and tool-only messages", () => {
    const text = (t: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
    const tool = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] } });
    expect(lastAnswer(`ial":1}\n${text("first")}\n${text("the end")}\n${tool}\n`)).toBe("the end");
    expect(lastAnswer(`${tool}\n`)).toBe("");
    expect(lastAnswer("")).toBe("");
  });
});

describe("MCP figures on the Session tab", () => {
  // Controller ruling A: a server's result re-read is summed before the lists are cut to the top 40.
  const bigScenario = (servers: number) => {
    const tools = Array.from({ length: servers }, (_, i) => ({ name: `mcp__big__t${i}`, mcpServer: "big", id: `b${i}`, inputChars: 10 }));
    const rows = [
      req({ id: "r1", at: 0, tokens: { input: 1000 }, tools: [...tools, { name: "mcp__small__q", mcpServer: "small", id: "s0", inputChars: 10 }] }),
      req({ id: "r2", at: 2000, tokens: { input: 1000 + (servers + 1) * 100 } }),
      req({ id: "r3", at: 3000, tokens: { cacheRead: 1_000_000 } }),
    ];
    const users = [...tools.map((t) => result(1000, t.id, 400)), result(1000, "s0", 400)];
    return analyzeFlow({ rows, users, compacts: [], counted: () => true, cacheReadUsd: () => READ_USD });
  };

  test("the per-server re-read covers every result, not only the 40 the list keeps", () => {
    const out = bigScenario(60);
    expect(out.flow.length).toBe(40);
    const listed = out.flow.filter((f) => f.label.startsWith("mcp__big__")).reduce((n, f) => n + f.rereadUsd, 0);
    // 60 results of 100 tokens, each re-read once at $1 per MTok; the list shows 40 of them at most.
    expect(Math.abs(out.mcpReread.big! - 60 * 100 * READ_USD) < 1e-12).toBe(true);
    expect(listed).toBeLessThan(out.mcpReread.big! - 1e-9);
    expect(Math.abs(out.mcpReread.small! - 100 * READ_USD) < 1e-12).toBe(true);
  });

  test("negative: with the list not cut the figure is the same as the sum of the listed parts", () => {
    const out = bigScenario(10);
    const listed = out.flow.filter((f) => f.label.startsWith("mcp__big__")).reduce((n, f) => n + f.rereadUsd, 0);
    expect(Math.abs(out.mcpReread.big! - listed) < 1e-12).toBe(true);
    expect(out.mcpReread.nothing).toBeUndefined();
  });

  test("summarize carries the per-server figure", () => {
    const shard: Shard = {
      v: 1,
      project: "p",
      files: {},
      usage: [
        { ...req({ id: "r1", at: 0, tokens: { input: 1000 }, tools: [{ name: "mcp__big__t0", mcpServer: "big", id: "b0", inputChars: 10 }] }), ts: T0 },
        { ...req({ id: "r2", at: 0, tokens: { input: 1100 } }), ts: T0 + 2000 },
        { ...req({ id: "r3", at: 0, tokens: { cacheRead: 1_000_000 } }), ts: T0 + 3000 },
      ],
      users: [{ ...result(0, "b0", 400), ts: T0 + 1000 }],
      metas: [],
      compacts: [],
      snapshots: [],
    };
    const s = summarize([shard], PRICES, { span: "30d", nowMs: T0 + 10_000, tzOffsetMin: 0 });
    expect(s.mcpReread.big).toBeGreaterThan(0);
    expect(Object.keys(s.mcpReread)).toEqual(["big"]);
  });

  // Controller ruling C: sub-agents' result re-reads count toward the server's figure.
  test("a sub-agent's results count toward its server's figure; the figure is main plus sub", () => {
    const tool = (id: string) => ({ name: "mcp__big__t", mcpServer: "big", id, inputChars: 10 });
    const conv = (sub: boolean, id: string) => {
      const wrap = <T extends UsageRow>(row: T): T => (sub ? inAgent(row, "ag1") : row);
      const rows = [wrap({ ...req({ id: `${id}1`, at: 0, tokens: { input: 1000 }, tools: [tool(id)] }) }), wrap(req({ id: `${id}2`, at: 2000, tokens: { input: 1200 } })), wrap(req({ id: `${id}3`, at: 3000, tokens: { cacheRead: 100_000 } }))];
      const r = result(1000, id, 800, "s", sub);
      return { rows, users: [sub ? { ...r, agentId: "ag1" } : r] };
    };
    const run = (...parts: Array<ReturnType<typeof conv>>) => analyzeFlow({ rows: parts.flatMap((p) => p.rows), users: parts.flatMap((p) => p.users), compacts: [], counted: () => true, cacheReadUsd: () => READ_USD }).mcpReread.big ?? 0;
    const main = run(conv(false, "m"));
    const sub = run(conv(true, "q"));
    expect(main).toBeGreaterThan(0);
    expect(sub).toBeGreaterThan(0);
    expect(Math.abs(run(conv(false, "m"), conv(true, "q")) - (main + sub)) < 1e-12).toBe(true);
  });

  test("liveMcp prices resident schemas over this launch's main requests and drops servers with nothing", () => {
    const rows = liveMcp({ toolCalls: { mcp__demo__lookup: 2, Read: 5, mcp__quiet__x: 0 }, mainRequests: { [OPUS]: 3 } }, { demo: 100_000, idle: 500_000 }, BUILTIN_PRICES);
    // $0.2 per MTok x 100k x 3 requests = 6 cents; the idle server has a schema, no calls.
    expect(rows.map((x) => x.server)).toEqual(["idle", "demo"]);
    expect(Math.abs(rows[1]!.usd - 100_000 * 0.2e-6 * 3) < 1e-12).toBe(true);
    expect(rows[1]!.calls).toBe(2);
    // No main request: schemas cost nothing, and only a called server stays.
    expect(liveMcp({ toolCalls: { mcp__demo__lookup: 1 }, mainRequests: {} }, { demo: 100_000, idle: 5 }, BUILTIN_PRICES).map((x) => [x.server, x.usd, x.calls])).toEqual([["demo", 0, 1]]);
    expect(liveMcp({ toolCalls: {}, mainRequests: { [OPUS]: 3 } }, {}, BUILTIN_PRICES)).toEqual([]);
  });

  // Controller ruling B: a session with no indexed rows still shows its servers, marked estimated.
  test("a pure-live session shows an MCP row marked ~; a session the index knows does not", async ($, on) => {
    const r = rig(on);
    const heavy = bd({ mcpTools: [{ name: "mcp__demo__lookup", serverName: "demo", tokens: 100_000, isLoaded: true }] });
    r.breakdown = { summary: heavy, full: heavy };
    await start($);
    await r.clock.settle();
    await step($, 0);
    await step($, 1);
    await $.tool.call({ tool: "mcp__demo__lookup", input: {} } as never);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find({ key: "mcp-demo" })).toBeDefined();
    expect(await ui.find(TEXT(/^demo \u{b7} 1 call$/u))).toBeDefined();
    // 100k tokens x $0.2 per MTok x 2 main requests = 4 cents.
    expect(await ui.find(TEXT(/^~(?:\$0\.04|4\.0\u{a2})$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^~ schemas only, from this launch's requests/))).toBeDefined();
    expect(await ui.find(TEXT(/^schemas: main requests; results: main and sub-agents$/))).toBeUndefined();
    await ui.unmount();
  });

  test("negative: with indexed rows the row has no ~ and the scope note names sub-agents", async ($, on) => {
    const r = rig(on);
    const heavy = bd({ mcpTools: [{ name: "mcp__demo__lookup", serverName: "demo", tokens: 100_000, isLoaded: true }] });
    r.breakdown = { summary: heavy, full: heavy };
    await seedIndex(r.world);
    await start($);
    await r.clock.settle();
    await step($, 0);
    await $.turn.complete({ turnId: "t1", answer: "done", durationMs: 1000, isAborted: false, reason: "answer" } as never);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find({ key: "mcp-demo" })).toBeDefined();
    expect(await ui.find(TEXT(/^~[0-9.]+\u{a2}$/u))).toBeUndefined();
    expect(await ui.find(TEXT(/^schemas: main requests; results: main and sub-agents$/))).toBeDefined();
    expect(await ui.find(TEXT(/schemas only, from this launch's requests/))).toBeUndefined();
    await ui.unmount();
  });
});
