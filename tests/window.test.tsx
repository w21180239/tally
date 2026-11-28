import type { On, PaneOpenArgs, RenderInput, SessionRateLimit, SessionUsage } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";
import type { Shard } from "../core/shard.ts";
import { dayIdx, saveBuckets } from "../engine/project-store.ts";
import { req, T0 } from "./fixtures/rows.ts";
import { clockOf, worldOf } from "./world.ts";
import type { World } from "./world.ts";

const PLUGIN = "tally";
const NOW = Date.UTC(2026, 10, 27, 12);
const CWD = "/work/demo";

const PANE: Omit<RenderInput<"Pane">, "surface"> = {
  component: "Pane",
  requestId: PLUGIN,
  viewport: { columns: 200, rows: 50, isFullscreen: true },
  props: { title: "tally", isFocused: true, bodyColumns: 89, placement: "dock", scroll: { offset: 0, bodyRows: 40 }, view: {} },
};
const INLINE_NARROW: Omit<RenderInput<"Pane">, "surface"> = {
  ...PANE,
  viewport: { columns: 100, rows: 50, isFullscreen: true },
  props: { ...PANE.props, placement: "inline", bodyColumns: 96, scroll: { offset: 0, bodyRows: 15 } },
};
const BAND: Omit<RenderInput<"AbovePrompt">, "surface"> = {
  component: "AbovePrompt",
  requestId: "above-prompt",
  viewport: { columns: 200, rows: 50, isFullscreen: true },
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 115, scroll: { offset: 0, bodyRows: 9 }, view: {} },
};

const limits = (five: number, seven = 22): SessionRateLimit[] => [
  { kind: "five_hour", percentUsed: five, resetsAt: new Date(NOW + (4 * 60 + 20) * 60_000).toISOString() },
  { kind: "seven_day", percentUsed: seven, resetsAt: new Date(NOW + (3 * 24 + 5) * 3_600_000).toISOString() },
];

type Rig = {
  opened: PaneOpenArgs[];
  closed: string[];
  toasts: string[];
  stored: Map<string, unknown>;
  place: { v: (a: PaneOpenArgs) => { isPlaced: true } | { isPlaced: false; reason: string } };
  usage: { v: SessionUsage };
  config: { sets: Array<{ key: string; value: unknown }> };
  clock: ReturnType<typeof mock.clock>;
  sid: { v: string };
  logs: string[];
  redraws: { n: number };
  failSet: { v: boolean };
};

