import type { On, RenderInput, TurnStepResult, TurnUsage } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";
import { cacheUnitPrices, costOf } from "../core/pricing.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { dayWords, historyOf, localDayName, scanOf, scanText, SCAN_STALE_MS } from "../core/history.ts";
import { headlineMoney, moneyBlock } from "../core/money.ts";
import { DEFAULT_SETTINGS } from "../core/settings.ts";
import type { BreakdownSnapshot } from "../core/breakdown.ts";
import type { Shard } from "../core/shard.ts";
import { summarize } from "../core/summary.ts";
import type { UsageRow, UserRow } from "../core/types.ts";
import { HISTORY_INTERVAL_MS, HISTORY_RETRY_MS, HISTORY_SCAN_INTERVAL_MS, needsHistory, needsRebuild, SCAN_CHECK_MS } from "../engine/history-view.ts";
import { dayIdx, saveBuckets } from "../engine/project-store.ts";
import { saveSnapshot } from "../engine/snapshot.ts";
import { keyLine } from "../view/keys.ts";
import { bash, inAgent, prompt, req, result } from "./fixtures/rows.ts";
import { worldOf } from "./world.ts";
import type { World } from "./world.ts";

const PLUGIN = "tally";
const NOW = Date.UTC(2026, 10, 27, 12);
const CWD = "/work/demo";
const CFG = "/home/u/.claude";
const OPUS = "claude-opus-5-5";
const DAY = 86_400_000;

const PANE: Omit<RenderInput<"Pane">, "surface"> = {
  component: "Pane",
  requestId: PLUGIN,
  viewport: { columns: 200, rows: 60, isFullscreen: true },
  props: { title: "tally", isFocused: true, bodyColumns: 89, placement: "dock", scroll: { offset: 0, bodyRows: 120 }, view: {} },
};
const TEXT = (re: RegExp) => ({ type: "Text" as const, text: re });
// The headline is in dollars; a row's figure is in the unit of the tab's whole money column (dollars from $1 in it, else cents).
const money = (usd: number): string => headlineMoney(usd, DEFAULT_SETTINGS.money, DEFAULT_SETTINGS.decimals);
const column = (usd: number): string => `(?:${moneyBlock([usd, 0], DEFAULT_SETTINGS.money, DEFAULT_SETTINGS.decimals)[0]!.replace(/[$.]/g, "\\$&")}|${moneyBlock([usd, 5], DEFAULT_SETTINGS.money, DEFAULT_SETTINGS.decimals)[0]!.replace(/[$.]/g, "\\$&")})`;

type Rig = { world: World; clock: ReturnType<typeof mock.clock>; stored: Map<string, unknown>; cwd: { v: unknown } };

const usageOf = (): TurnUsage => ({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000, model: OPUS, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 });

function rig(on: On): Rig {
  const world = worldOf();
  const r: Rig = { world, clock: mock.clock(on, { now: NOW }), stored: new Map(), cwd: { v: CWD } };
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
  // A cwd that is not text makes the build throw, as a broken host call would.
  on("session.cwd", () => ({ value: r.cwd.v as string }));
  on("session.model", () => ({ value: OPUS }));
  on("session.info", () => ({ value: { platform: "linux" } }));
  on("session.usage", () => ({ value: { startedAt: NOW, context: { tokens: 236_000, window: 1_000_000, percent: 24 }, rateLimits: [], cost: { usd: 0 } } as never }));
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
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: usageOf() } as TurnStepResult;
  });
  on("tool.call", () => ({ result: {}, text: "ok" }));
  return r;
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
const ago = (days: number, min = 0): number => NOW - days * DAY + min * 60_000;
const at = <T extends { ts: number }>(row: T, ts: number): T => ({ ...row, ts });
const MCP = (id: string) => ({ name: "mcp__srv__lookup", mcpServer: "srv", id, inputChars: 40 });

