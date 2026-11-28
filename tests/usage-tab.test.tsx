import type { On, RenderInput, TurnStepInput, TurnStepResult, TurnUsage } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";
import type { Shard } from "../core/shard.ts";
import type { ToolUse } from "../core/types.ts";
import { dayIdx, saveBuckets } from "../engine/project-store.ts";
import { USAGE_INTERVAL_MS, needsUsage } from "../engine/usage-view.ts";
import { keyLine } from "../view/keys.ts";
import type { DetailRow } from "../core/usage-detail.ts";
import { redactLargest, redactRows, stepAgent } from "../view/tabs/usage.tsx";
import { bash, inAgent, prompt, req, result } from "./fixtures/rows.ts";
import { worldOf } from "./world.ts";
import type { World } from "./world.ts";

const PLUGIN = "tally";
const NOW = Date.UTC(2026, 10, 27, 12);
const CWD = "/work/demo";
const PROJECT = "-work-demo";
const CFG = "/home/u/.claude";
const OPUS = "claude-opus-5-5";

const PANE: Omit<RenderInput<"Pane">, "surface"> = {
  component: "Pane",
  requestId: PLUGIN,
  viewport: { columns: 200, rows: 60, isFullscreen: true },
  props: { title: "tally", isFocused: true, bodyColumns: 89, placement: "dock", scroll: { offset: 0, bodyRows: 80 }, view: {} },
};
const TEXT = (re: RegExp) => ({ type: "Text" as const, text: re });

type Rig = { world: World; clock: ReturnType<typeof mock.clock>; stored: Map<string, unknown>; copied: string[]; copyOk: { v: boolean }; toasts: string[]; logs: string[]; failList: { v: boolean }; forget: { v: boolean } };

const usageOf = (): TurnUsage => ({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000, model: OPUS, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 });