/** The engine beneath tally: clock, env, store, the pane calls, the session's id and usage, an empty index. */
function rig(on: On, store: Record<string, unknown> = {}, world?: World): Rig {
  const r: Rig = {
    opened: [],
    closed: [],
    toasts: [],
    stored: new Map(Object.entries(store)),
    place: { v: () => ({ isPlaced: true }) },
    usage: { v: { startedAt: NOW, context: { tokens: 236_000, window: 1_000_000, percent: 24 }, rateLimits: limits(6), cost: { usd: 0 } } },
    config: { sets: [] },
    clock: clockOf(on, { now: NOW }),
    sid: { v: "s-1" },
    logs: [],
    redraws: { n: 0 },
    failSet: { v: false },
  };
  mock.env(on, { HOME: "/home/u" });
  on("store.get", (_, e) => ({ value: r.stored.get(e.key) }));
  on("store.set", (_, e) => {
    if (r.failSet.v) return { deny: "disk full" };
    r.stored.set(e.key, e.value);
    return { value: undefined };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("session.measure", (_, e) => ({ changed: e.changed }));
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("ui.open", (_, e) => {
    r.opened.push(e);
    return { value: r.place.v(e) };
  });
  on("ui.close", (_, e) => {
    r.closed.push(e.id);
    return { value: undefined };
  });
  on("ui.toast", (_, e) => {
    r.toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.log", (_, e) => {
    r.logs.push(e.text);
    return { value: undefined };
  });
  on("ui.invalidate", () => {
    r.redraws.n++;
    return { value: undefined };
  });
  on("ui.panes", () => ({ value: r.opened.length > 0 && r.closed.length < r.opened.length ? [{ id: PLUGIN, title: PLUGIN, isShown: true, isFocused: false, isPlaced: true }] : [] }));
  on("session.id", () => ({ value: r.sid.v }));
  on("session.cwd", () => ({ value: CWD }));
  on("session.model", () => ({ value: "claude-opus-5-5" }));
  on("session.info", () => ({ value: { platform: "linux" } }));
  on("session.usage", (_, e) => ({ value: e.breakdown === undefined ? r.usage.v : { ...r.usage.v, context: { ...r.usage.v.context, breakdown: { autoCompactThreshold: 800_000 } } as never } }));
  if (world === undefined) {
    on("fs.list", () => ({ value: [] }));
    on("fs.read", (_, e) => ({ deny: `ENOENT: ${e.path}` }));
    on("fs.exists", () => ({ value: false }));
  } else {
    on("fs.read", async (_, e) => ({ value: await world.$.fs.read(e.path, { as: e.as, offset: e.offset, length: e.length } as never) }));
    on("fs.write", async (_, e) => ({ value: await world.$.fs.write(e.path, e.text) }));
    on("fs.list", async (_, e) => ({ value: await world.$.fs.list(e.path) }));
    on("fs.exists", async (_, e) => ({ value: await world.$.fs.exists(e.path) }));
    on("fs.stat", async (_, e) => ({ value: await world.$.fs.stat(e.path) }));
  }
  on("config.list", () => ({ value: [{ key: "tally.money", label: "Money", kind: "choice", value: "cents-and-dollars", provider: { plugin: PLUGIN, tier: "user" }, isLocked: false }] as never }));
  on("config.set", (_, e) => {
    r.config.sets.push({ key: e.key, value: e.value });
    return { value: e.value };
  });
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("prompt.submit", (_, e) => ({ text: e.text }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  return r;
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
const prompt = (text: string) => ({ text, wait: false, origin: { kind: "composer" as const } });
const TEXT = (re: RegExp) => ({ type: "Text" as const, text: re });

/** The kit's `$` raises no `ui.close`: this plugin's command stands for the person's Esc or close mark. */
const CLOSER = {
  plugins: [
    {
      name: "closer",
      register(on: On) {
        on("command.run", { command: "shut" }, async ($) => {
          await $.ui.close({ id: "tally" });
          return { text: "closed" };
        });
      },
    },
  ],
};
const SHUT = { command: "shut", args: "", origin: { kind: "composer" as const }, presentation: { isFullscreen: true, columns: 200 } };
const run = (args: string) => ({ command: "tally", args, origin: { kind: "composer" as const }, presentation: { isFullscreen: true, columns: 200 } });

async function turn($: Engine, r: Rig, id: string): Promise<void> {
  await $.turn.start({ turnId: id, text: "go" });
  await $.turn.complete({ turnId: id, answer: "done", durationMs: 10, isAborted: false, reason: "answer" });
  await r.clock.settle();
}

describe("window: tabs and keys", () => {
  test("pressing 2 selects the Usage tab; the tab bar holds the digit keys", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find({ key: "body-session" })).toBeDefined();
    const keys = await ui.findAll({ type: "Button" });
    const hotkeys = keys.map((b) => b.props.hotkey).filter((k) => k !== undefined);
    expect([...hotkeys].sort()).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect((await ui.find({ key: "tab-usage" }))?.props.hotkey).toBe("2");
    await ui.press({ key: "tab-usage" });
    expect(await ui.find({ key: "body-usage" })).toBeDefined();
    expect(await ui.find({ key: "body-session" })).toBeUndefined();
    expect(r.stored.get("tab")).toBe("usage");
    await ui.unmount();
  });

  test("the span switch holds `s` on the next span and cycles Usage through session, 24h, 30d", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-usage" });
    expect((await ui.find({ key: "span-24h" }))?.props.hotkey).toBe("s");
    expect((await ui.find({ key: "span-session" }))?.props.hotkey).toBeUndefined();
    await ui.press({ key: "span-24h" });
    expect((await ui.find({ key: "span-30d" }))?.props.hotkey).toBe("s");
    await ui.press({ key: "span-30d" });
    expect((await ui.find({ key: "span-session" }))?.props.hotkey).toBe("s");
    expect(r.stored.get("span")).toBe("30d");
    // Hints has no session span: a view left on it shows 30 days.
    await ui.press({ key: "tab-hints" });
    expect((await ui.find({ key: "span-24h" }))?.props.hotkey).toBe("s");
    expect(await ui.find({ key: "span-session" })).toBeUndefined();
    await ui.unmount();
  });

  test("History and Hints switch repos on `r`; Session has no switches", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find({ key: "repo-all" })).toBeUndefined();
    await ui.press({ key: "tab-history" });
    expect((await ui.find({ key: "repo-only" }))?.props.hotkey).toBe("r");
    await ui.press({ key: "repo-only" });
    expect((await ui.find({ key: "repo-all" }))?.props.hotkey).toBe("r");
    await ui.unmount();
  });

  test("the key line lists the keys of the tab on the terminal and tracks the tab", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find(TEXT(/^keys active \u{b7} 0-5 switch tab \u{b7} esc collapse$/u))).toBeDefined();
    await ui.press({ key: "tab-hints" });
    expect(await ui.find(TEXT(/0-5 switch tab \u{b7} s time span \u{b7} r repo filter \u{b7} esc collapse/u))).toBeDefined();
    await ui.unmount();
  });

  test("the last tab and span come back from the store at session start", async ($, on) => {
    const r = rig(on, { tab: "hints", span: "24h" });
    await start($);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find({ key: "body-hints" })).toBeDefined();
    expect((await ui.find({ key: "span-30d" }))?.props.hotkey).toBe("s");
    await ui.unmount();
  });
});

