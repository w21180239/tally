import type { On, RenderInput } from "claude-code";
import type { Engine } from "claude-code/testing";
import { describe, expect, mock, test } from "claude-code/testing";
import { DEFAULT_SETTINGS, SETTING_KEYS } from "../core/settings.ts";
import type { Settings } from "../core/settings.ts";
import type { PriceTable } from "../core/pricing.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import type { Shard } from "../core/shard.ts";
import type { UsageRow } from "../core/types.ts";
import { EMPTY_HELP, HELP_INTERVAL_MS, HELP_RETRY_MS, needsHelp } from "../engine/help-view.ts";
import type { HelpData } from "../engine/help-view.ts";
import { currentPrices, maybeUpdatePrices, PRICE_ERROR_KEY, PRICES_KEY, PRICING_URL } from "../engine/price-update.ts";
import { dayIdx, saveBuckets } from "../engine/project-store.ts";
import { tableOf } from "../view/table.ts";
import { drawHelp } from "../view/tabs/help.tsx";
import { formatMoney } from "../core/money.ts";
import { prompt, req } from "./fixtures/rows.ts";
import { PRICING_MD } from "./fixtures/pricing-sample.ts";
import { posixPath, worldOf } from "./world.ts";
import type { World } from "./world.ts";

const PLUGIN = "tally";
const NOW = Date.UTC(2026, 10, 27, 12);
const CWD = "/work/demo";
const CFG = "/home/u/.claude";

const PANE: Omit<RenderInput<"Pane">, "surface"> = {
  component: "Pane",
  requestId: PLUGIN,
  viewport: { columns: 200, rows: 120, isFullscreen: true },
  props: { title: "tally", isFocused: true, bodyColumns: 120, placement: "dock", scroll: { offset: 0, bodyRows: 240 }, view: {} },
};
const TEXT = (re: RegExp) => ({ type: "Text" as const, text: re });
const exact = (s: string): RegExp => new RegExp(`^${s.replace(/[$.*+?^${}()|[\]\\]/g, "\\$&")}$`);

type Net = { calls: string[]; reply: () => { status: number; ok: boolean; text: string } };
type Rig = { world: World; clock: ReturnType<typeof mock.clock>; stored: Map<string, unknown>; net: Net; live: () => { main: { usd: number } } | undefined };

function rig(on: On, o: { stored?: Record<string, unknown>; version?: string | null } = {}): Rig {
  const world = worldOf();
  const stored = new Map<string, unknown>(Object.entries(o.stored ?? {}));
  const net: Net = { calls: [], reply: () => { throw new Error("offline"); } };
  let cell: { main: { usd: number } } | undefined;
  const r: Rig = { world, clock: mock.clock(on, { now: NOW }), stored, net, live: () => cell };
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
  on("session.cwd", () => ({ value: CWD }));
  on("session.model", () => ({ value: "claude-opus-5-5" }));
  on("session.info", () => ({ value: { platform: "linux" } }));
  on("session.usage", () => ({ value: { startedAt: NOW, context: { tokens: 236_000, window: 1_000_000, percent: 24 }, rateLimits: [], cost: { usd: 0 } } as never }));
  // $.plugin.root is the real checkout, absent from the in-memory fs, so the manifest is served from here.
  on("fs.read", async (_, e) =>
    posixPath(e.path).endsWith("/.claude-plugin/plugin.json") && o.version !== null
      ? { value: JSON.stringify({ name: "tally", version: o.version ?? "9.8.7" }) }
      : { value: await world.$.fs.read(e.path, { as: e.as, offset: e.offset, length: e.length } as never) },
  );
  on("fs.write", async (_, e) => ({ value: await world.$.fs.write(e.path, e.text) }));
  on("fs.list", async (_, e) => ({ value: await world.$.fs.list(e.path) }));
  on("fs.exists", async (_, e) => ({ value: await world.$.fs.exists(e.path) }));
  on("fs.stat", async (_, e) => ({ value: await world.$.fs.stat(e.path) }));
  on("config.list", () => ({ value: [] }));
  on("http.fetch", (_, e) => {
    net.calls.push(e.url);
    return { value: { headers: {}, ...net.reply() } as never };
  });
  on("state.set", async (_, e, next) => {
    if (e.key === "live") cell = (e.value as { value: { main: { usd: number } } }).value;
    return next(e);
  });
  on("turn.complete", (_, e) => ({ text: e.answer }));
  on("prompt.submit", (_, e) => ({ text: e.text }));
  on("tool.call", () => ({ result: {}, text: "ok" }));
  on("turn.step", async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000, model: "claude-opus-5-5" } } as never;
  });
  return r;
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: "terminal", isInteractive: true });
const model = (row: UsageRow, id: string): UsageRow => ({ ...row, model: id });
const at = <T extends { ts: number }>(row: T, ts: number): T => ({ ...row, ts });

