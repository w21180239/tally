import type { On, RenderInput, TurnStepInput, TurnStepResult, TurnUsage } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";
import { linesOf } from "./render.ts";
import type { BreakdownInput, BreakdownSnapshot } from "../core/breakdown.ts";
import type { Shard } from "../core/shard.ts";
import { dayIdx, saveBuckets } from "../engine/project-store.ts";
import { wireLive } from "../engine/live.ts";
import { loadSnapshots, saveSnapshot, takeSnapshot, KEEP_PER_SESSION } from "../engine/snapshot.ts";
import { req } from "./fixtures/rows.ts";
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
  props: { title: "tally", isFocused: true, bodyColumns: 89, placement: "dock", scroll: { offset: 0, bodyRows: 50 }, view: {} },
};
const TEXT = (re: RegExp) => ({ type: "Text" as const, text: re });

type Breakdowns = { summary?: BreakdownInput & Record<string, unknown>; full?: BreakdownInput & Record<string, unknown> };
type Rig = { world: World; clock: ReturnType<typeof mock.clock>; sid: { v: string }; stored: Map<string, unknown>; breakdown: Breakdowns; usageCalls: Array<string | undefined> };

// The main thread's write names its life (1 hour); a sub-agent's does not.
function usageOf(model: string, isMain: boolean): TurnUsage {
  return { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000, model, ...(isMain && { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 }) };
}