describe("window: layouts", () => {
  test("the dock draws tabs, body and foot; the foot has cache, context, compact threshold and both limits", async ($, on) => {
    const r = rig(on);
    await start($);
    await turn($, r, "t1");
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find(TEXT(/^Context$/))).toBeDefined();
    expect(await ui.find(TEXT(/^236k of a 1M window$/))).toBeDefined();
    expect(await ui.find(TEXT(/^compact at 800k$/))).toBeDefined();
    expect(await ui.find(TEXT(/^Limits$/))).toBeDefined();
    expect(await ui.find(TEXT(/^5-hour \u{b7} resets in 4h 20m$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^7-day \u{b7} resets in 3d 5h$/u))).toBeDefined();
    expect(await ui.find(TEXT(/^6%$/))).toBeDefined();
    await ui.unmount();
  });

  test("a terminal under 110 columns cannot dock: the inline frame is the short view with no tabs", async ($, on) => {
    const r = rig(on);
    await start($);
    await turn($, r, "t1");
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...INLINE_NARROW });
    expect(await ui.find({ key: "short" })).toBeDefined();
    expect(await ui.find({ key: "tab-usage" })).toBeUndefined();
    expect(await ui.find(TEXT(/widen the terminal to dock the tabs/))).toBeDefined();
    await ui.unmount();
  });

  test("inline on the main screen draws the tabs, with the fullscreen tip until the person first acts", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const inline: Omit<RenderInput<"Pane">, "surface"> = { ...INLINE_NARROW, viewport: { columns: 200, rows: 50, isFullscreen: false }, props: { ...INLINE_NARROW.props, bodyColumns: 196, scroll: { offset: 0, bodyRows: 30 } } };
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...inline });
    expect(await ui.find({ key: "tab-usage" })).toBeDefined();
    expect(await ui.find({ key: "tip" })).toBeDefined();
    await ui.press({ key: "tab-usage" });
    expect(await ui.find({ key: "tip" })).toBeUndefined();
    await ui.unmount();
  });

  test("a body under 40 columns is the compact card", async ($, on) => {
    const r = rig(on);
    await start($);
    await turn($, r, "t1");
    const card: Omit<RenderInput<"Pane">, "surface"> = { ...PANE, props: { ...PANE.props, bodyColumns: 36 } };
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...card });
    expect(await ui.find({ key: "card" })).toBeDefined();
    expect(await ui.find({ key: "tab-usage" })).toBeUndefined();
    expect(await ui.find(TEXT(/^ctx$/))).toBeDefined();
    await ui.unmount();
  });

  test("a body of 40 to 69 columns draws the tab faces without their digits", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const narrow: Omit<RenderInput<"Pane">, "surface"> = { ...PANE, props: { ...PANE.props, bodyColumns: 50 } };
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...narrow });
    // Narrow, the faces are plain labels; at 70 columns and up on the terminal each also shows its digit.
    expect((await ui.find({ key: "tab-session" }))?.props.plain).toBeUndefined();
    await ui.unmount();
    const ui2 = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect((await ui2.find({ key: "tab-session" }))?.props.plain).toBe(true);
    await ui2.unmount();
  });
});

