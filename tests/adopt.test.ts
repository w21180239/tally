import type { On, RenderInput, TurnStepResult, TurnUsage } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";
import { ADOPTIONS_KEY, CHECKED_KEY, adoptionId, dueRechecks, parseAdoptions, recheckResult, recheckText, withAdoption } from "../core/adopt.ts";
import type { Adoption } from "../core/adopt.ts";
import type { HintInput } from "../core/hint.ts";
import { ALL_RULES } from "../core/rules/index.ts";
import { activeDays } from "../core/rules/shared.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { summarize } from "../core/summary.ts";
import type { Shard } from "../core/shard.ts";
import type { UsageRow, UserRow } from "../core/types.ts";
import { dayIdx, saveBuckets } from "../engine/project-store.ts";
import { prompt, req } from "./fixtures/rows.ts";
import { worldOf } from "./world.ts";
import type { World } from "./world.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T = Date.UTC(2026, 10, 1, 9);
const adoption = (o: Partial<Adoption> = {}): Adoption => ({ rule: "fast-mode", at: T, metricName: "fast share of cost", before: 0.5, expectedUsd: 10, ...o });

describe("dueRechecks", () => {
  test("an adoption is due on day 14, not on day 13", () => {
    const a = adoption();
    expect(dueRechecks([a], T + 13 * DAY, 14)).toEqual([]);
    expect(dueRechecks([a], T + 14 * DAY - 1, 14)).toEqual([]);
    expect(dueRechecks([a], T + 14 * DAY, 14)).toEqual([a]);
    expect(dueRechecks([a], T + 40 * DAY, 14)).toEqual([a]);
  });

  test("the wait is the recheckDays given", () => {
    const a = adoption();
    expect(dueRechecks([a], T + 6 * DAY, 7)).toEqual([]);
    expect(dueRechecks([a], T + 7 * DAY, 7)).toEqual([a]);
    expect(dueRechecks([a], T + 14 * DAY, 30)).toEqual([]);
  });

  test("a rule without a metric is recorded but never due", () => {
    const plain: Adoption = { rule: "long-session", at: T, expectedUsd: 3 };
    const named: Adoption = { rule: "fast-mode", at: T, metricName: "fast share of cost", expectedUsd: 3 };
    expect(dueRechecks([plain, named], T + 400 * DAY, 14)).toEqual([]);
    expect(dueRechecks([plain, adoption()], T + 14 * DAY, 14).map((a) => a.rule)).toEqual(["fast-mode"]);
  });
});

describe("recheckResult", () => {
  test("actualUsd is (before - now) times the metric's base, the expected saving per unit of metric", () => {
    // base = 10 / 0.5 = 20 dollars per unit
    expect(recheckResult(adoption(), 0.2)).toEqual({ expectedUsd: 10, actualUsd: 6 });
    expect(recheckResult(adoption(), 0)).toEqual({ expectedUsd: 10, actualUsd: 10 });
    expect(recheckResult(adoption({ before: 4, expectedUsd: 2 }), 1)).toEqual({ expectedUsd: 2, actualUsd: 1.5 });
  });

  test("a metric that rose gives a negative saving; no usable before gives none", () => {
    expect(Math.round(recheckResult(adoption(), 0.6).actualUsd * 1e9) / 1e9).toBe(-2);
    expect(recheckResult(adoption({ before: 0 }), 0.3).actualUsd).toBe(0);
    const { before: _b, ...noBefore } = adoption();
    expect(recheckResult(noBefore, 0.3).actualUsd).toBe(0);
  });
});

