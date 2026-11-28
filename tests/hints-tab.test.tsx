import type { On, RenderInput, TurnStepResult, TurnUsage } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";
import { redact, runRules, sortHints } from "../core/hint.ts";
import type { Evidence, Hint, HintRule } from "../core/hint.ts";
import { costOf } from "../core/pricing.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { formatMoney } from "../core/money.ts";
import { DEFAULT_SETTINGS } from "../core/settings.ts";
import type { Shard } from "../core/shard.ts";
import type { UsageRow, UserRow } from "../core/types.ts";
import { EMPTY_HINTS, HINTS_INTERVAL_MS, HINTS_MIN_MS, HINTS_RETRY_MS, hintsKeyOf, needsHints } from "../engine/hints-view.ts";
import type { HintsData, HintsWant } from "../engine/hints-view.ts";
import { LAST_LIMITS_KEY } from "../engine/live.ts";
import { registryPath } from "../engine/plugins.ts";
import { dayIdx, saveBuckets } from "../engine/project-store.ts";
import { saveSnapshot } from "../engine/snapshot.ts";
import { keyLine } from "../view/keys.ts";
import { tableOf } from "../view/table.ts";
import { NO_ADOPT, NO_EVIDENCE, drawHints, hintRowKey } from "../view/tabs/hints.tsx";
import { prompt, req } from "./fixtures/rows.ts";
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
  viewport: { columns: 200, rows: 80, isFullscreen: true },
  props: { title: "tally", isFocused: true, bodyColumns: 120, placement: "dock", scroll: { offset: 0, bodyRows: 160 }, view: {} },
};
const TEXT = (re: RegExp) => ({ type: "Text" as const, text: re });
const money = (usd: number): string => formatMoney(usd, DEFAULT_SETTINGS.money, DEFAULT_SETTINGS.decimals);
const exact = (s: string): RegExp => new RegExp(`^${s.replace(/[$.*+?^${}()|[\]\\]/g, "\\$&")}$`);

type Rig = { world: World; clock: ReturnType<typeof mock.clock>; cwd: { v: unknown }; stored: Map<string, unknown> };

const usageOf = (): TurnUsage => ({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000, model: OPUS, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 });