describe("window: surfaces", () => {
  test("VS Code draws no key line and no key faces, and its bars are Svg; the terminal draws the key line and text bars", async ($, on) => {
    const r = rig(on);
    await start($);
    await turn($, r, "t1");
    const code = await $.ui.mount({ plugin: PLUGIN, surface: "vscode", ...PANE });
    expect(await code.find(TEXT(/esc collapse|ctrl\+x|0-5 switch tab/))).toBeUndefined();
    expect((await code.find({ key: "tab-usage" }))?.props.plain).toBeUndefined();
    expect((await code.findAll({ type: "Svg" })).length).toBeGreaterThanOrEqual(3);
    expect(await code.find(TEXT(/\u{2588}|\u{2591}/u))).toBeUndefined();
    await code.unmount();
    const term = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await term.find(TEXT(/esc collapse/))).toBeDefined();
    expect((await term.findAll({ type: "Svg" })).length).toBe(0);
    expect(await term.find(TEXT(/\u{2588}|\u{2591}/u))).toBeDefined();
    await term.unmount();
  });

  test("on the desktop the band is the info row with a details button that opens the window; desktopRow off leaves the band beneath", async ($, on) => {
    const r = rig(on);
    on("ui.render", { component: "AbovePrompt" }, ($$, e) => {
      const { Text } = $$.ui.resolve(e);
      return <Text>engine band</Text>;
    });
    await start($);
    await turn($, r, "t1");
    const band = await $.ui.mount({ plugin: PLUGIN, surface: "desktop", ...BAND });
    expect(await band.find(TEXT(/session/))).toBeDefined();
    expect(await band.find({ type: "Button", key: "tally-details" })).toBeDefined();
    expect(await band.find(TEXT(/^Limits$/))).toBeDefined();
    const before = r.opened.length;
    await band.press({ key: "tally-details" });
    expect(r.opened.length).toBe(before + 1);
    expect(r.opened.at(-1)?.focus).toBe(true);
    await band.unmount();
  });

  test("desktopRow off: the desktop band is not the info row", { options: { desktopRow: false } }, async ($, on) => {
    const r = rig(on);
    on("ui.render", { component: "AbovePrompt" }, ($$, e) => {
      const { Text } = $$.ui.resolve(e);
      return <Text>engine band</Text>;
    });
    await start($);
    await r.clock.settle();
    const band = await $.ui.mount({ plugin: PLUGIN, surface: "desktop", ...BAND });
    expect(await band.find({ key: "tally-details" })).toBeUndefined();
    expect(await band.find(TEXT(/engine band/))).toBeDefined();
    await band.unmount();
  });

  test("VS Code has no band: nothing of the fold or the info row is drawn there", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const band = await $.ui.mount({ plugin: PLUGIN, surface: "vscode", ...BAND });
    expect(await band.find({ key: "tally-details" })).toBeUndefined();
    expect(await band.find({ key: "tally-fold" })).toBeUndefined();
    await band.unmount();
  });
});

const CFG = "/home/u/.claude";
const PROJECT = "-work-demo";