async function seed(w: World, usage: UsageRow[]): Promise<void> {
  const byDay = new Map<number, Shard>();
  for (const row of usage) {
    const d = dayIdx(row.ts);
    const sh = byDay.get(d) ?? { v: 1, project: "-work-demo", files: {}, usage: [], users: [], metas: [], compacts: [], snapshots: [] };
    sh.usage.push(row);
    sh.users.push(at(prompt(0, 100, "hi", row.sessionId), row.ts));
    byDay.set(d, sh);
  }
  await saveBuckets(w.$, CFG, "-work-demo", { days: byDay }, {}, NOW);
  w.put(`${CFG}/projects/-work-demo/s-1.jsonl`, "");
}

const asked = (id: string) => at(req({ id, at: 0, session: "s-1", cwd: CWD, tokens: { input: 1000, output: 500 } }), NOW - 3_600_000);

async function open($: Engine, r: Rig, usage: UsageRow[] = [asked("a")]) {
  await seed(r.world, usage);
  await start($);
  await r.clock.settle();
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
  await ui.press({ key: "tab-help" });
  await r.clock.settle();
  return ui;
}

describe("help tab: prices", () => {
  test("a builtin table says so with its date, and an unpriced model is listed by name", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r, [asked("a"), model(asked("b"), "gpt-4o")]);
    expect(await ui.find({ key: "body-help" })).toBeDefined();
    expect(await ui.find(TEXT(exact("Prices: built-in (2026-11-27)")))).toBeDefined();
    expect(await ui.find(TEXT(exact("gpt-4o")))).toBeDefined();
    expect(await ui.find(TEXT(/counted as \$0/))).toBeDefined();
    expect(await ui.find(TEXT(/^Prices: fetched/))).toBeUndefined();
    await ui.unmount();
  });

  test("with every model priced, no model is listed as unpriced", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    expect(await ui.find(TEXT(exact("gpt-4o")))).toBeUndefined();
    expect(await ui.find(TEXT(/counted as \$0/))).toBeUndefined();
    expect(await ui.find(TEXT(/^Every model in recent history has a price/))).toBeDefined();
    await ui.unmount();
  });

  test("a fetched table names the page it came from and the day it was fetched", async ($, on) => {
    const fetched: PriceTable = { ...BUILTIN_PRICES, source: "fetched", updatedAt: NOW - 2 * 86_400_000 };
    const r = rig(on, { stored: { [PRICES_KEY]: fetched } });
    const ui = await open($, r);
    expect(await ui.find(TEXT(exact("Prices: fetched 2026-11-25 from platform.claude.com/docs/en/about-claude/pricing.md")))).toBeDefined();
    expect(await ui.find(TEXT(/^Prices: built-in/))).toBeUndefined();
    await ui.unmount();
  });

  test("the last failed update is shown with its day; a good state shows none", async ($, on) => {
    const bad = rig(on, { stored: { [PRICE_ERROR_KEY]: { at: NOW - 3_600_000, message: "price page answered HTTP 503" } } });
    const ui = await open($, bad);
    expect(await ui.find(TEXT(exact("Last price update failed (2026-11-27): price page answered HTTP 503")))).toBeDefined();
    await ui.unmount();
  });

  test("no failure is shown when none is stored", async ($, on) => {
    const r = rig(on, { stored: { [PRICES_KEY]: { ...BUILTIN_PRICES, source: "fetched", updatedAt: NOW } } });
    const ui = await open($, r);
    expect(await ui.find(TEXT(/^Last price update failed/))).toBeUndefined();
    await ui.unmount();
  });
});