// The demo repo (project -work-demo): session s-1 a day ago, with two MCP calls, a Bash call and an Explore sub-agent;
// a last request reads the results back, which is what prices their re-read.
const demoRows = (): { usage: UsageRow[]; users: UserRow[] } => ({
  usage: [
    at(req({ id: "a", session: "s-1", cwd: CWD, tokens: { input: 1000, output: 500, cacheRead: 100_000, cw5m: 20_000 }, tools: [MCP("m1"), bash("tb", "ls")] }), ago(1)),
    at(req({ id: "b", session: "s-1", cwd: CWD, tokens: { cacheRead: 120_000, cw5m: 5000 }, tools: [MCP("m2")] }), ago(1, 1)),
    at(inAgent(req({ id: "x", session: "s-1", cwd: CWD, tokens: { input: 2000, output: 100 }, agentType: "Explore" }), "ag1"), ago(1, 2)),
    at(req({ id: "d", session: "s-1", cwd: CWD, tokens: { cacheRead: 130_000, cw5m: 1000 } }), ago(1, 3)),
  ],
  users: [at(prompt(0, 200, "build it", "s-1"), ago(1)), at(result(0, "m1", 8000, "s-1"), ago(1, 0.5)), at(result(0, "tb", 4000, "s-1"), ago(1, 0.6)), at(result(0, "m2", 6000, "s-1"), ago(1, 1.5))],
});
// The other repo (project -work-other): session s-2 three days ago.
const otherRows = (): { usage: UsageRow[]; users: UserRow[] } => ({
  usage: [at(req({ id: "c", session: "s-2", cwd: "/work/other", tokens: { input: 5000, output: 2000, cacheRead: 50_000 } }), ago(3))],
  users: [at(prompt(0, 100, "other", "s-2"), ago(3))],
});

const usdOf = (rows: UsageRow[]): number => rows.reduce((n, r) => n + costOf(r, BUILTIN_PRICES).usd, 0);
const r9 = (n: number): number => Number(n.toFixed(9));