// Two busy hours in the last 8: the one 3.5 hours ago small, the one 30 minutes ago big.
async function seedHours(w: World): Promise<void> {
  const rows = [
    req({ id: "a", at: NOW - T0 - 3.5 * 3_600_000, tokens: { input: 1000 } }),
    req({ id: "b", at: NOW - T0 - 30 * 60_000, tokens: { input: 100_000 } }),
  ];
  const days = new Map<number, Shard>();
  for (const row of rows) {
    const d = dayIdx(row.ts);
    const shard = days.get(d) ?? { v: 1, project: PROJECT, files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
    shard.usage.push(row);
    days.set(d, shard);
  }
  await saveBuckets(w.$, CFG, PROJECT, { days }, {}, NOW);
  w.put(`${CFG}/projects/${PROJECT}/x.jsonl`, "");
}

describe("window: the 8-hour chart", () => {
  test("the folded line and the short view carry the last 8 hours of the index, one glyph an hour", async ($, on) => {
    const world = worldOf();
    await seedHours(world);
    const r = rig(on, { mode: "folded" }, world);
    await start($);
    await r.clock.settle();
    const band = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...BAND });
    const fold = await band.find({ type: "Button", key: "tally-fold" });
    expect(fold?.props.label).toContain("\u{b7}\u{b7}\u{b7}\u{2582}\u{b7}\u{b7}\u{2585}\u{b7}");
    await band.unmount();
    const short = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...INLINE_NARROW });
    expect(await short.find(TEXT(/^8h \u{b7}\u{b7}\u{b7}\u{2582}\u{b7}\u{b7}\u{2585}\u{b7}$/u))).toBeDefined();
    await short.unmount();
  });

  test("an empty index draws no chart", async ($, on) => {
    const r = rig(on, { mode: "folded" });
    await start($);
    await r.clock.settle();
    const band = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...BAND });
    expect((await band.find({ key: "tally-fold" }))?.props.label).toBe("0\u{a2} \u{b7} ctx 236k (24%)");
    await band.unmount();
  });
});

describe("window: open, fold, remember", () => {
  test("Esc folds the window to its line above the prompt and the next session starts folded", { ...CLOSER }, async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    expect(r.opened).toHaveLength(1);
    const band = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...BAND });
    expect(await band.find({ key: "tally-fold" })).toBeUndefined();
    await $.command.run(SHUT);
    expect(r.stored.get("mode")).toBe("folded");
    const fold = await band.find({ type: "Button", key: "tally-fold" });
    expect(fold).toBeDefined();
    expect(fold?.props.label).toMatch(/ctx 236k \(24%\)/);
    // A press on the line opens the window again, with the keys.
    await band.press({ key: "tally-fold" });
    expect(r.opened).toHaveLength(2);
    expect(r.opened[1]?.focus).toBe(true);
    expect(r.stored.get("mode")).toBe("open");
    await band.unmount();
  });

  test("a stored folded mode starts folded: the pane is not opened and the line is drawn", async ($, on) => {
    const r = rig(on, { mode: "folded" });
    await start($);
    await r.clock.settle();
    expect(r.opened).toHaveLength(0);
    const band = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...BAND });
    expect(await band.find({ key: "tally-fold" })).toBeDefined();
    await band.unmount();
  });

  test("the window asks for 90 x 40 and Esc to close; an unasked open held back by a narrow terminal starts folded", async ($, on) => {
    const r = rig(on);
    r.place.v = () => ({ isPlaced: false, reason: "unasked: terminal 120 columns, floor 144" });
    await start($);
    await r.clock.settle();
    expect(r.opened[0]).toMatchObject({ id: PLUGIN, columns: 90, rows: 40, closeOnEscape: true });
    expect(r.opened[0]?.focus).toBeUndefined();
    expect(r.closed).toEqual([PLUGIN]);
    const band = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...BAND });
    expect(await band.find({ key: "tally-fold" })).toBeDefined();
    await band.unmount();
  });

  test("before-first-message (the default) folds the window on the first message, once", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    expect(r.opened).toHaveLength(1);
    await $.prompt.submit(prompt("hello"));
    expect(r.closed).toEqual([PLUGIN]);
    await $.prompt.submit(prompt("again"));
    expect(r.closed).toEqual([PLUGIN]);
    expect(r.opened).toHaveLength(1);
    // The automatic fold is not the person's choice: the next session opens it again.
    expect(r.stored.get("mode")).toBeUndefined();
  });

  test("a window the person opened themselves stays open through the first message", async ($, on) => {
    const r = rig(on, { mode: "open" });
    await start($);
    await r.clock.settle();
    await $.prompt.submit(prompt("hello"));
    expect(r.closed).toEqual([]);
  });

  test("always keeps it open after a message", { options: { open: "always" } }, async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    await $.prompt.submit(prompt("hello"));
    expect(r.opened).toHaveLength(1);
    expect(r.closed).toEqual([]);
  });

  test("never does not open it at start; /tally opens it", { options: { open: "never" } }, async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    expect(r.opened).toHaveLength(0);
    const out = await $.command.run(run(""));
    expect(out.text).toBe("tally opened.");
    expect(r.opened).toHaveLength(1);
    expect(r.opened[0]?.focus).toBe(true);
  });

  test("a session with no person (not interactive) opens nothing", async ($, on) => {
    const r = rig(on);
    await $.session.start({ cwd: CWD, surface: "terminal", isInteractive: false });
    await r.clock.settle();
    expect(r.opened).toHaveLength(0);
  });
});