/** The engine beneath tally: clock, env, store, session facts, the fs in memory, steps priced per loop. */
function rig(on: On): Rig {
  const world = worldOf();
  const r: Rig = { world, clock: mock.clock(on, { now: NOW }), sid: { v: "s-1" }, stored: new Map(), breakdown: {}, usageCalls: [] };
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
  on("session.id", () => ({ value: r.sid.v }));
  on("session.cwd", () => ({ value: CWD }));
  on("session.model", () => ({ value: OPUS }));
  on("session.info", () => ({ value: { platform: "linux" } }));
  on("session.usage", (_, e) => {
    r.usageCalls.push(e.breakdown);
    const b = e.breakdown === undefined ? undefined : r.breakdown[e.breakdown];
    return { value: { startedAt: NOW, context: { tokens: 236_000, window: 1_000_000, percent: 24, ...(b !== undefined && { breakdown: b }) }, rateLimits: [], cost: { usd: 0 } } as never };
  });
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

/** A `$` for engine helpers called directly: the world's fs and clock, and the session answers the rig gives. */
function fake(r: Rig): never {
  return {
    ...r.world.$,
    session: {
      id: async () => r.sid.v,
      cwd: async () => CWD,
      info: async () => ({ platform: "linux" }),
      usage: async (a?: { breakdown?: "summary" | "full" }) => {
        r.usageCalls.push(a?.breakdown);
        const b = a?.breakdown === undefined ? undefined : r.breakdown[a.breakdown];
        if (a?.breakdown === "full" && b === undefined) throw new Error("the token count is unavailable");
        return { context: { window: 1_000_000, ...(b !== undefined && { breakdown: b }) } };
      },
    },
    env: { get: async (name: string) => (name === "HOME" ? "/home/u" : undefined) },
    clock: { ...r.world.$.clock, now: async () => NOW },
  } as never;
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
const mainStep = async ($: Engine, index: number, agentId?: string) => {
  const input: TurnStepInput = { turnId: "t1", index, model: OPUS, messageCount: 2 + index, ...(agentId !== undefined && { agentId }) } as TurnStepInput;
  const stream = $.turn.step(input);
  for await (const chunk of stream) void chunk;
  await stream.result;
};
const finishTurn = ($: Engine, durationMs: number) => $.turn.complete({ turnId: "t1", answer: "done", durationMs, isAborted: false, reason: "answer" } as never);

// An earlier launch of s-1: three main requests of $0.014 each, the first calling the `demo` MCP server.
async function seedEarlier(w: World, session = "s-1"): Promise<void> {
  const rows = [0, 1, 2].map((i) => ({
    ...req({
      id: `e${i}`,
      session,
      at: 0,
      tokens: { input: 1000, cacheRead: 50_000 },
      ...(i === 0 && { tools: [{ name: "mcp__demo__lookup", mcpServer: "demo", id: "tu0", inputChars: 10 }] }),
    }),
    ts: NOW - 3_600_000 + i * 60_000,
  }));
  const byDay = new Map<number, Shard>();
  for (const row of rows) {
    const d = dayIdx(row.ts);
    const sh = byDay.get(d) ?? { v: 1, project: PROJECT, files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
    sh.usage.push(row);
    byDay.set(d, sh);
  }
  await saveBuckets(w.$, CFG, PROJECT, { days: byDay }, {}, NOW);
}

const breakdownOf = (mcpTokens: number, extra: Partial<BreakdownInput> = {}): BreakdownInput & Record<string, unknown> => ({
  categories: [
    { name: "System prompt", tokens: 3000, kind: "used" },
    { name: "System tools", tokens: 8000, kind: "used" },
  ],
  mcpTools: [{ name: "mcp__demo__lookup", serverName: "demo", tokens: mcpTokens, isLoaded: true }],
  agents: [],
  memoryFiles: [],
  skills: { skillFrontmatter: [] },
  autoCompactThreshold: 800_000,
  ...extra,
});

const foreign = (ts: number, tokens = 100_000): BreakdownSnapshot => ({ sessionId: "other-session", ts, skills: {}, mcp: { demo: { tokens, deferred: 0 } }, agents: {}, memory: {}, system: 0, tools: 0 });

describe("session tab", () => {
  test("the body holds the headline, the models, where it went, the cache and the top hint", async ($, on) => {
    const r = rig(on);
    await seedEarlier(r.world);
    await start($);
    await r.clock.settle();
    await mainStep($, 0);
    await mainStep($, 1, "ag-1");
    await finishTurn($, 1_800_000);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find({ key: "body-session" })).toBeDefined();
    expect(await ui.find(TEXT(/^Where it went$/))).toBeDefined();
    expect(await ui.find(TEXT(/^Billed kinds$/))).toBeDefined();
    expect(await ui.find(TEXT(/^Prompt cache$/))).toBeDefined();
    expect(await ui.find(TEXT(/^Leading hint$/))).toBeDefined();
    // The by-model legend names both models, and each sums its earlier-launch, live and cached parts.
    expect(await ui.find(TEXT(/opus-5-5 /))).toBeDefined();
    expect(await ui.find(TEXT(/sonnet-5-5 /))).toBeDefined();
    // Main row carries its model; the sub-agent row is its own line.
    expect(await ui.find({ key: "went-0" })).toBeDefined();
    expect(await ui.find({ key: "went-1" })).toBeDefined();
    expect(await ui.find(TEXT(/an hour while working$/))).toBeDefined();
    expect(await ui.find(TEXT(/of it came before this launch$/))).toBeDefined();
    await ui.unmount();
  });

  test("Where it went rows read the live tally: main step, sub-agent step, earlier launch, all adding up to the headline", async ($, on) => {
    const r = rig(on);
    await seedEarlier(r.world);
    await start($);
    await r.clock.settle();
    await mainStep($, 0);
    await mainStep($, 1, "ag-1");
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    // Opus step: 1000*4 + 100000*0.2 + 10000*8 + 500*20 = 114000 -> 11.4 cents; earlier launch 3 x 1.4 cents = 4.2 cents -> main 15.6 cents.
    // Sonnet sub-agent step at the 5-minute write price: 2000 + 10000 + 25000 + 5000 = 42000 -> 4.2 cents. Total 19.8 cents.
    const main = await ui.find({ key: "went-0" });
    expect(main).toBeDefined();
    // The legend is its own column of amounts, all under $1, so in cents; the rows share the tab's one dollar column.
    expect(await ui.find(TEXT(/opus-5-5 15\.6\u{a2}$/u))).toBeDefined();
    expect(await ui.find(TEXT(/sonnet-5-5 4\.2\u{a2}$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^\$0\.20$/))).toBeDefined();
    expect(await ui.find(TEXT(/^\$0\.16$/))).toBeDefined();
    expect(await ui.find(TEXT(/^\$0\.04$/))).toBeDefined();
    await ui.unmount();
  });

  test("an MCP server's row shows its cost, starred while only another session's snapshot backs the schema figure", async ($, on) => {
    const r = rig(on);
    await seedEarlier(r.world, "s-1");
    // Only a snapshot from another session, a day before; the engine gives no breakdown now.
    await saveSnapshot(r.world.$, CFG, PROJECT, foreign(NOW - 86_400_000));
    await start($);
    await r.clock.settle();
    await mainStep($, 0);
    await finishTurn($, 1000);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find(TEXT(/^MCP servers$/))).toBeDefined();
    const row = await ui.find({ key: "mcp-demo" });
    expect(row).toBeDefined();
    // 100k resident schema tokens x $0.2 per MTok x 3 main requests = 6 cents; the label counts the one call.
    expect(await ui.find(TEXT(/^demo \u{b7} 1 call$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^(?:\$0\.06|6\.0\u{a2})\*$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^\* schema sizes from a snapshot taken in another session$/))).toBeDefined();
    await ui.unmount();
  });

  test("with a snapshot of its own the same row has no star and no footnote", async ($, on) => {
    const r = rig(on);
    r.breakdown = { summary: breakdownOf(100_000), full: breakdownOf(100_000) };
    await seedEarlier(r.world, "s-1");
    await saveSnapshot(r.world.$, CFG, PROJECT, foreign(NOW - 1000, 5));
    await start($);
    await r.clock.settle();
    await mainStep($, 0);
    await finishTurn($, 1000);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find(TEXT(/^(?:\$0\.06|6\.0\u{a2})$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^(?:\$0\.06|6\.0\u{a2})\*$/u))).toBeUndefined();
    expect(await ui.find(TEXT(/snapshot taken in another session/))).toBeUndefined();
    await ui.unmount();
  });

  test("another session's figures are not drawn for this one", async ($, on) => {
    const r = rig(on);
    await seedEarlier(r.world, "s-1");
    await saveSnapshot(r.world.$, CFG, PROJECT, foreign(NOW));
    await start($);
    await r.clock.settle();
    r.sid.v = "s-9";
    await $.prompt.submit({ text: "next", wait: false, origin: { kind: "composer" } } as never);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find({ key: "mcp-demo" })).toBeUndefined();
    await ui.unmount();
  });

  test("token rows drill to Usage on this session, and the key line says rows open", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    await mainStep($, 0);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find(TEXT(/tab\/enter open/))).toBeDefined();
    const kinds = (await ui.findAll({ type: "Button" })).map((b) => b.props.key).filter((k) => typeof k === "string" && k.startsWith("open-kind-"));
    expect(kinds).toEqual(["open-kind-input", "open-kind-output", "open-kind-cacheRead", "open-kind-cacheWrite", "open-kind-cw1h"]);
    await ui.press({ key: "open-kind-cacheRead" });
    expect(await ui.find({ key: "body-usage" })).toBeDefined();
    expect(r.stored.get("tab")).toBe("usage");
    expect(r.stored.get("span")).toBe("session");
    await ui.unmount();
  });

  test("the cache section lists main and each warm sub-agent with time left; a cold sub-agent is left out", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    await mainStep($, 0);
    await mainStep($, 1, "warm");
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find({ key: "cache-main" })).toBeDefined();
    expect(await ui.find({ key: "cache-warm" })).toBeDefined();
    await r.clock.advance(6 * 60_000);
    await ui.unmount();
    const later = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await later.find({ key: "cache-warm" })).toBeUndefined();
    expect(await later.find({ key: "cache-main" })).toBeDefined();
    await later.unmount();
  });

  test("past six sub-agents the rest fold under m, which opens them all", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    await mainStep($, 0);
    for (let i = 0; i < 8; i++) await mainStep($, i + 1, `z${i}`);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find({ key: "went-6" })).toBeDefined();
    expect(await ui.find({ key: "went-7" })).toBeUndefined();
    expect(await ui.find(TEXT(/^2 more sub-agents$/))).toBeDefined();
    expect(await ui.find(TEXT(/m more/))).toBeDefined();
    expect((await ui.find({ key: "lists-more" }))?.props.hotkey).toBe("m");
    await ui.press({ key: "lists-more" });
    expect(await ui.find({ key: "went-8" })).toBeDefined();
    expect(await ui.find(TEXT(/^2 more sub-agents$/))).toBeUndefined();
    await ui.press({ key: "lists-more" });
    expect(await ui.find({ key: "went-7" })).toBeUndefined();
    await ui.unmount();
  });

  test("VS Code draws the by-model bar as Svg and the terminal as coloured text segments", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    await mainStep($, 0);
    await mainStep($, 1, "ag-1");
    await r.clock.settle();
    const code = await $.ui.mount({ plugin: PLUGIN, surface: "vscode", ...PANE });
    const alts = (await code.findAll({ type: "Svg" })).map((s) => s.props.alt);
    expect(alts).toContain("spend by model");
    await code.unmount();
    const term = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    const segs = await term.findAll({ key: "model-bar" });
    expect(segs.length).toBe(1);
    // Each model's segment is its own shape as well as its own colour, so the split reads without colour.
    expect(await term.find(TEXT(/^\u{2588}+$/u))).toBeDefined();
    expect(await term.find(TEXT(/^\u{2593}+$/u))).toBeDefined();
    expect(await term.find(TEXT(/^\u{2593}$/u))).toBeDefined();
    expect((await term.findAll({ type: "Svg" })).length).toBe(0);
    await term.unmount();
  });

  for (const cols of [48, 54, 63, 80, 120, 144]) {
    test(`at ${cols} columns every row is one line and each amount column ends on one edge`, async ($, on) => {
      const r = rig(on);
      await seedEarlier(r.world);
      await start($);
      await r.clock.settle();
      await mainStep($, 0);
      await mainStep($, 1, "ag-1");
      await r.clock.settle();
      const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE, props: { ...PANE.props, bodyColumns: cols, scroll: { offset: 0, bodyRows: 200 } } });
      const body = (await ui.find({ key: "body-session" })) as unknown as Parameters<typeof linesOf>[0];
      const tree = (await ui.drawn()) as unknown as { type: string; props?: Record<string, unknown>; children?: unknown[] };
      const rows: Array<Parameters<typeof linesOf>[0]> = [];
      const walk = (n: unknown): void => {
        if (typeof n !== "object" || n === null) return;
        const node = n as { props?: Record<string, unknown>; children?: unknown[] };
        if (node.props?.height === 1) rows.push(n as Parameters<typeof linesOf>[0]);
        for (const c of (node.children ?? []).flat()) walk(c);
      };
      walk(tree);
      expect(body).toBeDefined();
      expect(rows.length).toBeGreaterThan(5);
      const went = rows.filter((n) => String((n as { props: { key?: string } }).props.key ?? "").startsWith("went-")).map((n) => linesOf(n, cols));
      expect(went.length).toBeGreaterThan(1);
      for (const lines of went) expect(lines).toHaveLength(1);
      // Rows that carry a money figure end on the same cell: the tab's bar column is the only thing after it.
      const lens = new Set(went.map((l) => l[0]!.length));
      expect(lens.size).toBe(1);
      for (const n of rows) for (const line of linesOf(n, cols)) expect(line.length).toBeLessThanOrEqual(cols);
      await ui.unmount();
    });
  }

  test("a fresh session draws its empty state without throwing", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    // One state, not a column of empty sections: the situation, then the step that follows.
    expect(await ui.find(TEXT(/^no requests yet$/))).toBeDefined();
    expect(await ui.find(TEXT(/^Nothing has been spent in this session\.$/))).toBeDefined();
    expect(await ui.find(TEXT(/Earlier days are on 4 History/))).toBeDefined();
    expect(await ui.find(TEXT(/^Where it went/))).toBeUndefined();
    expect(await ui.find(TEXT(/^Leading hint/))).toBeUndefined();
    await ui.unmount();
  });
});