describe("help tab: reference", () => {
  test("the version comes from plugin.json under the plugin's directory", async ($, on) => {
    const r = rig(on, { version: "9.8.7" });
    const ui = await open($, r);
    expect(await ui.find(TEXT(exact("tally 9.8.7")))).toBeDefined();
    await ui.unmount();
  });

  test("an unreadable plugin.json leaves the version unknown and the rest of the tab drawn", async ($, on) => {
    const r = rig(on, { version: null });
    const ui = await open($, r);
    expect(await ui.find(TEXT(exact("tally (version unknown)")))).toBeDefined();
    expect(await ui.find(TEXT(exact("Settings")))).toBeDefined();
    await ui.unmount();
  });

  test("all five reference blocks are drawn, with one row for each setting", async ($, on) => {
    const r = rig(on);
    const ui = await open($, r);
    for (const head of ["Data sources", "Colours", "Keys", "Settings", "Prices", "Version"]) expect(await ui.find(TEXT(exact(head)))).toBeDefined();
    expect(await ui.find(TEXT(/transcripts.*never writes/i))).toBeDefined();
    expect(await ui.find(TEXT(exact("green")))).toBeDefined();
    expect(await ui.find(TEXT(exact("amber")))).toBeDefined();
    expect(await ui.find(TEXT(exact("red")))).toBeDefined();
    expect(await ui.find(TEXT(/^0-5/))).toBeDefined();
    for (const key of SETTING_KEYS) expect((await ui.findAll(TEXT(exact(key)))).length).toBe(1);
    expect(SETTING_KEYS.length).toBe(11);
    await ui.unmount();
  });
});

// The tab's drawing alone, over data and settings the test hands it.
const READY: HelpData = { ...EMPTY_HELP, at: NOW, version: "1.2.3", unpriced: [], unread: 0, ready: true };
function helpHost(on: On, o: { settings?: Partial<Settings>; data?: Partial<HelpData>; prices?: PriceTable }): void {
  on("ui.render", { component: "Pane", requestId: "help-host" }, ($, e) => {
    const t = tableOf($, e as RenderInput<"Pane">);
    const { Box } = t;
    const drawn = drawHelp(t, { settings: { ...DEFAULT_SETTINGS, ...o.settings }, prices: o.prices ?? BUILTIN_PRICES, data: { ...READY, ...o.data } });
    return (<Box key="host" flexDirection="column">{drawn.rows}</Box>) as never;
  });
}
const mountHost = ($: Engine) => $.ui.mount({ plugin: "help-host", surface: "terminal", ...PANE, requestId: "help-host" });

describe("help drawing", () => {
  test("a setting shows its current value", async ($, on) => {
    helpHost(on, { settings: { money: "dollars", priceUpdate: false, recheckDays: 30, syncDir: "/s" } });
    const ui = await mountHost($);
    expect(await ui.find(TEXT(exact("dollars")))).toBeDefined();
    // Of the four on/off settings, priceUpdate turned off joins redactEvidence and herdrSidebar.
    expect((await ui.findAll(TEXT(exact("off")))).length).toBe(3);
    expect((await ui.findAll(TEXT(exact("on")))).length).toBe(1);
    expect(await ui.find(TEXT(exact("30")))).toBeDefined();
    expect(await ui.find(TEXT(exact("/s")))).toBeDefined();
    expect(await ui.find(TEXT(exact("cents-and-dollars")))).toBeUndefined();
    await ui.unmount();
  });

  test("an empty text setting reads as unset", async ($, on) => {
    helpHost(on, {});
    const ui = await mountHost($);
    expect((await ui.findAll(TEXT(exact("(unset)")))).length).toBe(2);
    await ui.unmount();
  });

  test("online update off: the prices block notes it", async ($, on) => {
    helpHost(on, { settings: { priceUpdate: false } });
    const ui = await mountHost($);
    expect(await ui.find(TEXT(/^Online update is off/))).toBeDefined();
    await ui.unmount();
  });

  test("with the online update on, that note is absent", async ($, on) => {
    helpHost(on, {});
    const ui = await mountHost($);
    expect(await ui.find(TEXT(/^Online update is off/))).toBeUndefined();
    await ui.unmount();
  });

  test("before the first build it says it is looking, and a failed build says why", async ($, on) => {
    helpHost(on, { data: { ready: false, version: "" } });
    const ui = await mountHost($);
    expect(await ui.find(TEXT(/^Looking for models without a price/))).toBeDefined();
    await ui.unmount();
  });

  test("a build failure is shown instead of the list", async ($, on) => {
    helpHost(on, { data: { ready: false, failure: { why: "disk gone", at: NOW } } });
    const ui = await mountHost($);
    expect(await ui.find(TEXT(exact("Could not list unpriced models: disk gone")))).toBeDefined();
    expect(await ui.find(TEXT(/^Looking for models/))).toBeUndefined();
    await ui.unmount();
  });

  test("a long unpriced list is cut with a count of the rest", async ($, on) => {
    const many = Array.from({ length: 15 }, (_, i) => `model-${String(i).padStart(2, "0")}`);
    helpHost(on, { data: { unpriced: many } });
    const ui = await mountHost($);
    expect(await ui.find(TEXT(exact("model-09")))).toBeDefined();
    expect(await ui.find(TEXT(exact("model-10")))).toBeUndefined();
    expect(await ui.find(TEXT(exact("5 more")))).toBeDefined();
    await ui.unmount();
  });

  test("unread projects are noted, since their models are not known", async ($, on) => {
    helpHost(on, { data: { unread: 2 } });
    const ui = await mountHost($);
    expect(await ui.find(TEXT(exact("2 projects are not indexed yet; their models are not listed.")))).toBeDefined();
    await ui.unmount();
  });
});