describe("/tally routing", () => {
  test("a tab and span open the window there and are remembered", async ($, on) => {
    const r = rig(on, { mode: "folded" });
    await start($);
    await r.clock.settle();
    const out = await $.command.run(run("hints 24h"));
    expect(out.text).toBe("tally opened on hints 24h.");
    expect(r.opened).toHaveLength(1);
    expect(r.stored.get("tab")).toBe("hints");
    expect(r.stored.get("span")).toBe("24h");
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find({ key: "body-hints" })).toBeDefined();
    await ui.unmount();
  });

  test("usage session in either order is the Usage tab on the session span; a bare session is the Session tab", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    await $.command.run(run("session usage"));
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find({ key: "body-usage" })).toBeDefined();
    expect((await ui.find({ key: "span-24h" }))?.props.hotkey).toBe("s");
    await $.command.run(run("session"));
    expect(await ui.find({ key: "body-session" })).toBeDefined();
    await ui.unmount();
  });

  test("settings alone change settings and do not open; any word order works with a tab", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const before = r.opened.length;
    const out = await $.command.run(run("money dollars"));
    expect(out.text).toBe("money set to dollars.");
    expect(r.config.sets).toEqual([{ key: "tally.money", value: "dollars" }]);
    expect(r.opened.length).toBe(before);
    const both = await $.command.run(run("usage money dollars"));
    expect(both.text).toBe("tally opened on usage, money set to dollars.");
    expect(r.opened.length).toBe(before + 1);
  });

  test("an unknown word changes nothing and says what is understood", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const before = r.opened.length;
    const out = await $.command.run(run("usage banana"));
    expect(out.text).toContain('"banana"');
    expect(r.opened.length).toBe(before);
    expect(r.config.sets).toEqual([]);
  });

  test("debug and debug --json still answer", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    expect((await $.command.run(run("debug"))).text).toContain("tally debug");
    expect(JSON.parse((await $.command.run(run("debug --json"))).text).byDay.length).toBe(30);
  });
});