describe("adoption records", () => {
  test("adopting a rule again replaces its earlier record", () => {
    const first = adoption();
    const other = adoption({ rule: "cache-rebuilt" });
    const second = adoption({ at: T + DAY, before: 0.4 });
    expect(withAdoption([first, other], second)).toEqual([other, second]);
  });

  test("stored junk is dropped, valid records kept", () => {
    const good = adoption();
    const plain: Adoption = { rule: "long-session", at: T, expectedUsd: 3 };
    expect(parseAdoptions([good, plain, null, 7, { rule: "x" }, { rule: "y", at: "no", expectedUsd: 1 }, { ...good, before: "high" }])).toEqual([good, plain]);
    expect(parseAdoptions(undefined)).toEqual([]);
    expect(parseAdoptions({})).toEqual([]);
  });

  test("the toast names the title, the expected and the actual saving, in the money setting's format", () => {
    const dollars = { money: "dollars", decimals: "auto" } as const;
    expect(recheckText("Fast-mode surcharge", { expectedUsd: 10, actualUsd: 6 }, dollars)).toBe("tally: Fast-mode surcharge: expected save $10.00, actual $6.00");
    expect(recheckText("Fast-mode surcharge", { expectedUsd: 10, actualUsd: -1.2 }, dollars)).toBe("tally: Fast-mode surcharge: expected save $10.00, actual -$1.20");
    expect(recheckText("Cache expired while idle", { expectedUsd: 0.07, actualUsd: 0.05 }, { money: "cents", decimals: "auto" })).toBe("tally: Cache expired while idle: expected save 7\u{a2}, actual 5\u{a2}");
    expect(recheckText("x", { expectedUsd: 0.07, actualUsd: 0.05 }, { money: "cents-and-dollars", decimals: "auto" })).toBe("tally: x: expected save 7\u{a2}, actual 5\u{a2}");
  });

  test("a stored title survives parsing; a record without one stays without", () => {
    const titled = adoption({ title: "Fast-mode surcharge" });
    expect(parseAdoptions([titled, { ...adoption(), title: 7 }])).toEqual([titled, adoption()]);
  });
});

// A summary with only what a rule's metric reads.
const inputOf = (s: Record<string, unknown>): HintInput => ({ scope: "span", nowMs: T, summary: s as never, snaps: [], plugins: [], prices: BUILTIN_PRICES });
const days = (...requests: number[]) => ({ bucketMs: DAY, points: requests.map((n) => ({ requests: n })) });
const metricOf = (id: string, s: Record<string, unknown>): number => ALL_RULES.find((r) => r.id === id)!.metric!(inputOf(s));

describe("rule metrics", () => {
  test("exactly the six rules named in the plan carry a metric", () => {
    expect(ALL_RULES.filter((r) => r.metric !== undefined).map((r) => r.id).sort()).toEqual(["big-paste", "cache-rebuilt", "fast-mode", "main-model-overkill", "thinking-output", "whole-reads"]);
  });

  test("cache-rebuilt takes rebuild cost over spend; fast-mode takes fast cost over spend", () => {
    const s = { total: { usd: 50 }, fast: { usd: 20 }, cacheRebuilds: [{ usd: 5 }, { usd: 5 }] };
    expect(metricOf("cache-rebuilt", s)).toBe(0.2);
    expect(metricOf("fast-mode", s)).toBe(0.4);
    expect(metricOf("cache-rebuilt", { ...s, total: { usd: 0 } })).toBe(0);
  });

  test("thinking-output takes thinking cost over output cost", () => {
    const usage = { slices: { main: { totals: { output: { usd: 6 } }, output: [{ key: "thinking", usd: 4.5 }, { key: "text", usd: 1.5 }] }, sub: { totals: { output: { usd: 2 } }, output: [{ key: "thinking", usd: 0 }] } } };
    expect(metricOf("thinking-output", { usage })).toBe(0.5625);
    expect(metricOf("thinking-output", {})).toBe(0);
  });

  test("whole-reads: duplicate whole reads per active day, files read fewer than 3 times left out", () => {
    // 4 and 3 whole reads: 3 + 2 extra copies over 2 active days
    expect(metricOf("whole-reads", { wholeReads: { a: 4, b: 2, c: 3 }, timeline: days(1, 0, 2) })).toBe(2.5);
    expect(metricOf("whole-reads", { wholeReads: {}, timeline: days(1) })).toBe(0);
  });

  test("big-paste takes the cache-read cost of oversized pastes per active day", () => {
    const pastes = [
      { sessionId: "s", tokens: 20_000, rereadUsd: 3 },
      { sessionId: "s", tokens: 6000, rereadUsd: 1 },
      { sessionId: "s", tokens: 900, rereadUsd: 9 },
    ];
    expect(metricOf("big-paste", { pastes, timeline: days(2, 2) })).toBe(2);
  });

  test("main-model-overkill takes the read-only part of the flagship models' tool turns", () => {
    const mainTools = {
      "claude-opus-5-5": { turns: 10, readOnly: { requests: 7 } },
      "claude-fable-1": { turns: 10, readOnly: { requests: 3 } },
      "claude-haiku-4-5": { turns: 100, readOnly: { requests: 100 } },
    };
    expect(metricOf("main-model-overkill", { mainTools })).toBe(0.5);
    expect(metricOf("main-model-overkill", { mainTools: {} })).toBe(0);
  });

  test("active days: days with a request; hourly buckets count 24 to the day; at least one", () => {
    expect(activeDays({ timeline: days(0, 3, 1, 0) } as never)).toBe(2);
    expect(activeDays({ timeline: { bucketMs: HOUR, points: Array.from({ length: 30 }, () => ({ requests: 1 })) } } as never)).toBe(2);
    expect(activeDays({ timeline: days(0) } as never)).toBe(1);
  });
});