describe("help refresh rules", () => {
  const key = { at: NOW, ready: true };
  test("a first look is due, a fresh one is not, an old one is", () => {
    expect(needsHelp(EMPTY_HELP, NOW)).toBe(true);
    expect(needsHelp({ ...EMPTY_HELP, ...key }, NOW + HELP_INTERVAL_MS - 1)).toBe(false);
    expect(needsHelp({ ...EMPTY_HELP, ...key }, NOW + HELP_INTERVAL_MS)).toBe(true);
  });

  test("after a failed build the retry gap must pass before the next attempt", () => {
    const failed = { ...EMPTY_HELP, failure: { why: "x", at: NOW } };
    expect(needsHelp(failed, NOW + HELP_RETRY_MS - 1)).toBe(false);
    expect(needsHelp(failed, NOW + HELP_RETRY_MS)).toBe(true);
  });
});

// Twice the builtin rates, every class.
const doubled = (t: PriceTable): PriceTable => ({
  ...t,
  models: Object.fromEntries(Object.entries(t.models).map(([id, m]) => [id, { ...m, input: m.input * 2, output: m.output * 2, cacheRead: m.cacheRead * 2, cw5m: m.cw5m * 2, cw1h: m.cw1h * 2 }])),
});
const STEP_USD = (1000 * 4 + 100_000 * 0.2 + 10_000 * 8 + 500 * 20) / 1e6;
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
const FETCHED = (): PriceTable => ({ ...doubled(BUILTIN_PRICES), source: "fetched", updatedAt: NOW });

async function oneStep($: Engine): Promise<void> {
  const stream = $.turn.step({ turnId: "t1", index: 0, model: "claude-opus-5-5", messageCount: 2 } as never);
  for await (const chunk of stream) void chunk;
  await stream.result;
}