describe("breakdown snapshots", () => {
  test("takeSnapshot reads the summary, then the full count, and keeps the full one in the project's folder", async ($, on) => {
    const r = rig(on);
    r.breakdown = { summary: breakdownOf(90_000), full: breakdownOf(100_000, { skills: { skillFrontmatter: [{ name: "deploy", tokens: 40 }] } }) };
    await start($);
    await r.clock.settle();
    r.usageCalls.length = 0;
    const snap = await takeSnapshot(fake(r));
    expect(r.usageCalls).toEqual(["summary", "full"]);
    expect(snap.sessionId).toBe("s-1");
    expect(snap.mcp).toEqual({ demo: { tokens: 100_000, deferred: 0 } });
    expect(snap.skills).toEqual({ deploy: 40 });
    expect(snap.system).toBe(3000);
    expect(snap.tools).toBe(8000);
    const kept = await loadSnapshots(fake(r), CFG, PROJECT, NOW);
    // The summary's write was replaced by the full count's: one snapshot of this time.
    expect(kept.filter((s) => s.sessionId === "s-1").map((s) => s.mcp.demo!.tokens)).toEqual([100_000]);
  });

  test("a full count that fails leaves the summary standing", async ($, on) => {
    const r = rig(on);
    r.breakdown = { summary: breakdownOf(90_000) };
    await start($);
    await r.clock.settle();
    const snap = await takeSnapshot(fake(r));
    expect(snap.mcp.demo!.tokens).toBe(90_000);
    expect((await loadSnapshots(fake(r), CFG, PROJECT, NOW)).some((s) => s.sessionId === "s-1" && s.mcp.demo!.tokens === 90_000)).toBe(true);
  });

  test("an engine that gives no breakdown rejects and writes nothing", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    await expect(takeSnapshot(fake(r))).rejects.toThrow();
    expect(await loadSnapshots(fake(r), CFG, PROJECT, NOW)).toEqual([]);
  });

  // Seven hours of mock time fire about 3800 scanner and timer ticks, each a hook round trip: the slowest test here (1.3 s on a laptop, over 5 s on a CI runner).
  test("a session start takes a snapshot, and one lately taken is not taken again on the next turn", { timeoutMs: 60_000 }, async ($, on) => {
    const r = rig(on);
    r.breakdown = { summary: breakdownOf(90_000), full: breakdownOf(100_000) };
    await start($);
    await r.clock.settle();
    const fulls = () => r.usageCalls.filter((c) => c === "full").length;
    expect(fulls()).toBe(1);
    await mainStep($, 0);
    await finishTurn($, 1000);
    await r.clock.settle();
    expect(fulls()).toBe(1);
    // Past the six-hour interval the next turn takes another.
    await r.clock.advance(7 * 3_600_000);
    await mainStep($, 1);
    await finishTurn($, 1000);
    await r.clock.settle();
    expect(fulls()).toBe(2);
  });

  test("the folder keeps each session's last eight, reads torn files as none, and loads only the 30-day window", async ($, on) => {
    const r = rig(on);
    for (let i = 0; i < KEEP_PER_SESSION + 3; i++) await saveSnapshot(r.world.$, CFG, PROJECT, { ...foreign(NOW - i * 1000), sessionId: "busy" });
    await saveSnapshot(r.world.$, CFG, PROJECT, { ...foreign(NOW - 40 * 86_400_000), sessionId: "old" });
    const listed = await r.world.$.fs.list(`${CFG}/tally/index`);
    expect(listed.length).toBeGreaterThan(0);
    const dir = `${CFG}/tally/index/${listed[0]!.name}/snapshots`;
    r.world.put(`${dir}/torn.json`, "{\"v\":1,\"proj");
    const all = await loadSnapshots(r.world.$, CFG, PROJECT, NOW);
    expect(all.filter((s) => s.sessionId === "busy").length).toBe(KEEP_PER_SESSION);
    expect(all.some((s) => s.sessionId === "old")).toBe(false);
    // Oldest first.
    expect(all.map((s) => s.ts)).toEqual([...all.map((s) => s.ts)].sort((a, b) => a - b));
    expect(await loadSnapshots(r.world.$, CFG, "-no-such-project", NOW)).toEqual([]);
  });
});