describe("summary since", () => {
  const now = Date.UTC(2026, 10, 27, 12);
  const shard: Shard = { v: 1, project: "p", files: {}, usage: [req({ id: "old", at: 0, tokens: { input: 1000 } }), req({ id: "new", at: 0, tokens: { input: 1000 } })].map((r, i) => ({ ...r, ts: now - (i === 0 ? 10 : 2) * DAY })), users: [], metas: [], compacts: [], snapshots: [] };
  const opts = { span: "30d" as const, nowMs: now, tzOffsetMin: 0 };

  test("a 30d span starts at the given time when later than its own start, and counts only what came after", () => {
    expect(summarize([shard], BUILTIN_PRICES, opts).total.requests).toBe(2);
    const cut = summarize([shard], BUILTIN_PRICES, { ...opts, since: now - 5 * DAY });
    expect(cut.total.requests).toBe(1);
    expect(cut.from).toBe(now - 5 * DAY);
    // An earlier time changes nothing.
    expect(summarize([shard], BUILTIN_PRICES, { ...opts, since: now - 90 * DAY }).total.requests).toBe(2);
  });
});

// The plugin under test, driven through its hooks over an in-memory home.
const PLUGIN = "tally";
const NOW = Date.UTC(2026, 10, 27, 12);
const CWD = "/work/demo";
const CFG = "/home/u/.claude";
const OPUS = "claude-opus-5-5";
const PANE: Omit<RenderInput<"Pane">, "surface"> = {
  component: "Pane",
  requestId: PLUGIN,
  viewport: { columns: 200, rows: 80, isFullscreen: true },
  props: { title: "tally", isFocused: true, bodyColumns: 120, placement: "dock", scroll: { offset: 0, bodyRows: 160 }, view: {} },
};
const TEXT = (re: RegExp) => ({ type: "Text" as const, text: re });

// `unreadable`: paths whose reads fail, so the scanner never finishes them.
type Rig = { world: World; clock: ReturnType<typeof mock.clock>; stored: Map<string, unknown>; toasts: string[]; unreadable: Set<string> };

const usageOf = (): TurnUsage => ({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000, model: OPUS, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 });

function rig(on: On, stored: Map<string, unknown> = new Map()): Rig {
  const world = worldOf();
  const r: Rig = { world, clock: mock.clock(on, { now: NOW }), stored, toasts: [], unreadable: new Set() };
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
  on("ui.toast", (_, e) => {
    r.toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.log", () => ({ value: undefined }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.panes", () => ({ value: [] }));
  on("session.id", () => ({ value: "s-1" }));
  on("session.cwd", () => ({ value: CWD }));
  on("session.model", () => ({ value: OPUS }));
  on("session.info", () => ({ value: { platform: "linux" } }));
  on("session.usage", () => ({ value: { startedAt: NOW, context: { tokens: 236_000, window: 1_000_000, percent: 24 }, rateLimits: [], cost: { usd: 0 } } as never }));
  on("fs.read", async (_, e) => {
    // The engine may hand over a drive-prefixed, backslashed path.
    const p = e.path.replace(/\\/g, "/");
    if ([...r.unreadable].some((u) => p.endsWith(u))) throw new Error("unreadable");
    return { value: await world.$.fs.read(e.path, { as: e.as, offset: e.offset, length: e.length } as never) };
  });
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

const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: CWD, surface: "terminal", isInteractive });
const ago = (d: number): number => NOW - d * DAY;
const at = <U extends { ts: number }>(row: U, ts: number): U => ({ ...row, ts });