describe("price table in effect", () => {
  const withStore = (entries: Record<string, unknown>) => worldOf(entries).$;
  const price = (input: number) => ({ input, output: input * 5, cacheRead: input / 10, cw5m: input * 1.25, cw1h: input * 2 });

  test("no stored table: the builtin one", async () => {
    expect(await currentPrices(withStore({}))).toEqual(BUILTIN_PRICES);
  });

  test("a stored table is joined with the builtin: its own models and the builtin's the stored one lacks", async () => {
    const stored: PriceTable = { source: "fetched", updatedAt: NOW, fastMul: 2, models: { "claude-opus-3": price(15), "claude-opus-5-5": price(99) } };
    const t = await currentPrices(withStore({ [PRICES_KEY]: stored }));
    expect(t.source).toBe("fetched");
    expect(t.updatedAt).toBe(NOW);
    expect(t.models["claude-opus-3"]).toEqual(price(15));
    expect(t.models["claude-opus-5-5"]).toEqual(price(99));
    expect(t.models["claude-haiku-4-5"]).toEqual(BUILTIN_PRICES.models["claude-haiku-4-5"]);
  });

  test("a fresh fetch wins over the stored and builtin prices and keeps the models the page dropped", async () => {
    const old: PriceTable = { source: "fetched", updatedAt: NOW - 30 * 86_400_000, fastMul: 2, models: { "claude-opus-3": price(15), "claude-opus-5-5": price(99) } };
    const w = worldOf({ [PRICES_KEY]: old });
    const $ = { ...w.$, http: { fetch: async () => ({ status: 200, ok: true, text: PRICING_MD }) } };
    const t = await maybeUpdatePrices($, { priceUpdate: true });
    expect(t.models["claude-opus-5-5"]).toEqual(BUILTIN_PRICES.models["claude-opus-5-5"]);
    expect(t.models["claude-opus-3"]).toEqual(price(15));
    expect(Object.keys(t.models).length).toBe(Object.keys(BUILTIN_PRICES.models).length + 1);
    expect(w.stored.get(PRICES_KEY)).toEqual(t);
  });

  test("the sanity check counts the fresh table alone: the older models do not rescue a thin page", async () => {
    const many: PriceTable = { ...BUILTIN_PRICES, source: "fetched", updatedAt: NOW - 30 * 86_400_000, models: { ...BUILTIN_PRICES.models, ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`claude-opus-old-${i}`, price(15)])) } };
    const w = worldOf({ [PRICES_KEY]: many });
    // Every second model row is gone from the page: under 80% of the shipped models is refused, whatever else is stored.
    let n = 0;
    const thin = PRICING_MD.split("\n").filter((l) => !/^\| Claude (?!Haiku 5\.5)[^|]*(\|[^|]*){5}\|\s*$/.test(l) || ++n % 2 === 1).join("\n");
    const $ = { ...w.$, http: { fetch: async () => ({ status: 200, ok: true, text: thin }) } };
    const t = await maybeUpdatePrices($, { priceUpdate: true });
    expect(t.updatedAt).toBe(many.updatedAt);
    expect(Object.keys(t.models).length).toBe(Object.keys(many.models).length);
    expect(w.stored.get(PRICES_KEY)).toEqual(many);
    expect((w.stored.get(PRICE_ERROR_KEY) as { message: string }).message).toMatch(/sanity check/);
  });
});

describe("price update wiring", () => {
  test("session.start returns before any fetch; the fetch runs after, once, and stores the table", async ($, on) => {
    const r = rig(on);
    r.net.reply = () => ({ status: 200, ok: true, text: PRICING_MD });
    await start($);
    expect(r.net.calls).toEqual([]);
    await r.clock.settle();
    expect(r.net.calls).toEqual([PRICING_URL]);
    expect((r.stored.get(PRICES_KEY) as PriceTable).source).toBe("fetched");
  });

  test("priceUpdate off: no fetch ever", { options: { priceUpdate: false } }, async ($, on) => {
    const r = rig(on);
    r.net.reply = () => ({ status: 200, ok: true, text: PRICING_MD });
    await start($);
    await r.clock.settle();
    expect(r.net.calls).toEqual([]);
    expect(r.stored.has(PRICES_KEY)).toBe(false);
  });

  test("a failing fetch never fails the start and leaves the error for Help", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    expect(r.net.calls.length).toBe(1);
    expect((r.stored.get(PRICE_ERROR_KEY) as { message: string }).message).toMatch(/price fetch failed/);
  });

  test("the live tally prices a step at the stored table", async ($, on) => {
    const r = rig(on, { stored: { [PRICES_KEY]: FETCHED() } });
    await start($);
    await r.clock.settle();
    await oneStep($);
    expect(near(r.live()!.main.usd, 2 * STEP_USD)).toBe(true);
  });

  test("without a stored table the live tally uses the builtin prices", async ($, on) => {
    const r = rig(on);
    await start($);
    await r.clock.settle();
    await oneStep($);
    expect(near(r.live()!.main.usd, STEP_USD)).toBe(true);
  });

  test("the Usage tab prices the index at the stored table", async ($, on) => {
    const row = asked("a");
    const unit = (1000 * 4 + 500 * 20) / 1e6;
    const r = rig(on, { stored: { [PRICES_KEY]: FETCHED() } });
    await seed(r.world, [row]);
    await start($);
    await r.clock.settle();
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: "terminal", ...PANE });
    await ui.press({ key: "tab-usage" });
    await r.clock.settle();
    const money = (usd: number) => exact(formatMoney(usd, DEFAULT_SETTINGS.money, DEFAULT_SETTINGS.decimals));
    expect((await ui.findAll(TEXT(money(2 * unit)))).length).toBeGreaterThan(0);
    expect((await ui.findAll(TEXT(money(unit)))).length).toBe(0);
    await ui.unmount();
  });
});