async function seedProject(w: World, project: string, rows: { usage: UsageRow[]; users: UserRow[] }, metas: Shard["metas"] = []): Promise<void> {
  const byDay = new Map<number, Shard>();
  const shardOn = (ts: number): Shard => {
    const d = dayIdx(ts);
    const sh = byDay.get(d) ?? { v: 1, project, files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
    byDay.set(d, sh);
    return sh;
  };
  for (const row of rows.usage) shardOn(row.ts).usage.push(row);
  for (const u of rows.users) shardOn(u.ts).users.push(u);
  for (const m of metas) shardOn(rows.usage[0]!.ts).metas.push(m);
  await saveBuckets(w.$, CFG, project, { days: byDay }, {}, NOW);
  // The project's folder, so the 30-day listing finds it.
  w.put(`${CFG}/projects/${project}/${rows.usage[0]!.sessionId}.jsonl`, "");
}

const TITLES: Shard["metas"] = [
  { sessionId: "s-1", key: "ai-title", value: "Fix the widget" },
  { sessionId: "s-1", key: "pr-link", value: "https://example.test/pr/7" },
];

async function open($: Engine, r: Rig, o: { other?: boolean; metas?: Shard["metas"] } = {}) {
  await seedProject(r.world, "-work-demo", demoRows(), o.metas ?? TITLES);
  if (o.other !== false) await seedProject(r.world, "-work-other", otherRows());
  await start($);
  await r.clock.settle();
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
  await ui.press({ key: "tab-history" });
  await r.clock.settle();
  return ui;
}

const writeScan = (w: World, phase: string, done: number, total: number, updatedAt = NOW): void =>
  w.put(`${CFG}/tally/progress.json`, JSON.stringify({ phase, bytesDone: done, bytesTotal: total, filesDone: 1, filesTotal: 3, startedAt: NOW, owner: true, updatedAt }));

describe("history tab", () => {
  test("the body holds the headline total and every section, each figure from the index", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    const demo = demoRows().usage;
    const other = otherRows().usage;
    expect(await ui.find({ key: "body-history" })).toBeDefined();
    expect(await ui.find(TEXT(new RegExp(`^${money(usdOf(demo) + usdOf(other)).replace(/[$.]/g, "\\$&")}$`)))).toBeDefined();
    expect(await ui.find(TEXT(/ tokens in the past 30 days \u{b7} 5 requests$/u))).toBeDefined();
    for (const name of ["Billed kinds", "Spend per day", "Spend per model", "Main thread and sub-agents", "Sub-agent type and model", "Spend per repo", "Largest sessions", "Context fill by tool", "MCP servers"]) {
      expect(await ui.find(TEXT(new RegExp(`^${name}$`)))).toBeDefined();
    }
    for (const kind of [/^Input$/, /^Output$/, /^Cache read$/, /^Cache write$/]) expect(await ui.find(TEXT(kind))).toBeDefined();
    expect(await ui.find(TEXT(/^opus-5-5$/))).toBeDefined();
    expect(await ui.find(TEXT(/^Explore \u{b7} opus-5-5$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^demo$/))).toBeDefined();
    expect(await ui.find(TEXT(/^other$/))).toBeDefined();
    // The tool that filled the context: Bash's 4000 characters, estimated.
    expect(await ui.find(TEXT(/^Bash$/))).toBeDefined();
    await ui.unmount();
  });

  test("a scan in its day phase shows how far it has got above the numbers read so far", async ($, on) => {
    const r = rig(on);
    writeScan(r.world, "day", 42, 100);
    const ui = await open($, r);
    expect(await ui.find(TEXT(/^Indexing transcripts$/))).toBeDefined();
    expect(await ui.find(TEXT(/^42%$/))).toBeDefined();
    expect(await ui.find(TEXT(/^figures are still changing$/))).toBeDefined();
    expect(await ui.find(TEXT(/ tokens in the past 30 days/))).toBeDefined();
    expect(await ui.find(TEXT(/^Billed kinds$/))).toBeDefined();
    await ui.unmount();
  });

  test("the figures follow the scan: once it is done the line goes and the numbers are read again", async ($, on) => {
    const r = rig(on);
    writeScan(r.world, "day", 42, 100);
    const ui = await open($, r, { other: false });
    expect(await ui.find(TEXT(/^42%$/))).toBeDefined();
    expect(await ui.find(TEXT(/ \u{b7} 4 requests$/u))).toBeDefined();
    // The scan ends having indexed another project; the next draw after the check time sees both.
    await seedProject(r.world, "-work-other", otherRows());
    writeScan(r.world, "done", 100, 100, NOW + 10_000);
    await r.clock.advance(10_000);
    await ui.press({ key: "repo-all" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/still changing/))).toBeUndefined();
    expect(await ui.find(TEXT(/ \u{b7} 5 requests$/u))).toBeDefined();
    await ui.unmount();
  });

  test("a finished scan shows no progress line", async ($, on) => {
    const r = rig(on);
    writeScan(r.world, "done", 100, 100);
    const ui = await open($, r);
    expect(await ui.find(TEXT(/^Billed kinds$/))).toBeDefined();
    expect(await ui.find(TEXT(/still changing/))).toBeUndefined();
    await ui.unmount();
  });

  test("a progress file left stale by a scan that stopped shows no progress line", async ($, on) => {
    const r = rig(on);
    writeScan(r.world, "day", 42, 100, NOW - SCAN_STALE_MS - 1);
    const ui = await open($, r);
    expect(await ui.find(TEXT(/^Billed kinds$/))).toBeDefined();
    expect(await ui.find(TEXT(/still changing/))).toBeUndefined();
    await ui.unmount();
  });

  test("the repo switch narrows every figure to the live session's repo", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    const demo = usdOf(demoRows().usage);
    const both = demo + usdOf(otherRows().usage);
    const text = (usd: number) => new RegExp(`^${money(usd).replace(/[$.]/g, "\\$&")}$`);
    expect(await ui.find(TEXT(text(both)))).toBeDefined();
    expect(await ui.find(TEXT(/^other$/))).toBeDefined();
    expect((await ui.find({ key: "repo-only" }))?.props.hotkey).toBe("r");
    await ui.press({ key: "repo-only" });
    await r.clock.settle();
    expect(await ui.find(TEXT(text(demo)))).toBeDefined();
    expect(await ui.find(TEXT(text(both)))).toBeUndefined();
    expect(await ui.find(TEXT(/ tokens in the past 30 days \u{b7} 4 requests \u{b7} demo$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^Spend per repo$/))).toBeUndefined();
    await ui.press({ key: "repo-all" });
    await r.clock.settle();
    expect(await ui.find(TEXT(text(both)))).toBeDefined();
    await ui.unmount();
  });

  test("a project whose index is missing counts as unknown, not as empty", async ($, on) => {
    const r = rig(on);
    // The folder exists but nothing is indexed: no figures, and no claim that nothing was spent.
    r.world.put(`${CFG}/projects/-work-demo/s-1.jsonl`, "");
    await start($);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-history" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^No figures for the past 30 days yet: the transcripts are not indexed\.$/))).toBeDefined();
    expect(await ui.find(TEXT(/^No requests in/))).toBeUndefined();
    await ui.unmount();
  });

  test("a read project beside an unread one shows its figures and says the other is missing", async ($, on) => {
    const r = rig(on);
    r.world.put(`${CFG}/projects/-work-late/s-9.jsonl`, "");
    const ui = await open($, r);
    expect(await ui.find(TEXT(/^1 project is not indexed yet; their spend is not counted\.$/))).toBeDefined();
    expect(await ui.find(TEXT(/^Billed kinds$/))).toBeDefined();
    await ui.unmount();
  });

  test("with every project read and no request in 30 days it says so", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-history" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^No requests in the past 30 days\.$/))).toBeDefined();
    expect(await ui.find(TEXT(/transcripts are not indexed/))).toBeUndefined();
    await ui.unmount();
  });

  test("the day list shows a week, and m opens the rest and folds it again", async ($, on) => {
    const r = rig(on);
    const days = Array.from({ length: 9 }, (_, i) => at(req({ id: `d${i}`, session: "s-2", cwd: "/work/other", tokens: { input: 1000 } }), ago(2 + i)));
    await seedProject(r.world, "-work-other", { usage: days, users: [] });
    const ui = await open($, r, { other: false });
    const dayRows = async () => (await ui.findAll({ type: "Box" })).map((b) => b.props.key).filter((k): k is string => typeof k === "string" && k.startsWith("day-"));
    expect((await dayRows()).length).toBe(7);
    expect((await ui.find({ key: "lists-more" }))?.props.label).toBe("3 more rows");
    expect((await ui.find({ key: "lists-more" }))?.props.hotkey).toBe("m");
    await ui.press({ key: "lists-more" });
    await r.clock.settle();
    expect((await dayRows()).length).toBe(10);
    expect((await ui.find({ key: "lists-more" }))?.props.label).toBe("fold lists");
    await ui.press({ key: "lists-more" });
    await r.clock.settle();
    expect((await dayRows()).length).toBe(7);
    await ui.unmount();
  });

  test("a session row reveals its PR link and resume line when pressed, and stays open after the repo switch", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    expect(await ui.find(TEXT(/^claude --resume s-1$/))).toBeUndefined();
    const rows = (await ui.findAll({ type: "Button" })).map((b) => b.props.key).filter((k): k is string => typeof k === "string" && k.startsWith("open-session|"));
    expect(rows).toEqual(["open-session|s-1", "open-session|s-2"].filter((k) => rows.includes(k)));
    expect(rows.length).toBe(2);
    await ui.press({ key: "open-session|s-1" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^claude --resume s-1$/))).toBeDefined();
    expect(await ui.find(TEXT(/^PR https:\/\/example\.test\/pr\/7$/))).toBeDefined();
    expect(await ui.find(TEXT(/^session s-1$/))).toBeDefined();
    expect(await ui.find(TEXT(/^claude --resume s-2$/))).toBeUndefined();
    // Narrowing to one repo keeps the opened row open.
    await ui.press({ key: "repo-only" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^claude --resume s-1$/))).toBeDefined();
    await ui.press({ key: "open-session|s-1" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^claude --resume s-1$/))).toBeUndefined();
    await ui.unmount();
  });

  test("MCP servers show their calls and cost: schemas from the nearest snapshot plus the results re-read", async ($, on) => {
    const r = rig(on);
    const snap: BreakdownSnapshot = { sessionId: "s-1", ts: ago(1), skills: {}, mcp: { srv: { tokens: 4000, deferred: 1000 } }, agents: {}, memory: {}, system: 0, tools: 0 };
    await saveSnapshot(r.world.$, CFG, "-work-demo", snap);
    const ui = await open($, r, { other: false });
    // 3000 resident tokens re-read on each of the three main requests, plus the two results' re-read.
    const demo = demoRows();
    const read = demo.usage.filter((row) => !row.sidechain).reduce((n, row) => n + 3000 * cacheUnitPrices(row, BUILTIN_PRICES).read, 0);
    const s = summarize([{ v: 1, project: "-work-demo", files: {}, usage: demo.usage, users: demo.users, metas: [], compacts: [], snapshots: [] }], BUILTIN_PRICES, { span: "30d", nowMs: NOW, tzOffsetMin: 0 });
    const expected = read + (s.mcpReread.srv ?? 0);
    expect(expected).toBeGreaterThan(read);
    expect(await ui.find(TEXT(/^srv \u{b7} 2 calls$/u))).toBeDefined();
    expect(await ui.find(TEXT(new RegExp(`^${column(expected)}$`)))).toBeDefined();
    expect(await ui.find(TEXT(/no snapshot/))).toBeUndefined();
    await ui.unmount();
  });

  test("without any snapshot the server row keeps its calls and a note says its schemas are left out", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    expect(await ui.find(TEXT(/^srv \u{b7} 2 calls$/u))).toBeDefined();
    // Both sessions (one per repo) lack a snapshot.
    expect(await ui.find(TEXT(/^2 sessions have no snapshot, so their schemas are not counted$/))).toBeDefined();
    await ui.unmount();
  });

  test("a snapshot of another session marks the figure with * and says so", async ($, on) => {
    const r = rig(on);
    await saveSnapshot(r.world.$, CFG, "-work-demo", { sessionId: "s-other", ts: ago(1), skills: {}, mcp: { srv: { tokens: 4000, deferred: 0 } }, agents: {}, memory: {}, system: 0, tools: 0 });
    const ui = await open($, r, { other: false });
    expect(await ui.find(TEXT(/\*$/))).toBeDefined();
    expect(await ui.find(TEXT(/^\* some schema sizes come from a snapshot of another session$/))).toBeDefined();
    await ui.unmount();
  });

  test("a failed read shows its reason instead of waiting", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    r.cwd.v = null;
    await ui.press({ key: "repo-only" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^Could not read the index: /))).toBeDefined();
    expect(await ui.find(TEXT(/^Reading the index\.\.\.$/))).toBeUndefined();
    await ui.unmount();
  });

  test("the key line adds m and tab/enter only while the tab has lists to open and rows to walk", async () => {
    const plain = keyLine("history", {}).join(" ");
    expect(plain).toContain("r repo filter");
    expect(plain).not.toContain("m full lists");
    expect(plain).not.toContain("open rows");
    const full = keyLine("history", { more: true, rows: true }).join(" ");
    expect(full).toContain("m full lists");
    expect(full).toContain("tab/enter open rows");
  });
});