describe("carried items", () => {
  test("a /clear leaves the scanner's lease held and its heartbeat running", async ($, on) => {
    const r = rig(on);
    await start($);
    // The scanner starts 100 ms after the session and takes the lease.
    await r.clock.advance(1000);
    await r.clock.settle();
    const lease = () => JSON.parse(r.world.text(`${CFG}/tally/lease.json`) ?? "{}") as { sessionId?: string; beatMs?: number };
    expect(lease().sessionId).toBe("s-1");
    const beat = lease().beatMs ?? 0;
    await $.session.end({ reason: "clear", sessionId: "s-1", resume: { id: "s-1" } } as never);
    r.sid.v = "s-2";
    await r.clock.advance(31_000);
    expect(lease().sessionId).toBe("s-1");
    expect(lease().beatMs ?? 0).toBeGreaterThan(beat);
  });

  test("any other end releases the lease", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.advance(1000);
    await r.clock.settle();
    await $.session.end({ reason: "other", sessionId: "s-1", resume: { id: "s-1" } } as never);
    await r.clock.advance(31_000);
    const lease = JSON.parse(r.world.text(`${CFG}/tally/lease.json`) ?? "{}") as { sessionId?: string };
    expect(lease.sessionId).toBe("");
  });

  test("an in-process resume keeps the scanner's lease and heartbeat like /clear", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.advance(1000);
    await r.clock.settle();
    const lease = () => JSON.parse(r.world.text(`${CFG}/tally/lease.json`) ?? "{}") as { sessionId?: string; beatMs?: number };
    const beat = lease().beatMs ?? 0;
    await $.session.end({ reason: "resume", sessionId: "s-1", resume: { id: "s-1" } } as never);
    r.sid.v = "s-2";
    await r.clock.advance(31_000);
    expect(lease().sessionId).toBe("s-1");
    expect(lease().beatMs ?? 0).toBeGreaterThan(beat);
  });

  test("leaving the prompt releases the lease", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.advance(1000);
    await r.clock.settle();
    await $.session.end({ reason: "prompt_input_exit", sessionId: "s-1", resume: { id: "s-1" } } as never);
    await r.clock.advance(31_000);
    const lease = JSON.parse(r.world.text(`${CFG}/tally/lease.json`) ?? "{}") as { sessionId?: string };
    expect(lease.sessionId).toBe("");
  });

  test("a live state that cannot be read does not fail the prompt", async () => {
    // The engine's own hooks are skipped when they throw, so the failing read is made on a stand-in `$`.
    const handlers = new Map<string, (...a: unknown[]) => Promise<unknown>>();
    const on = ((name: string, ...rest: unknown[]) => {
      handlers.set(name, rest[rest.length - 1] as never);
    }) as unknown as On;
    wireLive(on);
    const down = async () => {
      throw new Error("state unavailable");
    };
    const $ = { state: { get: down, set: down }, session: { id: async () => "s-1" }, store: { get: down, set: down }, clock: { now: async () => NOW, after: () => ({ cancel() {} }) } };
    const out = await handlers.get("prompt.submit")!($, { text: "go on", origin: { kind: "composer" } }, async (e: { text: string }) => ({ text: e.text }));
    expect(out).toEqual({ text: "go on" });
  });
});