function rig(on: On): Rig {
  const world = worldOf();
  const r: Rig = { world, clock: mock.clock(on, { now: NOW }), stored: new Map(), copied: [], copyOk: { v: true }, toasts: [], logs: [], failList: { v: false }, forget: { v: false } };
  mock.env(on, { HOME: "/home/u" });
  on("store.get", (_, e) => ({ value: r.stored.get(e.key) }));
  on("store.set", (_, e) => {
    r.stored.set(e.key, e.value);
    return { value: undefined };
  });
  // A /clear starts the stored state over: with `forget` set, the usage cell reads as empty.
  on("state.get", async (_, e, next) => (r.forget.v && e.key === "usage" ? { value: { version: 0 } } : next(e)));
  on("state.set", async (_, e, next) => {
    if (e.key === "usage") r.forget.v = false;
    return next(e);
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("session.measure", (_, e) => ({ changed: e.changed }));
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.close", () => ({ value: undefined }));
  on("ui.toast", (_, e) => {
    r.toasts.push(String((e as { text?: string }).text ?? ""));
    return { value: undefined };
  });
  on("ui.log", (_, e) => {
    r.logs.push(String((e as { text?: string }).text ?? ""));
    return { value: undefined };
  });
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.panes", () => ({ value: [] }));
  on("ui.copy", (_, e) => {
    r.copied.push(e.text);
    return { value: r.copyOk.v ? { isCopied: true } : { isCopied: false, reason: "no clipboard" } } as never;
  });
  on("session.id", () => ({ value: "s-1" }));
    // A cwd that is not text makes the build throw, as a broken host call would.
  on("session.cwd", () => ({ value: r.failList.v ? (null as never) : CWD }));
  on("session.model", () => ({ value: OPUS }));
  on("session.info", () => ({ value: { platform: "linux" } }));
  on("session.usage", (_, e) => ({ value: { startedAt: NOW, context: { tokens: 236_000, window: 1_000_000, percent: 24 }, rateLimits: [], cost: { usd: 0 } } as never }));
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

// A step is tallied once its stream has been read to the end.
async function stepOnce($: Engine, input: Parameters<Engine["turn"]["step"]>[0]): Promise<void> {
  const stream = $.turn.step(input);
  for await (const chunk of stream) void chunk;
  await stream.result;
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
const ago = (min: number): number => NOW - min * 60_000;
const LONG = `echo ${"x".repeat(100)}`;

// One session: a first write, a tool result, a long pause, and an Explore sub-agent. Priced at opus 5.5 list.
async function seed(w: World, extra: ToolUse[] = []): Promise<void> {
  const at = <T extends { ts: number }>(row: T, min: number): T => ({ ...row, ts: ago(min) });
  const usage = [
    { ...at(req({ id: "a", session: "s-1", tokens: { input: 100, output: 500, cw5m: 20_000 }, tools: [{ ...bash("tb", LONG), inputChars: 400 }, bash("t2", "ls a"), bash("t3", "ls b"), bash("t4", "ls c"), { name: "Write", id: "tw", target: "/src/a.ts", inputChars: 800 }, ...extra] }), 50), replyChars: 400 },
    at(req({ id: "b", session: "s-1", tokens: { cacheRead: 20_000, cw5m: 5000 } }), 49),
    at(req({ id: "c", session: "s-1", tokens: { cacheRead: 25_000, cw5m: 30_000 } }), 20),
    at(inAgent(req({ id: "x", session: "s-1", tokens: { cw5m: 4000 }, agentType: "Explore" }), "ag1"), 10),
  ];
  const users = [at(prompt(0, 400, "build it", "s-1"), 50), at(result(0, "tb", 20_000, "s-1"), 49), at(prompt(0, 40, "later", "s-1"), 20)];
  const byDay = new Map<number, Shard>();
  const shardOn = (ts: number): Shard => {
    const d = dayIdx(ts);
    const sh = byDay.get(d) ?? { v: 1, project: PROJECT, files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
    byDay.set(d, sh);
    return sh;
  };
  for (const row of usage) shardOn(row.ts).usage.push(row);
  for (const u of users) shardOn(u.ts).users.push(u);
  await saveBuckets(w.$, CFG, PROJECT, { days: byDay }, {}, NOW);
  // The project's folder, so a 24-hour or 30-day span finds it.
  w.put(`${CFG}/projects/${PROJECT}/s-1.jsonl`, "");
}

async function open($: Engine, r: Rig, extra: ToolUse[] = []) {
  await seed(r.world, extra);
  await start($);
  await r.clock.settle();
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
  await ui.press({ key: "tab-usage" });
  await r.clock.settle();
  return ui;
}

describe("usage tab", () => {
  test("the body holds the four kinds, estimated rows marked ~, and the keys of the tab", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    expect(await ui.find({ key: "body-usage" })).toBeDefined();
    for (const name of ["Input", "Output", "Cache read", "Cache write"]) expect(await ui.find(TEXT(new RegExp(`^${name}$`)))).toBeDefined();
    // Output: thinking is the estimate; write groups are exact and carry no ~.
    expect(await ui.find(TEXT(/^Thinking$/))).toBeDefined();
    expect(await ui.find(TEXT(/^Main conversation \u{b7} opus-5-5 \u{b7} 3 writes$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^Explore \u{b7} opus-5-5 \u{b7} 1 write$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^~\d/))).toBeDefined();
    expect(await ui.find(TEXT(/^105k tokens in this session$/))).toBeDefined();
    expect(await ui.find(TEXT(/a agents {2}p\/n prev\/next {2}v text/u))).toBeDefined();
    await ui.unmount();
  });

  test("the biggest writes say why: a long pause, then the first request", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    expect(await ui.find(TEXT(/Largest single writes/))).toBeDefined();
    // The most-written is the 30k after a 29-minute pause.
    expect(await ui.find(TEXT(/cache lapsed after a 29m pause/))).toBeDefined();
    expect(await ui.find(TEXT(/first request of the conversation/))).toBeDefined();
    await ui.unmount();
  });

  test("the copy button hands the tab's text, with its head and column head, to $.ui.copy", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    await ui.press({ key: "usage-copy" });
    await r.clock.settle();
    expect(r.copied).toHaveLength(1);
    const lines = r.copied[0]!.split("\n");
    expect(lines[0]).toBe("Tokens \u{b7} this session \u{b7} All agents");
    expect(lines[1]).toMatch(/^what\s+tokens\s+cost$/);
    expect(r.copied[0]).toContain("Cache write");
    expect(r.copied[0]).toMatch(/Typed messages\s+~/);
    expect(r.toasts).toEqual([]);
    await ui.unmount();
  });

  test("a copy the surface refuses is said in a toast", async ($, on) => {
    const r = rig(on);
    r.copyOk.v = false;
    const ui = await open($, r);
    await ui.press({ key: "usage-copy" });
    await r.clock.settle();
    expect(r.toasts.some((t) => t.includes("could not copy"))).toBe(true);
    await ui.unmount();
  });

  test("next steps through the agents; the figures narrow to one and the copy follows", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    expect((await ui.find({ key: "agent-next" }))?.props.hotkey).toBe("n");
    expect((await ui.find({ key: "agent-prev" }))?.props.hotkey).toBe("p");
    expect((await ui.find({ key: "agent-list" }))?.props.hotkey).toBe("a");
    await ui.press({ key: "agent-next" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^Main conversation$/))).toBeDefined();
    expect(await ui.find(TEXT(/^Explore \u{b7} opus-5-5/u))).toBeUndefined();
    await ui.press({ key: "agent-list" });
    await ui.press({ key: "agent-sub:Explore" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^Explore \u{b7} opus-5-5 \u{b7} 1 write$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^Main conversation \u{b7} opus/u))).toBeUndefined();
    await ui.press({ key: "usage-copy" });
    await r.clock.settle();
    expect(r.copied[0]!.split("\n")[0]).toBe("Tokens \u{b7} this session \u{b7} Explore");
    await ui.unmount();
  });

  test("a row with text behind it opens to it, and v opens every row's", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    // A command cut in its label opens to its whole text when its row is pressed.
    const rows = (await ui.findAll({ type: "Button" })).map((b) => b.props.key).filter((k) => typeof k === "string" && k.startsWith("open-output|"));
    expect(rows.length).toBeGreaterThan(0);
    const whole = TEXT(new RegExp(`^${LONG}$`));
    expect(await ui.find(whole)).toBeUndefined();
    await ui.press({ key: "usage-full" });
    await r.clock.settle();
    expect(await ui.find(whole)).toBeDefined();
    await ui.press({ key: "usage-full" });
    await r.clock.settle();
    expect(await ui.find(whole)).toBeUndefined();
    await ui.press({ key: rows[0]! });
    await r.clock.settle();
    expect(await ui.find(whole)).toBeDefined();
    await ui.press({ key: rows[0]! });
    await r.clock.settle();
    expect(await ui.find(whole)).toBeUndefined();
    await ui.unmount();
  });

  test("redactEvidence on shows a command as its program and a path as its file name, and opens no full text", { options: { redactEvidence: true } }, async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    // The long command and the three short ones fold into their programs; the path keeps its file name.
    expect(await ui.find(TEXT(/^\s+echo$/))).toBeDefined();
    expect(await ui.find(TEXT(/^\s+ls$/))).toBeDefined();
    expect(await ui.find(TEXT(/^\s+a\.ts$/))).toBeDefined();
    expect(await ui.find(TEXT(/xxxxxxxx/))).toBeUndefined();
    expect(await ui.find(TEXT(/\/src\/a\.ts/))).toBeUndefined();
    expect((await ui.findAll({ type: "Button" })).some((b) => typeof b.props.key === "string" && b.props.key.startsWith("open-output|"))).toBe(false);
    await ui.unmount();
  });

  test("redactEvidence off keeps the command and the path as found", { options: { redactEvidence: false } }, async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    expect(await ui.find(TEXT(/^\s+echo x+$/))).toBeDefined();
    expect(await ui.find(TEXT(/^\s+\/src\/a\.ts$/))).toBeDefined();
    await ui.unmount();
  });

  test("redactLargest gives a big write's cause without the text behind it, and drops that text", () => {
    const big: DetailRow = { label: "11-28 00:11 \u{b7} tool output: Bash echo secret", bare: "11-28 00:11 \u{b7} tool output", tokens: 9, usd: 1, estimated: false, id: "main@1", full: "Bash echo secret" };
    expect(redactLargest([big], true)).toEqual([{ label: "11-28 00:11 \u{b7} tool output", tokens: 9, usd: 1, estimated: false, id: "main@1" }]);
    expect(redactLargest([big], false)).toEqual([big]);
  });

  test("redactRows adds rows that share a program, costliest first, and leaves other rows as they are", () => {
    const item = (label: string, usd: number, redact?: "command" | "path"): DetailRow => ({ label: `  ${label}`, tokens: usd * 1000, usd, estimated: true, ...(redact !== undefined && { redact }), ...(redact === "command" && { full: label }) });
    const rows: DetailRow[] = [
      { label: "Shell commands", tokens: 10, usd: 10, estimated: true },
      item("git -C /x status", 3, "command"),
      item("ls a", 5, "command"),
      item("git log", 4, "command"),
      { label: "Replies", tokens: 1, usd: 1, estimated: true },
      item("a plain item", 2),
    ];
    expect(redactRows(rows, true).map((r) => [r.label, r.usd, r.full])).toEqual([
      ["Shell commands", 10, undefined],
      ["  git", 7, undefined],
      ["  ls", 5, undefined],
      ["Replies", 1, undefined],
      ["  a plain item", 2, undefined],
    ]);
    expect(redactRows(rows, false)).toBe(rows);
    expect(redactRows([item("C:\\work\\deep\\file.ts", 1, "path")], true)[0]!.label).toBe("  file.ts");
  });

  test("an opened row stays the same row when m unfolds the lists above it", async ($, on) => {
    const r = rig(on);
    // Four writes put a hidden item in the Write group, which sits above Shell commands: m shifts every later row.
    const more = ["b", "c", "d"].map((n): ToolUse => ({ name: "Write", id: `w-${n}`, target: `/src/${n}.ts`, inputChars: 40 }));
    const ui = await open($, r, more);
    const dRow = TEXT(/^\s+\/src\/d\.ts$/);
    expect(await ui.find(dRow)).toBeUndefined();
    const opens = async () => (await ui.findAll({ type: "Button" })).map((b) => b.props.key).filter((k): k is string => typeof k === "string" && k.startsWith("open-output|"));
    const before = await opens();
    expect(before).toHaveLength(1);
    const whole = TEXT(new RegExp(`^${LONG}$`));
    await ui.press({ key: before[0]! });
    await r.clock.settle();
    expect(await ui.find(whole)).toBeDefined();
    await ui.press({ key: "lists-more" });
    await r.clock.settle();
    expect(await ui.find(dRow)).toBeDefined();
    expect(await opens()).toEqual(before);
    expect(await ui.find(whole)).toBeDefined();
    await ui.press({ key: "lists-more" });
    await r.clock.settle();
    expect(await ui.find(whole)).toBeDefined();
    await ui.unmount();
  });

  test("a failed build is logged and the tab says so instead of waiting", async ($, on) => {
    const r = rig(on);
    await seed(r.world);
    await start($);
    await r.clock.settle();
    r.failList.v = true;
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-usage" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^Could not read the index: .*cwd\.replace/))).toBeDefined();
    expect(await ui.find(TEXT(/Reading the index/))).toBeUndefined();
    expect(r.logs.some((l) => l.includes("usage build failed") && l.includes("cwd.replace"))).toBe(true);
    await ui.unmount();
  });

  test("a group's items cut to three; m opens the rest and folds them again", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    expect(await ui.find(TEXT(/^\s+ls a$/))).toBeDefined();
    expect(await ui.find(TEXT(/^\s+ls c$/))).toBeUndefined();
    expect((await ui.find({ key: "lists-more" }))?.props.hotkey).toBe("m");
    await ui.press({ key: "lists-more" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^\s+ls c$/))).toBeDefined();
    await ui.press({ key: "lists-more" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^\s+ls c$/))).toBeUndefined();
    await ui.unmount();
  });

  test("the span switch rebuilds for 30 days over every project", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    await ui.press({ key: "span-30d" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/in the past 30 days/))).toBeDefined();
    expect(await ui.find(TEXT(/^Main conversation \u{b7} opus-5-5 \u{b7} 3 writes$/u))).toBeDefined();
    await ui.press({ key: "span-session" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/in this session/))).toBeDefined();
    await ui.unmount();
  });

  test("figures the store lost (a /clear starts the stored state over) are rebuilt, not waited for until the interval ends", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    await ui.press({ key: "span-30d" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/in the past 30 days/))).toBeDefined();
    r.forget.v = true;
    await ui.press({ key: "tab-history" });
    await r.clock.settle();
    await ui.press({ key: "tab-usage" });
    await r.clock.settle();
    // The build runs off the draw; the next draw shows it.
    await ui.press({ key: "tab-usage" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/Reading the index/))).toBeUndefined();
    expect(await ui.find(TEXT(/in the past 30 days/))).toBeDefined();
    await ui.unmount();
  });

  test("the Session tab's token rows still drill here", async ($, on) => {
    const r = rig(on);
    await seed(r.world);
    await start($);
    await r.clock.settle();
    await $.prompt.submit({ text: "go", wait: false, origin: { kind: "composer" } } as never);
    await stepOnce($, { turnId: "t1", index: 0, model: OPUS, messageCount: 2 } as never);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "open-kind-cacheRead" });
    await r.clock.settle();
    expect(await ui.find({ key: "body-usage" })).toBeDefined();
    expect(r.stored.get("span")).toBe("session");
    expect(await ui.find(TEXT(/^Cache read$/))).toBeDefined();
    await ui.unmount();
  });

  test("a new session shows its live requests before the index has read any", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    await $.prompt.submit({ text: "go", wait: false, origin: { kind: "composer" } } as never);
    await stepOnce($, { turnId: "t1", index: 0, model: OPUS, messageCount: 2 } as never);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-usage" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^No requests in this session\.$/))).toBeUndefined();
    expect(await ui.find(TEXT(/^112k tokens in this session$/))).toBeDefined();
    expect(await ui.find(TEXT(/^Main conversation \u{b7} opus-5-5 \u{b7} 1 write$/u))).toBeDefined();
    await ui.unmount();
  });

  test("live requests add to the index's earlier ones, and a later step shows within the interval", async ($, on) => {
    const r = rig(on);
    await seed(r.world);
    await start($);
    await r.clock.settle();
    await $.prompt.submit({ text: "go", wait: false, origin: { kind: "composer" } } as never);
    await stepOnce($, { turnId: "t1", index: 0, model: OPUS, messageCount: 2 } as never);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-usage" });
    await r.clock.settle();
    // 104,600 in the index before this launch plus 111,500 live.
    expect(await ui.find(TEXT(/^216k tokens in this session$/))).toBeDefined();
    await stepOnce($, { turnId: "t1", index: 1, model: OPUS, messageCount: 4 } as never);
    await r.clock.advance(USAGE_INTERVAL_MS.session + 1000);
    await r.clock.settle();
    await ui.press({ key: "tab-usage" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^328k tokens in this session$/))).toBeDefined();
    await ui.unmount();
  });

  test("an empty session says so, and the figures wait for the first build", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-usage" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^No requests in this session\.$/))).toBeDefined();
    await ui.unmount();
  });
});