function rig(on: On): Rig {
  const world = worldOf();
  const stored = new Map<string, unknown>();
  const r: Rig = { world, clock: mock.clock(on, { now: NOW }), cwd: { v: CWD }, stored };
  mock.env(on, { HOME: "/home/u" });
  on("store.get", (_, e) => ({ value: stored.get(e.key) }));
  on("store.set", (_, e) => {
    stored.set(e.key, e.value);
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
  // A cwd that is not text makes the repo filter's build throw, as a broken host call would.
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

// Demo repo: s-1 half a day ago (titled), one fast request worth 4.048 dollars, and the small s-3 just after it.
// Other repo: s-2 three days ago, a small request and then a 150k-token cache write two hours later (a 1.20 dollar rebuild).
const demoRows = (): { usage: UsageRow[]; users: UserRow[] } => ({
  usage: [
    { ...at(req({ id: "a", at: 0, session: "s-1", cwd: CWD, tokens: { input: 1000, output: 100_000, cacheRead: 100_000 } }), ago(0.5)), fast: true, replyChars: 400_000 },
    at(req({ id: "b", at: 0, session: "s-3", cwd: CWD, tokens: { input: 100 } }), ago(0.5, 30)),
  ],
  users: [at(prompt(0, 200, "build it", "s-1"), ago(0.5)), at(prompt(0, 50, "tiny", "s-3"), ago(0.5, 30))],
});
// s-1 also grows to a 750k-token prompt, so long-session names it.
const longDemoRows = (): { usage: UsageRow[]; users: UserRow[] } => {
  const base = demoRows();
  return { usage: [...base.usage, at(req({ id: "d", at: 0, session: "s-1", cwd: CWD, tokens: { input: 750_000 } }), ago(0.5, 5))], users: base.users };
};
const otherRows = (): { usage: UsageRow[]; users: UserRow[] } => ({
  usage: [
    at(req({ id: "c1", at: 0, session: "s-2", cwd: "/work/other", tokens: { input: 5000, output: 2000 } }), ago(3)),
    at(req({ id: "c2", at: 0, session: "s-2", cwd: "/work/other", tokens: { input: 100, cw1h: 150_000 } }), ago(3, 120)),
  ],
  users: [at(prompt(0, 100, "other", "s-2"), ago(3))],
});
const usdOf = (rows: UsageRow[]): number => rows.reduce((n, row) => n + costOf(row, BUILTIN_PRICES).usd, 0);
// Hand-computed: a = (1000*4 + 100000*20 + 100000*0.2) / 1e6 * 2 = 4.048; fast mode saves half. c2 = 150000 * 8 / 1e6 = 1.2.
const FAST_USD = 4.048;
const FAST_SAVING = 2.024;
const REBUILD_USD = 1.2;

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
  w.put(`${CFG}/projects/${project}/${rows.usage[0]!.sessionId}.jsonl`, "");
}

async function open($: Engine, r: Rig, o: { other?: boolean; long?: boolean } = {}) {
  await seedProject(r.world, "-work-demo", o.long === true ? longDemoRows() : demoRows(), [{ sessionId: "s-1", key: "ai-title", value: "Fix the widget" }]);
  if (o.other !== false) await seedProject(r.world, "-work-other", otherRows());
  await start($);
  await r.clock.settle();
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
  await ui.press({ key: "tab-hints" });
  await r.clock.settle();
  return ui;
}

type Ui = Awaited<ReturnType<typeof open>>;
const boxKeys = async (ui: Ui, prefix: string): Promise<string[]> => (await ui.findAll({ type: "Box" })).map((b) => b.props.key).filter((k): k is string => typeof k === "string" && k.startsWith(prefix));

const EVIDENCE: Evidence[] = [
  { label: "Command", detail: "git push origin secret-branch", kind: "command" },
  { label: "File", detail: "C:\\a\\b\\secret.txt", kind: "path" },
  { label: "Session", detail: "Fix the widget", kind: "title" },
  { label: "Requests", detail: "3 rebuilds", kind: "text" },
];
const hintOf = (rule: string, usd: number, extra: Partial<Hint> = {}): Hint => ({ rule, title: `Title of ${rule}`, usd, summary: `Summary of ${rule}.`, action: `Action for ${rule}.`, evidence: [], short: rule, ...extra });
const ruleOf = (hints: Hint[]): HintRule => ({ id: "test", run: () => hints });

// The tab's drawing on its own, over findings the test hands it and rows it holds open: the plugin under test builds
// its findings from the index, which a test cannot put rules into.
const HOST_WANT: HintsWant = { span: "30d", repoOnly: false, sessionId: "s-1" };
function hintsHost(on: On, o: { span?: Hint[]; shown?: string[]; redact?: boolean }): void {
  const data: HintsData = { ...EMPTY_HINTS, key: hintsKeyOf(HOST_WANT), at: NOW, requests: 5, span: o.span ?? [] };
  on("ui.render", { component: "Pane", requestId: "hints-host" }, ($, e) => {
    const t = tableOf($, e as RenderInput<"Pane">);
    const { Box } = t;
    const drawn = drawHints(t, { d: { money: DEFAULT_SETTINGS.money, decimals: DEFAULT_SETTINGS.decimals }, data, want: HOST_WANT, view: { shown: o.shown ?? [] }, redact: o.redact === true, onShown: () => {} });
    return (<Box key="host" flexDirection="column">{drawn.rows}{drawn.pinned?.(drawn.rows)}</Box>) as never;
  });
}
const mountHost = ($: Engine) => $.ui.mount({ plugin: "hints-host", surface: "terminal", ...PANE, requestId: "hints-host" });

describe("redact", () => {
  test("a command keeps only its program name", () => {
    expect(redact({ kind: "command", label: "Command", detail: "git push origin secret-branch" }, true).detail).toBe("git");
    expect(redact({ kind: "command", label: "Command", detail: "  FOO=1 BAR='a b' /usr/local/bin/node server.js --token x" }, true).detail).toBe("node");
    expect(redact({ kind: "command", label: "Command", detail: '"C:\\Program Files\\Git\\bin\\git.exe" push origin main' }, true).detail).toBe("git.exe");
    expect(redact({ kind: "command", label: "Command", detail: "" }, true).detail).toBe("");
  });

  test("a command line fails closed: an assignment alone, or a word that is not a program, shows nothing", () => {
    const cmd = (detail: string) => redact({ kind: "command", label: "Command", detail }, true).detail;
    expect(cmd("FOO=secret")).toBe("");
    expect(cmd("TOKEN=abc")).toBe("");
    expect(cmd("  A=1 B=2  ")).toBe("");
    expect(cmd('FOO="a b')).toBe("");
    expect(cmd('"unclosed program')).toBe("");
    expect(cmd('FOO=a"b c" git')).toBe("git");
    expect(cmd("A=1 B=2 git push")).toBe("git");
    expect(cmd("cat x | grep y")).toBe("cat");
    expect(cmd("ls|grep y")).toBe("ls");
    expect(cmd("make; rm -rf x")).toBe("make");
  });

  test("shell syntax never leaks: the output is empty or the bare program, nothing else", () => {
    const cmd = (detail: string) => redact({ kind: "command", label: "Command", detail }, true).detail;
    const cases: [string, string[]][] = [
      ["FOO=$(cat k) git", ["", "git"]],
      ["FOO=a\\ b git", ["", "git"]],
      ['FOO="$(cat k z)" git', ["", "git"]],
      ["FOO=`cat k` git", ["", "git"]],
      ["git$(cat k)", [""]],
      ["git`cat k`", [""]],
      ['"git"$(cat k)', [""]],
      ["$(secret) x", [""]],
      ["cat<secret.txt", ["", "cat"]],
      ["echo>out", ["", "echo"]],
      ["(cd /x && git)", [""]],
      ["-secret", [""]],
      ["!secret", [""]],
      ["<secret", [""]],
      ["secret\\ name x", [""]],
    ];
    for (const [input, allowed] of cases) {
      const out = cmd(input);
      expect(allowed).toContain(out);
      expect(out).toMatch(/^[\w.]*$/);
    }
  });

  test("sudo and env are skipped to show the real program; anything unsure shows nothing", () => {
    const cmd = (detail: string) => redact({ kind: "command", label: "Command", detail }, true).detail;
    expect(cmd("sudo git push")).toBe("git");
    expect(cmd("sudo -E -n git push")).toBe("git");
    expect(cmd("/usr/bin/sudo FOO=1 /usr/bin/git x")).toBe("git");
    expect(cmd("env FOO=1 git x")).toBe("git");
    expect(cmd("env -i FOO=1 BAR='a b' git x")).toBe("git");
    expect(cmd("sudo env A=1 git")).toBe("git");
    expect(cmd("sudo -u root git")).toBe("");
    expect(cmd("env -S 'git x'")).toBe("");
    expect(cmd("sudo")).toBe("");
    expect(cmd("env FOO=secret")).toBe("");
  });

  test("a command path with a trailing separator keeps its last folder name", () => {
    const cmd = (detail: string) => redact({ kind: "command", label: "Command", detail }, true).detail;
    expect(cmd("/a/b/")).toBe("b");
    expect(cmd("C:\\a\\b\\")).toBe("b");
  });

  test("a path keeps only its file name, whichever separator it uses", () => {
    expect(redact({ kind: "path", label: "File", detail: "C:\\a\\b\\secret.txt" }, true).detail).toBe("secret.txt");
    expect(redact({ kind: "path", label: "File", detail: "/home/u/work/secret.txt" }, true).detail).toBe("secret.txt");
    expect(redact({ kind: "path", label: "File", detail: "a\\b/c\\d.md" }, true).detail).toBe("d.md");
    expect(redact({ kind: "path", label: "File", detail: "name-only.txt" }, true).detail).toBe("name-only.txt");
  });

  test("a title is emptied and a text row is left as it is", () => {
    expect(redact({ kind: "title", label: "Session", detail: "Fix the widget" }, true).detail).toBe("");
    expect(redact({ kind: "text", label: "Requests", detail: "3 rebuilds" }, true).detail).toBe("3 rebuilds");
  });

  test("the label and kind survive, the input is not changed, and off returns the row as it was", () => {
    const row: Evidence = { kind: "command", label: "Command", detail: "git push origin secret-branch" };
    expect(redact(row, true)).toEqual({ kind: "command", label: "Command", detail: "git" });
    expect(row.detail).toBe("git push origin secret-branch");
    expect(redact(row, false)).toEqual(row);
    for (const e of EVIDENCE) expect(redact(e, false)).toEqual(e);
  });
});

describe("hint ranking", () => {
  test("sortHints puts the largest amount first and breaks ties by rule id", () => {
    expect(sortHints([hintOf("b", 1), hintOf("c", 5), hintOf("a", 1), hintOf("d", 0)]).map((h) => h.rule)).toEqual(["c", "a", "b", "d"]);
  });

  test("an urgent hint leads whatever the amounts", () => {
    expect(sortHints([hintOf("b", 9), hintOf("z", 0, { urgent: true }), hintOf("a", 1, { urgent: true })]).map((h) => h.rule)).toEqual(["a", "z", "b"]);
  });

  test("runRules joins every rule's hints ranked, and skips a rule that throws", async () => {
    const boom: HintRule = {
      id: "boom",
      run: () => {
        throw new Error("rule bug");
      },
    };
    const input = { scope: "span" as const, nowMs: NOW, summary: {} as never, snaps: [], plugins: [], prices: BUILTIN_PRICES };
    expect((await runRules([ruleOf([hintOf("low", 1)]), boom, ruleOf([hintOf("high", 9)])], input)).map((h) => h.rule)).toEqual(["high", "low"]);
    expect(await runRules([], input)).toEqual([]);
  });

  test("runRules yields to the caller between rules", async () => {
    const input = { scope: "span" as const, nowMs: NOW, summary: {} as never, snaps: [], plugins: [], prices: BUILTIN_PRICES };
    const log: string[] = [];
    const rule = (id: string): HintRule => ({ id, run: () => (log.push(`run ${id}`), []) });
    await runRules([rule("a"), rule("b"), rule("c")], input, async () => void log.push("tick"));
    expect(log).toEqual(["run a", "tick", "run b", "tick", "run c", "tick"]);
  });

  test("runRules keeps the costlier hint when two share a rule id", async () => {
    const input = { scope: "span" as const, nowMs: NOW, summary: {} as never, snaps: [], plugins: [], prices: BUILTIN_PRICES };
    const found = await runRules([ruleOf([hintOf("x", 2, { title: "small" }), hintOf("y", 1), hintOf("x", 7, { title: "big" })]), ruleOf([hintOf("x", 7, { title: "later tie" })])], input);
    expect(found.map((h) => [h.rule, h.usd, h.title])).toEqual([["x", 7, "big"], ["y", 1, "Title of y"]]);
  });
});

describe("hints refresh rules", () => {
  const want = { span: "30d" as const, repoOnly: false, sessionId: "s-1" };
  const base = { key: "30d|all|s-1", at: NOW };

  test("rebuild when the key differs or the findings are old, not before", () => {
    expect(needsHints(base, want, NOW + HINTS_INTERVAL_MS - 1)).toBe(false);
    expect(needsHints(base, want, NOW + HINTS_INTERVAL_MS)).toBe(true);
    expect(needsHints(base, { ...want, span: "24h" }, NOW)).toBe(true);
    expect(needsHints(base, { ...want, repoOnly: true }, NOW)).toBe(true);
    expect(needsHints(base, { ...want, sessionId: "s-2" }, NOW)).toBe(true);
    expect(needsHints({ key: "", at: 0 }, want, NOW)).toBe(true);
  });

  test("findings built before new requests arrived are rebuilt once HINTS_MIN_MS old, not on every draw", () => {
    const built = { ...base, stamp: 4 };
    expect(needsHints(built, { ...want, stamp: 4 }, NOW + HINTS_MIN_MS)).toBe(false);
    expect(needsHints(built, { ...want, stamp: 5 }, NOW + HINTS_MIN_MS - 1)).toBe(false);
    expect(needsHints(built, { ...want, stamp: 5 }, NOW + HINTS_MIN_MS)).toBe(true);
    // Findings from before stamps existed count as moved; a want with no stamp never asks.
    expect(needsHints(base, { ...want, stamp: 5 }, NOW + HINTS_MIN_MS)).toBe(true);
    expect(needsHints(built, want, NOW + HINTS_MIN_MS)).toBe(false);
  });

  test("a failed key waits out the retry gap, while another key does not", () => {
    const failed = { ...base, key: "", failure: { key: "30d|all|s-1", why: "x", at: NOW } };
    expect(needsHints(failed, want, NOW + HINTS_RETRY_MS - 1)).toBe(false);
    expect(needsHints(failed, want, NOW + HINTS_RETRY_MS)).toBe(true);
    expect(needsHints(failed, { ...want, span: "24h" }, NOW)).toBe(true);
  });
});

describe("hints tab", () => {
  test("each scope lists its hints largest amount first, each with its title, amount, summary and action", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    expect(await ui.find({ key: "body-hints" })).toBeDefined();
    expect(await ui.find(TEXT(exact("This session")))).toBeDefined();
    expect(await ui.find({ key: "title-span" })).toBeDefined();
    expect(await boxKeys(ui, "title-hint|session|")).toEqual(["title-hint|session|fast-mode"]);
    expect(await boxKeys(ui, "title-hint|span|")).toEqual(["title-hint|span|fast-mode", "title-hint|span|cache-rebuilt"]);
    // Fast mode's amount is a projected saving (half the fast cost, marked "~"); the rebuild's is the measured cost.
    expect(Math.round(usdOf(demoRows().usage.slice(0, 1)) * 1e6) / 1e6).toBe(FAST_USD);
    expect((await ui.findAll(TEXT(exact(`save ~${money(FAST_SAVING)}`)))).length).toBe(2);
    expect(await ui.find(TEXT(exact(`save ${money(REBUILD_USD)}`)))).toBeDefined();
    expect((await ui.findAll(TEXT(exact("Fast-mode surcharge")))).length).toBe(2);
    expect(await ui.find(TEXT(exact("Cache expired while idle")))).toBeDefined();
    expect((await ui.findAll(TEXT(/ pricing; the same requests at standard speed would have cost /))).length).toBe(2);
    expect((await ui.findAll(TEXT(/^Toggle it with \/fast/))).length).toBe(2);
    await ui.unmount();
  });

  test("a hint with no dollar figure shows no amount, and a projected one is marked", async ($, on) => {
    hintsHost(on, { span: [hintOf("none", 0), hintOf("exact", 3), hintOf("projected", 2, { projected: true })] });
    const ui = await mountHost($);
    expect(await ui.find(TEXT(exact(`save ${money(3)}`)))).toBeDefined();
    expect(await ui.find(TEXT(exact(`save ~${money(2)}`)))).toBeDefined();
    expect((await ui.findAll(TEXT(/^save /))).length).toBe(2);
    await ui.unmount();
  });

  test("the repo switch narrows the span to the session's repo and names it; the session block is unchanged", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    expect((await ui.find({ key: "repo-only" }))?.props.hotkey).toBe("r");
    expect(await ui.find(TEXT(exact("all repos")))).toBeDefined();
    await ui.press({ key: "repo-only" });
    await r.clock.settle();
    expect(await boxKeys(ui, "title-hint|span|")).toEqual(["title-hint|span|fast-mode"]);
    expect(await boxKeys(ui, "title-hint|session|")).toEqual(["title-hint|session|fast-mode"]);
    expect(await ui.find(TEXT(exact("demo")))).toBeDefined();
    expect(await ui.find(TEXT(exact("all repos")))).toBeUndefined();
    await ui.press({ key: "repo-all" });
    await r.clock.settle();
    expect((await boxKeys(ui, "title-hint|span|")).length).toBe(2);
    await ui.unmount();
  });

  test("the span switch has 24h and 30d; 24h drops the rebuild made three days back", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    expect(await ui.find({ key: "span-session" })).toBeUndefined();
    expect((await ui.find({ key: "span-30d" }))?.props.variant).toBe("primary");
    expect((await boxKeys(ui, "title-hint|span|")).length).toBe(2);
    await ui.press({ key: "span-24h" });
    await r.clock.settle();
    expect(await ui.find({ key: "title-span" })).toBeDefined();
    expect(await boxKeys(ui, "title-hint|span|")).toEqual(["title-hint|span|fast-mode"]);
    await ui.unmount();
  });

  test("evidence is folded until its row is pressed; an open row is keyed by scope and rule and survives span and repo switches", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    expect(await ui.find(TEXT(/^Fast requests \u{b7} /u))).toBeUndefined();
    expect((await ui.findAll({ type: "Button" })).filter((b) => String(b.props.key).startsWith("open-hint|")).map((b) => b.props.label)).toEqual(["show evidence (1)", "show evidence (1)", "show evidence (1)"]);
    await ui.press({ key: "open-hint|span|fast-mode" });
    await r.clock.settle();
    expect(await ui.find(TEXT(exact("Fast requests \u{b7} $4.05 across 1 request")))).toBeDefined();
    expect((await ui.find({ key: "open-hint|span|fast-mode" }))?.props.label).toBe("hide evidence (1)");
    // The session block's row of the same rule is its own row and stays folded.
    expect((await ui.findAll(TEXT(/^Fast requests \u{b7} /u))).length).toBe(1);
    await ui.press({ key: "span-24h" });
    await r.clock.settle();
    expect(await ui.find(TEXT(exact("Fast requests \u{b7} $4.05 across 1 request")))).toBeDefined();
    await ui.press({ key: "repo-only" });
    await r.clock.settle();
    expect(await ui.find(TEXT(exact("Fast requests \u{b7} $4.05 across 1 request")))).toBeDefined();
    await ui.press({ key: "open-hint|span|fast-mode" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^Fast requests \u{b7} /u))).toBeUndefined();
    await ui.unmount();
  });

  test("a rebuild's evidence names its day, size, pause and cost", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    await ui.press({ key: "open-hint|span|cache-rebuilt" });
    await r.clock.settle();
    expect(await ui.find(TEXT(exact("Rebuild \u{b7} 2026-11-24: 150k tokens written after 2h 00m idle ($1.20)")))).toBeDefined();
    await ui.unmount();
  });

  test("redactEvidence off shows the evidence as found", { options: { redactEvidence: false } }, async ($, on) => {
    const r = rig(on);
    const ui = await open($, r, { long: true });
    await ui.press({ key: "open-hint|span|long-session" });
    await r.clock.settle();
    expect(await ui.find(TEXT(exact("Session \u{b7} Fix the widget")))).toBeDefined();
    expect(await ui.find(TEXT(exact("Peak context \u{b7} 75% full: 750k tokens in a 1M window")))).toBeDefined();
    await ui.unmount();
  });

  test("redactEvidence on empties a title to its label and leaves a text row whole", { options: { redactEvidence: true } }, async ($, on) => {
    const r = rig(on);
    const ui = await open($, r, { long: true });
    await ui.press({ key: "open-hint|span|long-session" });
    await r.clock.settle();
    expect(await ui.find(TEXT(exact("Session")))).toBeDefined();
    expect(await ui.find(TEXT(exact("Peak context \u{b7} 75% full: 750k tokens in a 1M window")))).toBeDefined();
    expect(await ui.find(TEXT(/Fix the widget/))).toBeUndefined();
    await ui.unmount();
  });

  test("installed plugins, breakdown snapshots and the last limits reach the rules", async ($, on) => {
    const r = rig(on);
    r.world.put(registryPath(CFG), JSON.stringify({ version: 2, plugins: { "idle@m": [{ scope: "user", installPath: "/p/idle" }] } }));
    await saveSnapshot(r.world.$, CFG, "-work-demo", { sessionId: "s-1", ts: ago(0.5), skills: { "idle:thing": 200_000 }, mcp: {}, agents: {}, memory: {}, system: 0, tools: 0 });
    r.stored.set(LAST_LIMITS_KEY, { at: NOW, limits: [{ kind: "five_hour", percentUsed: 91, resetsAt: new Date(NOW + 3_600_000).toISOString() }] });
    const ui = await open($, r);
    // Session: the limit alerts lead (about now, no amount; 4h into the 5h window at 91% also runs out early), then fast mode 2.02, then the plugin's 200k tokens on one request.
    expect(await boxKeys(ui, "title-hint|session|")).toEqual(["title-hint|session|limit-pace", "title-hint|session|near-limit", "title-hint|session|fast-mode", "title-hint|session|unused-plugin"]);
    // The span block carries no limit hint: the limits belong to the live session.
    expect(await boxKeys(ui, "title-hint|span|")).toEqual(["title-hint|span|fast-mode", "title-hint|span|cache-rebuilt", "title-hint|span|unused-plugin"]);
    expect(await ui.find(TEXT(exact("Rate-limit window almost spent")))).toBeDefined();
    await ui.press({ key: "open-hint|session|near-limit" });
    await r.clock.settle();
    expect(await ui.find(TEXT(exact("5-hour window \u{b7} 91% consumed; 1h 00m until reset")))).toBeDefined();
    await ui.unmount();
  });

  test("a project whose index is missing counts as unknown, not as empty", async ($, on) => {
    const r = rig(on);
    r.world.put(`${CFG}/projects/-work-demo/s-1.jsonl`, "");
    await start($);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-hints" });
    await r.clock.settle();
    expect(await ui.find(TEXT(exact("No hints for the past 30 days yet: the transcripts are not indexed.")))).toBeDefined();
    expect(await ui.find(TEXT(/^No hints for the past 30 days\.$/))).toBeUndefined();
    await ui.unmount();
  });

  test("a read project beside an unread one shows its hints and says the other is missing", async ($, on) => {
    const r = rig(on);
    r.world.put(`${CFG}/projects/-work-late/s-9.jsonl`, "");
    const ui = await open($, r);
    expect(await ui.find(TEXT(exact("1 project is not indexed yet; hints may be missing.")))).toBeDefined();
    expect((await boxKeys(ui, "title-hint|span|")).length).toBe(2);
    await ui.unmount();
  });

  test("with every project read and no request in the span both blocks say so", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-hints" });
    await r.clock.settle();
    expect(await ui.find(TEXT(exact("No hints for this session.")))).toBeDefined();
    expect(await ui.find(TEXT(exact("No hints for the past 30 days.")))).toBeDefined();
    expect(await ui.find(TEXT(/not indexed/))).toBeUndefined();
    await ui.press({ key: "repo-only" });
    await r.clock.settle();
    expect(await ui.find(TEXT(exact("No hints for the past 30 days in demo.")))).toBeDefined();
    await ui.unmount();
  });

  test("a failed build shows its reason instead of waiting", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    r.cwd.v = null;
    await ui.press({ key: "repo-only" });
    await r.clock.settle();
    expect(await ui.find(TEXT(/^Could not look for hints: /))).toBeDefined();
    expect(await ui.find(TEXT(/^Looking for ways to spend less\.\.\.$/))).toBeUndefined();
    await ui.unmount();
  });

  test("the key line says tab/enter shows evidence while a hint has evidence to open", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    expect(await ui.find(TEXT(/tab\/enter evidence/))).toBeDefined();
    await ui.unmount();
  });
});