describe("window: limit warning", () => {
  test("a limit over 80% raises one toast per session, not one per turn", async ($, on) => {
    const r = rig(on);
    r.usage.v = { ...r.usage.v, rateLimits: limits(81) };
    await start($);
    await r.clock.settle();
    await turn($, r, "t1");
    await turn($, r, "t2");
    await turn($, r, "t3");
    expect(r.toasts).toHaveLength(1);
    expect(r.toasts[0]).toBe("tally: your 5-hour limit is 81% used (resets in 4h 20m).");
  });

  test("80% exactly raises nothing; a window that crosses later raises it then", async ($, on) => {
    const r = rig(on);
    r.usage.v = { ...r.usage.v, rateLimits: limits(80, 80) };
    await start($);
    await r.clock.settle();
    await turn($, r, "t1");
    expect(r.toasts).toHaveLength(0);
    r.usage.v = { ...r.usage.v, rateLimits: limits(80, 83) };
    await turn($, r, "t2");
    expect(r.toasts).toHaveLength(1);
    expect(r.toasts[0]).toContain("7-day limit is 83% used");
    await turn($, r, "t3");
    expect(r.toasts).toHaveLength(1);
  });
});

describe("window: /clear keeps the line and the timers", () => {
  const clear = ($: Engine, r: Rig) => $.session.end({ reason: "clear", sessionId: r.sid.v, resume: { id: r.sid.v } } as never);

  test("session.end with reason clear leaves the timers running; the next prompt draws the fold line again", async ($, on) => {
    const r = rig(on, { mode: "folded" });
    await start($);
    await r.clock.settle();
    await clear($, r);
    r.sid.v = "s-2";
    await $.prompt.submit(prompt("after the clear"));
    await r.clock.settle();
    const band = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...BAND });
    expect((await band.find({ key: "tally-fold" }))?.props.label).toMatch(/ctx 236k/);
    // The minute redraw still fires.
    const before = r.redraws.n;
    await r.clock.advance(60_000);
    expect(r.redraws.n).toBeGreaterThan(before);
    await band.unmount();
  });

  test("a window the person left open is open again for the new session; an auto-folded one shows its line", async ($, on) => {
    const r = rig(on, { tab: "usage" });
    await start($);
    await r.clock.settle();
    await clear($, r);
    r.sid.v = "s-2";
    await $.prompt.submit(prompt("after the clear"));
    await r.clock.settle();
    // before-first-message folded it on that first message: the line is there, on the stored tab.
    const band = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...BAND });
    expect(await band.find({ key: "tally-fold" })).toBeDefined();
    await band.unmount();
  });

  test("the first prompt under a new session id seats the view again from the store", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    await clear($, r);
    // What the view starts over from: the choices kept in the store.
    r.stored.set("tab", "hints");
    r.sid.v = "s-2";
    await $.prompt.submit(prompt("after the clear"));
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    expect(await ui.find({ key: "body-hints" })).toBeDefined();
    await ui.unmount();
  });

  test("any other end reason cancels the timers", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    await $.session.end({ reason: "other", sessionId: r.sid.v, resume: { id: r.sid.v } } as never);
    await r.clock.settle();
    const before = r.redraws.n;
    await r.clock.advance(120_000);
    expect(r.redraws.n).toBe(before);
  });
});

describe("window: the chart reads only the days it draws", () => {
  const DAY = 86_400_000;
  // Another project than the session's own: the live tally reads that one whole, the chart must not.
  const OTHER = "-other-proj";
  const dayRow = (id: string, at: number) => req({ id, at, tokens: { input: 5000 } });

  test("buckets older than the 24 hours are not read, while today's and yesterday's are", async ($, on) => {
    const world = worldOf();
    const rows = [dayRow("old1", NOW - T0 - 10 * DAY), dayRow("old2", NOW - T0 - 3 * DAY), dayRow("recent", NOW - T0 - 30 * 60_000), dayRow("late", NOW - T0 - 20 * 3_600_000)];
    const days = new Map<number, Shard>();
    for (const row of rows) {
      const d = dayIdx(row.ts);
      const shard = days.get(d) ?? { v: 1, project: OTHER, files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
      shard.usage.push(row);
      days.set(d, shard);
    }
    await saveBuckets(world.$, CFG, OTHER, { days }, {}, NOW);
    world.put(`${CFG}/projects/${OTHER}/x.jsonl`, "");
    world.reads.length = 0;
    const r = rig(on, { mode: "folded" }, world);
    await start($);
    await r.clock.settle();
    const key = (ts: number) => new Date(ts).toISOString().slice(0, 10);
    const paths = world.reads.map((x) => x.path);
    const read = (row: { ts: number }) => paths.some((p) => p.includes(`d-${key(row.ts)}`));
    expect(rows.slice(0, 2).map(read)).toEqual([false, false]);
    expect(rows.slice(2).map(read)).toEqual([true, true]);
  });
});

describe("window: held back or not placed", () => {
  test("a held-back open with any reason but no-surface starts folded", async ($, on) => {
    const r = rig(on);
    r.place.v = () => ({ isPlaced: false, reason: "terminal 120 columns, floor 144" });
    await start($);
    await r.clock.settle();
    expect(r.closed).toEqual([PLUGIN]);
    const band = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...BAND });
    expect(await band.find({ key: "tally-fold" })).toBeDefined();
    await band.unmount();
  });

  test("no-surface keeps the pane open for a surface that attaches later", async ($, on) => {
    const r = rig(on);
    r.place.v = () => ({ isPlaced: false, reason: "no-surface: nothing is attached" });
    await start($);
    await r.clock.settle();
    expect(r.closed).toEqual([]);
    expect(r.opened).toHaveLength(1);
  });
});