describe("usage tab helpers", () => {
  test("figures are due when they are of another span or older than their interval", () => {
    const data = { key: "session:s-1", at: 1000 };
    expect(needsUsage(data, { span: "session", sessionId: "s-1" }, 1000 + 9_000)).toBe(false);
    expect(needsUsage(data, { span: "session", sessionId: "s-1" }, 1000 + 10_000)).toBe(true);
    expect(needsUsage(data, { span: "session", sessionId: "s-2" }, 2000)).toBe(true);
    expect(needsUsage(data, { span: "24h", sessionId: "s-1" }, 2000)).toBe(true);
    expect(needsUsage({ key: "30d:", at: 1000 }, { span: "30d", sessionId: "s-9" }, 2000)).toBe(false);
    // No live session: nothing to build for the session span.
    expect(needsUsage({ key: "", at: 0 }, { span: "session", sessionId: "" }, 2000)).toBe(false);
  });

  test("stepping wraps both ways and an unknown agent counts as all", () => {
    const order = ["", "main", "sub:Explore"];
    expect(stepAgent(order, "", 1)).toBe("main");
    expect(stepAgent(order, "sub:Explore", 1)).toBe("");
    expect(stepAgent(order, "", -1)).toBe("sub:Explore");
    expect(stepAgent(order, "sub:Gone", 1)).toBe("main");
  });
});


describe("usage tab keys", () => {
  test("the key line lists the full-text key only while rows hold full text", () => {
    expect(keyLine("usage", { canFull: true, agents: true })).toEqual(["0-5 switch tab", "s time span", "a agent list", "p/n prev/next", "v full text", "esc fold"]);
    expect(keyLine("usage")).toEqual(["0-5 switch tab", "s time span", "esc fold"]);
  });
});