// One fast request half a day ago: worth 4.048 dollars, all of the spend, so fast mode's share is about 1 and its saving 2.024.
const demoRows = (): { usage: UsageRow[]; users: UserRow[] } => ({
  usage: [{ ...at(req({ id: "a", at: 0, session: "s-1", cwd: CWD, tokens: { input: 1000, output: 100_000, cacheRead: 100_000 } }), ago(0.5)), fast: true, replyChars: 400_000 }],
  users: [at(prompt(0, 200, "build it", "s-1"), ago(0.5))],
});

async function seed(w: World, rows = demoRows()): Promise<void> {
  const byDay = new Map<number, Shard>();
  const shardOn = (ts: number): Shard => {
    const d = dayIdx(ts);
    const sh = byDay.get(d) ?? { v: 1, project: "-work-demo", files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
    byDay.set(d, sh);
    return sh;
  };
  for (const row of rows.usage) shardOn(row.ts).usage.push(row);
  for (const u of rows.users) shardOn(u.ts).users.push(u);
  await saveBuckets(w.$, CFG, "-work-demo", { days: byDay }, {}, NOW);
  w.put(`${CFG}/projects/-work-demo/s-1.jsonl`, "");
}

// The recheck waits a few seconds after a start.
const afterStart = async (r: Rig): Promise<void> => {
  await r.clock.advance(11_000);
  await r.clock.settle();
};

async function openHints($: Engine, r: Rig, rows = demoRows()) {
  await seed(r.world, rows);
  await start($);
  await r.clock.settle();
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
  await ui.press({ key: "tab-hints" });
  await r.clock.settle();
  return ui;
}

describe("adopting a hint", () => {
  test("pressing y stores the leading hint's record: rule, date, metric value and expected saving", async ($, on) => {
    const r = rig(on);
    const ui = await openHints($, r);
    const keyed = (await ui.findAll({ type: "Button" })).filter((b) => b.props.hotkey === "y");
    expect(keyed.map((b) => b.props.key)).toEqual(["adopt-hint|session|fast-mode"]);
    expect(await ui.find(TEXT(/y adopt/))).toBeDefined();
    expect(r.stored.get(ADOPTIONS_KEY)).toBeUndefined();
    await ui.press({ key: "adopt-hint|session|fast-mode" });
    await r.clock.settle();
    const list = parseAdoptions(r.stored.get(ADOPTIONS_KEY));
    expect(list.length).toBe(1);
    const a = list[0]!;
    expect(a.rule).toBe("fast-mode");
    expect(a.title).toBe("Fast-mode surcharge");
    expect(a.at).toBe(NOW);
    expect(a.metricName).toBe("fast share of cost");
    expect(a.before).toBeGreaterThan(0.99);
    expect(Math.round(a.expectedUsd * 1e3) / 1e3).toBe(2.024);
    await ui.unmount();
  });

  test("an adopted hint reads adopted and gives up the key", async ($, on) => {
    const r = rig(on);
    const ui = await openHints($, r);
    await ui.press({ key: "adopt-hint|session|fast-mode" });
    await r.clock.settle();
    expect((await ui.find({ key: "adopt-hint|session|fast-mode" }))?.props.label).toBe("adopted");
    expect((await ui.findAll({ type: "Button" })).filter((b) => b.props.hotkey === "y").length).toBe(0);
    // The same rule in the span block is the same adoption.
    expect((await ui.find({ key: "adopt-hint|span|fast-mode" }))?.props.label).toBe("adopted");
    await ui.unmount();
  });
});

describe("adopting where the 30-day window is silent", () => {
  test("the rule gives no hint over all repos: value and saving both stay the shown hint's, never mixed", async ($, on) => {
    const r = rig(on);
    // A $40 non-fast request in another session dilutes fast mode below its cutoff over 30 days; that session alone still fires.
    const base = demoRows();
    const big = at(req({ id: "big", at: 0, session: "s-2", cwd: CWD, tokens: { output: 2_000_000 } }), ago(0.4));
    const ui = await openHints($, r, { usage: [...base.usage, big], users: [...base.users, at(prompt(0, 50, "other", "s-2"), ago(0.4))] });
    await ui.press({ key: "adopt-hint|session|fast-mode" });
    await r.clock.settle();
    const a = parseAdoptions(r.stored.get(ADOPTIONS_KEY))[0]!;
    // The shown hint: fast share of 1 in that session and its saving 2.024. The 30-day share would be near 0.09.
    expect(a.before).toBe(1);
    expect(Math.round(a.expectedUsd * 1e3) / 1e3).toBe(2.024);
    await ui.unmount();
  });
});

describe("recheck", () => {
  const due = (o: Partial<Adoption> = {}): Adoption => ({ rule: "fast-mode", at: NOW - 14 * DAY, metricName: "fast share of cost", before: 2, expectedUsd: 4, ...o });

  test("a due adoption toasts expected and actual saving once, then is marked done", async ($, on) => {
    const stored = new Map<string, unknown>([[ADOPTIONS_KEY, [due()]]]);
    const r = rig(on, stored);
    await seed(r.world);
    await start($);
    await afterStart(r);
    // base = 4 / 2 = 2 dollars per unit; fast share is now about 1: (2 - 1) * 2
    expect(r.toasts).toEqual(["tally: fast-mode: expected save $4.00, actual $2.00"]);
    expect(stored.get(CHECKED_KEY)).toEqual([adoptionId(due())]);
    await start($);
    await afterStart(r);
    expect(r.toasts.length).toBe(1);
  });

  test("the toast follows the money setting and names the stored title", { options: { money: "cents" } }, async ($, on) => {
    const stored = new Map<string, unknown>([[ADOPTIONS_KEY, [due({ title: "Fast-mode surcharge" })]]]);
    const r = rig(on, stored);
    await seed(r.world);
    await start($);
    await afterStart(r);
    expect(r.toasts).toEqual(["tally: Fast-mode surcharge: expected save 400\u{a2}, actual 200\u{a2}"]);
  });

  test("a session that is not interactive neither toasts nor marks the adoption done", async ($, on) => {
    const stored = new Map<string, unknown>([[ADOPTIONS_KEY, [due()]]]);
    const r = rig(on, stored);
    await seed(r.world);
    await start($, false);
    await afterStart(r);
    expect(r.toasts).toEqual([]);
    expect(stored.get(CHECKED_KEY)).toBeUndefined();
    // The next interactive start still finds it due.
    await start($);
    await afterStart(r);
    expect(r.toasts.length).toBe(1);
  });

  test("an index that is not whole yet waits: no toast and not marked done", async ($, on) => {
    const stored = new Map<string, unknown>([[ADOPTIONS_KEY, [due()]]]);
    const r = rig(on, stored);
    await seed(r.world);
    // A transcript inside the window that the scan has not read.
    const late = `${CFG}/projects/-work-late/s-9.jsonl`;
    r.world.put(late, "{}\n");
    r.world.setMtime(late, ago(1));
    r.unreadable.add(late);
    await start($);
    await afterStart(r);
    expect(r.toasts).toEqual([]);
    expect(stored.get(CHECKED_KEY)).toBeUndefined();
  });

  test("a project whose only transcript is older than 30 days counts as read: the recheck runs", async ($, on) => {
    const stored = new Map<string, unknown>([[ADOPTIONS_KEY, [due()]]]);
    const r = rig(on, stored);
    await seed(r.world);
    const old = `${CFG}/projects/-work-old/s-8.jsonl`;
    r.world.put(old, "");
    r.world.setMtime(old, ago(40));
    await start($);
    await afterStart(r);
    expect(r.toasts.length).toBe(1);
    expect(stored.get(CHECKED_KEY)).toEqual([adoptionId(due())]);
  });

  test("a stored adoption of a rule that no longer exists is ignored without a toast or a crash", async ($, on) => {
    const stored = new Map<string, unknown>([[ADOPTIONS_KEY, [{ rule: "repeat-compaction", at: NOW - 60 * DAY, expectedUsd: 3, metricName: "x", before: 1 }, due()]]]);
    const r = rig(on, stored);
    await seed(r.world);
    await start($);
    await afterStart(r);
    // The removed rule is skipped; the other due adoption is still rechecked.
    expect(r.toasts).toEqual(["tally: fast-mode: expected save $4.00, actual $2.00"]);
    expect(stored.get(CHECKED_KEY)).toEqual([adoptionId(due())]);
  });

  test("one day short of due, or a rule with no metric: nothing", async ($, on) => {
    const stored = new Map<string, unknown>([[ADOPTIONS_KEY, [due({ at: NOW - 13 * DAY }), { rule: "long-session", at: NOW - 60 * DAY, expectedUsd: 3 }]]]);
    const r = rig(on, stored);
    await seed(r.world);
    await start($);
    await afterStart(r);
    expect(r.toasts).toEqual([]);
    expect(stored.get(CHECKED_KEY)).toBeUndefined();
  });
});