describe("hints drawing", () => {
  test("with nothing to adopt or open, y and e are held by a status row, not left for the prompt", async ($, on) => {
    hintsHost(on, { span: [] });
    const ui = await mountHost($);
    expect((await ui.find({ key: "held-y" }))?.props.hotkey).toBe("y");
    expect((await ui.find({ key: "held-e" }))?.props.hotkey).toBe("e");
    expect((await ui.find({ key: "held-y" }))?.props.label).toBe(NO_ADOPT);
    expect((await ui.find({ key: "held-e" }))?.props.label).toBe(NO_EVIDENCE);
    await ui.unmount();
  });

  test("a hint with evidence takes e; with no adopt button y stays held", async ($, on) => {
    hintsHost(on, { span: [hintOf("big", 5, { evidence: EVIDENCE })] });
    const ui = await mountHost($);
    expect(await ui.find({ key: "held-e" })).toBeUndefined();
    expect((await ui.find({ key: "held-y" }))?.props.hotkey).toBe("y");
    await ui.unmount();
  });

  test("a low-confidence hint says so; others do not", async ($, on) => {
    hintsHost(on, { span: [hintOf("a", 3, { confidence: "low" }), hintOf("b", 2, { confidence: "high" }), hintOf("c", 1)] });
    const ui = await mountHost($);
    expect((await ui.findAll(TEXT(/ \u{b7} low confidence$/u))).length).toBe(1);
    expect(await ui.find(TEXT(exact("Title of a \u{b7} low confidence")))).toBeDefined();
    expect(await ui.find(TEXT(exact("Title of b")))).toBeDefined();
    await ui.unmount();
  });

  test("the Do label keeps its width beside a long action, so it never wraps", async ($, on) => {
    hintsHost(on, { span: [hintOf("a", 3, { action: "A long action that wraps over several lines in a narrow pane. ".repeat(4) })] });
    const ui = await mountHost($);
    const label = await ui.find({ key: `${hintRowKey("span", "a")}-action-term` });
    expect(label?.props.flexShrink).toBe(0);
    expect(await ui.find(TEXT(exact("Do")))).toBeDefined();
    await ui.unmount();
  });

  test("a hint with no evidence draws no evidence row", async ($, on) => {
    hintsHost(on, { span: [hintOf("bare", 1)], shown: ["hint|span|bare"] });
    const ui = await mountHost($);
    expect(await ui.find({ key: "open-hint|span|bare" })).toBeUndefined();
    expect(await ui.find(TEXT(/evidence/))).toBeUndefined();
    await ui.unmount();
  });

  test("an open hint draws every evidence kind as its label and detail, in order", async ($, on) => {
    hintsHost(on, { span: [hintOf("big", 5, { evidence: EVIDENCE })], shown: ["hint|span|big"] });
    const ui = await mountHost($);
    const lines = (await ui.findAll(TEXT(/ \u{b7} |^Session$/u))).map((n) => n.text);
    expect(lines).toEqual(["Command \u{b7} git push origin secret-branch", "File \u{b7} C:\\a\\b\\secret.txt", "Session \u{b7} Fix the widget", "Requests \u{b7} 3 rebuilds"]);
    await ui.unmount();
  });

  test("redaction strips a command to its program, a path to its file, a title to nothing and keeps text", async ($, on) => {
    hintsHost(on, { span: [hintOf("big", 5, { evidence: EVIDENCE })], shown: ["hint|span|big"], redact: true });
    const ui = await mountHost($);
    const lines = (await ui.findAll(TEXT(/ \u{b7} |^Session$/u))).map((n) => n.text);
    expect(lines).toEqual(["Command \u{b7} git", "File \u{b7} secret.txt", "Session", "Requests \u{b7} 3 rebuilds"]);
    await ui.unmount();
  });

  test("an open hint with more than twelve evidence rows is cut with an ellipsis", async ($, on) => {
    const many = Array.from({ length: 15 }, (_, n): Evidence => ({ label: `Row ${n}`, detail: "x", kind: "text" }));
    hintsHost(on, { span: [hintOf("many", 1, { evidence: many })], shown: ["hint|span|many"] });
    const ui = await mountHost($);
    expect(await ui.find(TEXT(exact("Row 11 \u{b7} x")))).toBeDefined();
    expect(await ui.find(TEXT(exact("Row 12 \u{b7} x")))).toBeUndefined();
    expect(await ui.find(TEXT(exact("...")))).toBeDefined();
    await ui.unmount();
  });

  test("the key line lists tab/enter for evidence only when asked", () => {
    const plain = keyLine("hints", {}).join(" ");
    expect(plain).toContain("s time span");
    expect(plain).toContain("r repo filter");
    expect(plain).not.toContain("show evidence");
    expect(keyLine("hints", { evidence: true }).join(" ")).toContain("tab/enter show evidence");
  });
});