describe("history figures", () => {
  const tz = 780;
  const shard = (rows: UsageRow[], users: UserRow[] = []): Shard => ({ v: 1, project: "p", files: {}, usage: rows, users, metas: [], compacts: [], snapshots: [] });
  const meta = { key: "all", at: NOW, repo: "", tzOffsetMin: tz, mcp: [], mcpProxy: false, mcpMissing: 0, unread: 0, partial: false };

  test("days run newest first in the local zone and skip days with no request", () => {
    const rows = [at(req({ id: "a", session: "s", cwd: "/w/a", tokens: { input: 100 } }), Date.UTC(2026, 10, 25, 20)), at(req({ id: "b", session: "s", cwd: "/w/a", tokens: { input: 100 } }), Date.UTC(2026, 10, 20, 3))];
    const h = historyOf(summarize([shard(rows)], BUILTIN_PRICES, { span: "30d", nowMs: NOW, tzOffsetMin: tz, usage: true }), meta);
    // 20:00 UTC on the 25th is 09:00 on the 26th at +13:00.
    expect(h.days.map((d) => d.day)).toEqual(["2026-11-26", "2026-11-20"]);
    expect(h.days.map((d) => d.requests)).toEqual([1, 1]);
  });

  test("the four kinds add up to the total spend", () => {
    const rows = [at(req({ id: "a", session: "s", cwd: "/w/a", tokens: { input: 1000, output: 500, cacheRead: 100_000, cw5m: 20_000, cw1h: 3000 } }), ago(1))];
    const h = historyOf(summarize([shard(rows)], BUILTIN_PRICES, { span: "30d", nowMs: NOW, tzOffsetMin: tz, usage: true }), meta);
    expect(h.kinds.map((k) => k.kind)).toEqual(["input", "output", "cacheRead", "cacheWrite"]);
    expect(r9(h.kinds.reduce((n, k) => n + k.usd, 0))).toBe(r9(h.total.usd));
    expect(r9(h.total.usd)).toBe(r9(usdOf(rows)));
  });

  test("a sub-agent request lands in the sub split and in its type and model row", () => {
    const rows = [at(req({ id: "a", session: "s", cwd: "/w/a", tokens: { input: 1000 } }), ago(1)), at(inAgent(req({ id: "x", session: "s", cwd: "/w/a", tokens: { input: 2000 }, agentType: "Plan" }), "g"), ago(1, 1))];
    const h = historyOf(summarize([shard(rows)], BUILTIN_PRICES, { span: "30d", nowMs: NOW, tzOffsetMin: tz, usage: true }), meta);
    expect(r9(h.sub.usd)).toBe(r9(usdOf([rows[1]!])));
    expect(r9(h.main.usd)).toBe(r9(usdOf([rows[0]!])));
    expect(h.subTypes).toEqual([{ type: "Plan", model: OPUS, usd: h.sub.usd, requests: 1 }]);
  });

  test("localDayName and dayWords", () => {
    expect(localDayName(Date.UTC(2026, 10, 25, 20), 780)).toBe("2026-11-26");
    expect(localDayName(Date.UTC(2026, 10, 25, 20), 0)).toBe("2026-11-25");
    expect(dayWords("2026-11-26")).toBe("Nov 26");
    expect(dayWords("2026-01-05")).toBe("Jan 5");
    expect(dayWords("not a day")).toBe("not a day");
    expect(dayWords("2026-13-01")).toBe("2026-13-01");
  });

  test("scanOf: listing has no percent, work phases give one up to 99, idle, done, missing and stale give none", () => {
    const f = (phase: string, done = 0, total = 0, updatedAt = NOW) => ({ phase, bytesDone: done, bytesTotal: total, updatedAt });
    expect(scanOf(f("listing"), NOW)).toEqual({ percent: null });
    expect(scanOf(f("current", 1, 4), NOW)).toEqual({ percent: 25 });
    expect(scanOf(f("day", 42, 100), NOW)).toEqual({ percent: 42 });
    expect(scanOf(f("month", 100, 100), NOW)).toEqual({ percent: 99 });
    expect(scanOf(f("day", 0, 0), NOW)).toEqual({ percent: 0 });
    expect(scanOf(f("done", 5, 5), NOW)).toBeNull();
    expect(scanOf(f("idle"), NOW)).toBeNull();
    expect(scanOf(null, NOW)).toBeNull();
    expect(scanOf(f("day", 42, 100, NOW - SCAN_STALE_MS - 1), NOW)).toBeNull();
    expect(scanOf(f("day", 42, 100, NOW - SCAN_STALE_MS), NOW)).toEqual({ percent: 42 });
    expect(scanOf(f("day", 42, 100, Number.NaN), NOW)).toBeNull();
    expect(scanText({ percent: 7 })).toBe("7% of the transcripts indexed so far; these figures are still changing.");
    expect(scanText({ percent: null })).toMatch(/^Listing transcripts/);
  });
});