describe("window: background work never rejects unhandled", () => {
  test("a press whose store write is denied is logged, not thrown", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    r.failSet.v = true;
    await ui.press({ key: "tab-usage" });
    await r.clock.settle();
    expect(r.logs.some((l) => l.startsWith("tally:"))).toBe(true);
    await ui.unmount();
  });

  test("the foot's update for a measurement runs after the hook has answered", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    const measured = await $.session.measure({ context: { tokens: 300_000, window: 1_000_000, percent: 30 }, rateLimits: limits(90), changed: ["rateLimits"] } as never);
    expect(measured).toBeDefined();
    expect(r.toasts).toHaveLength(0);
    await r.clock.settle();
    expect(r.toasts).toHaveLength(1);
  });
});

// One fast request of session s-1 half an hour ago: (1000*4 + 100000*20 + 100000*0.2) / 1e6 * 2 = 4.048 dollars, half of it saved by fast mode off.
async function seedFast(w: World): Promise<void> {
  const row = { ...req({ id: "f", at: NOW - T0 - 30 * 60_000, session: "s-1", cwd: CWD, tokens: { input: 1000, output: 100_000, cacheRead: 100_000 } }), fast: true, replyChars: 400_000 };
  const shard: Shard = { v: 1, project: PROJECT, files: {}, usage: [row], users: [], metas: [], compacts: [], snapshots: [] };
  await saveBuckets(w.$, CFG, PROJECT, { days: new Map([[dayIdx(row.ts), shard]]) }, {}, NOW);
  w.put(`${CFG}/projects/${PROJECT}/s-1.jsonl`, "");
}

describe("window: the leading hint", () => {
  const HINT = "\u{25b2} fast mode: 100% of spend \u{b7} ~$2.02";

  test("fold line and Session tab carry the live session's leading hint and its estimated saving", async ($, on) => {
    const world = worldOf();
    await seedFast(world);
    const r = rig(on, { mode: "folded" }, world);
    await start($);
    await r.clock.settle();
    const band = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...BAND });
    await r.clock.settle();
    expect((await band.find({ key: "tally-fold" }))?.props.label).toContain(HINT);
    await band.unmount();
    const pane = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await r.clock.settle();
    expect(await pane.find(TEXT(new RegExp(`^${HINT.replace(/[$~.]/g, "\\$&")}$`)))).toBeDefined();
    expect(await pane.find(TEXT(/^No hint for this session yet\.$/))).toBeUndefined();
    await pane.unmount();
  });

  test("a session that raises no hint leaves the fold line without one", async ($, on) => {
    const r = rig(on, { mode: "folded" });
    await start($);
    await r.clock.settle();
    const band = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...BAND });
    await r.clock.settle();
    expect((await band.find({ key: "tally-fold" }))?.props.label).not.toContain("\u{25b2}");
    await band.unmount();
  });
});