describe("history refresh rules", () => {
  const base = { key: "all", at: NOW, partial: false };
  const idle = { at: NOW, scan: null };
  const want = { repoOnly: false };

  test("figures of another key are rebuilt; fresh ones are not", () => {
    expect(needsRebuild({ ...base, key: "" }, idle, want, NOW)).toBe(true);
    expect(needsRebuild({ ...base, key: "repo" }, idle, want, NOW)).toBe(true);
    expect(needsRebuild(base, idle, want, NOW)).toBe(false);
    expect(needsRebuild(base, idle, { repoOnly: true }, NOW)).toBe(true);
  });

  test("age limits: five minutes idle, twenty seconds during a scan", () => {
    expect(needsRebuild(base, idle, want, NOW + HISTORY_INTERVAL_MS - 1)).toBe(false);
    expect(needsRebuild(base, idle, want, NOW + HISTORY_INTERVAL_MS)).toBe(true);
    const busy = { at: NOW, scan: { percent: 10 } };
    expect(needsRebuild(base, busy, want, NOW + HISTORY_SCAN_INTERVAL_MS - 1)).toBe(false);
    expect(needsRebuild(base, busy, want, NOW + HISTORY_SCAN_INTERVAL_MS)).toBe(true);
  });

  test("figures built under a scan are rebuilt once it has finished, not before", () => {
    const partial = { ...base, partial: true };
    expect(needsRebuild(partial, { at: NOW, scan: { percent: 10 } }, want, NOW + 1)).toBe(false);
    expect(needsRebuild(partial, idle, want, NOW + 1)).toBe(true);
  });

  test("a failed build is not tried again for the retry time", () => {
    const failed = { ...base, key: "", failure: { key: "all", why: "x", at: NOW } };
    expect(needsRebuild(failed, idle, want, NOW + HISTORY_RETRY_MS - 1)).toBe(false);
    expect(needsHistory(failed, { at: 0, scan: null }, want, NOW + HISTORY_RETRY_MS - 1)).toBe(false);
    expect(needsRebuild(failed, idle, want, NOW + HISTORY_RETRY_MS)).toBe(true);
    // Another key's failure does not hold this one back.
    expect(needsRebuild({ ...failed, failure: { key: "repo", why: "x", at: NOW } }, idle, want, NOW + 1)).toBe(true);
  });

  test("the scan is looked at again after its check time, even with fresh figures", () => {
    expect(needsHistory(base, idle, want, NOW + SCAN_CHECK_MS - 1)).toBe(false);
    expect(needsHistory(base, idle, want, NOW + SCAN_CHECK_MS)).toBe(true);
  });
});
