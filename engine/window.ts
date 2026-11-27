// The window's state and what its buttons, keys, command and events do: open, fold, switch tab and span, keep the
// foot's figures, and warn once when a limit runs low. Every state read and write sits here, beside its atom.
import { atom, read, update } from "claude-code";
import type { EngineInterface, SessionMeasureInput, SessionUsage } from "claude-code";
import type { TabId } from "../core/args.ts";
import { costOf } from "../core/pricing.ts";
import { BUILTIN_PRICES } from "../core/prices.builtin.ts";
import { stepRow } from "../core/live-state.ts";
import { summarizeAsync } from "../core/summary.ts";
import { HOUR_MS, hourStart } from "../core/time.ts";
import type { Span } from "../core/summary.ts";
import { DEFAULT_SETTINGS } from "../core/settings.ts";
import type { Settings } from "../core/settings.ts";
import type { Shard } from "../core/shard.ts";
import { OPEN_COLUMNS, OPEN_ROWS } from "../view/layout.ts";
import { TABS } from "../view/keys.ts";
import { EMPTY_CHART, EMPTY_FOOT, limitName, untilText } from "../view/data.ts";
import type { Chart, Foot, Limit } from "../view/data.ts";
import { locate } from "./locate.ts";
import { loadProject } from "./project-store.ts";
import { listProjects } from "./scanner.ts";
import { makeSlicer } from "./slicer.ts";

// The options the module runs with, set by `register` and again when a /tally command changes one.
let current: Settings = DEFAULT_SETTINGS;
export function useSettings(settings: Settings): void {
  current = settings;
}

export const PANE_ID = "tally";
export const PANE_TITLE = "tally";
export const COMMAND = "tally";
/** `$.store` keys that keep what the person last chose, across sessions. */
export const SPAN_KEY = "span";
export const TAB_KEY = "tab";
export const MODE_KEY = "mode";
/** Used share above which a rate-limit window raises its once-per-session toast. */
export const LIMIT_PERCENT = 80;
/** The 8-hour chart is rebuilt from the index at most this often. */
export const CHART_INTERVAL_MS = 300_000;

export type ViewState = {
  mode: "closed" | "open" | "folded";
  tab: TabId;
  span: Span;
  /** Hints and History: only the repo of this session. */
  repoOnly: boolean;
  /** With a sync folder: this machine's totals only, or every machine's. */
  machines: "this" | "all";
  /** The person has sent a message this session. */
  hasSent: boolean;
  hasWarned: boolean;
  /** The inline fullscreen tip is shown until the person first acts on the window. */
  hasTipped: boolean;
};

export const INITIAL_VIEW: ViewState = { mode: "closed", tab: "session", span: "session", repoOnly: false, machines: "this", hasSent: false, hasWarned: false, hasTipped: false };

const viewAtom = atom({ plugin: "tally", key: "view" } as const, INITIAL_VIEW, { shape: "view-1" });
const footAtom = atom({ plugin: "tally", key: "foot" } as const, EMPTY_FOOT, { shape: "foot-1" });
const chartAtom = atom({ plugin: "tally", key: "chart" } as const, EMPTY_CHART, { shape: "chart-1" });

export function readView($: EngineInterface): Promise<ViewState> {
  return read($, viewAtom);
}
export function changeView($: EngineInterface, change: (v: ViewState) => ViewState): Promise<ViewState> {
  return update($, viewAtom, change);
}
export function readFoot($: EngineInterface): Promise<Foot> {
  return read($, footAtom);
}
export function changeFoot($: EngineInterface, change: (f: Foot) => Foot): Promise<Foot> {
  return update($, footAtom, change);
}
export function readChart($: EngineInterface): Promise<Chart> {
  return read($, chartAtom);
}
export function setChart($: EngineInterface, chart: Chart): Promise<Chart> {
  return update($, chartAtom, () => chart);
}

const isTab = (v: unknown): v is TabId => typeof v === "string" && TABS.some((t) => t.tab === v);
const isSpan = (v: unknown): v is Span => v === "session" || v === "24h" || v === "30d";

// Window work that may be slow runs off the caller's path; a failure goes to the debug log, never to the caller.
export function inBackground($: EngineInterface, work: () => Promise<unknown>): void {
  $.clock.after(0, () => attempt($, work));
}

/** Runs `work` now without awaiting it; a rejection goes to the debug log, so a button press never leaves one unhandled. */
export function attempt($: EngineInterface, work: () => Promise<unknown>): void {
  work().catch((err: unknown) => {
    try {
      $.ui.log(`tally: ${err instanceof Error ? err.message : String(err)}`, { to: "debug" });
    } catch {
      /* nothing to log to */
    }
  });
}

function redraw($: EngineInterface): void {
  try {
    $.ui.invalidate("ui.render");
  } catch {
    /* no surface to redraw */
  }
}

/** The tab and span the person last chose, back from `$.store`. */
export async function restoreChoices($: EngineInterface): Promise<void> {
  const tab = await $.store.get(TAB_KEY);
  const span = await $.store.get(SPAN_KEY);
  await changeView($, (v) => ({ ...v, ...(isTab(tab) && { tab }), ...(isSpan(span) && { span }) }));
}

/** True when the person has opened or folded the window by hand, this session or an earlier one. */
export async function isModeKept($: EngineInterface): Promise<boolean> {
  const mode = await $.store.get(MODE_KEY);
  return mode === "open" || mode === "folded";
}

export type OpenOpts = {
  /** The person asked (the command, the line, `details`): the window takes the keys and opens at any width. */
  asked?: boolean;
  tab?: TabId;
  span?: Span;
};

/**
 * Opens the window, dock size 90x40; the `never` option keeps it shut unless asked. Unasked (at session start) the engine holds a pane back under 144 terminal
 * columns; held back, the window starts folded to its line instead. Asked, it is placed at any width: docked from
 * 110 columns on a fullscreen terminal, inline below that.
 */
export async function openWindow($: EngineInterface, settings: Settings, o: OpenOpts = {}): Promise<void> {
  // `never` opens only when asked.
  if (settings.open === "never" && o.asked !== true) return;
  // No await may come before the open: the engine links it to the press or command behind it only until the
  // first await, and an open after that counts as unasked.
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, closeOnEscape: true, columns: OPEN_COLUMNS, rows: OPEN_ROWS, ...(o.asked === true && { focus: true as const }) });
  // Not placed means held back (a narrow terminal, or surfaces that place nothing) except `no-surface`: the pane stays open for a surface that attaches later.
  if (!opened.isPlaced && !opened.reason.startsWith("no-surface")) {
    // The mode first, so the `ui.close` hook knows the close is ours.
    await changeView($, (v) => ({ ...v, mode: "folded" }));
    await $.ui.close({ id: PANE_ID });
    return;
  }
  await changeView($, (v) => ({ ...v, mode: "open", ...(o.tab !== undefined && { tab: o.tab }), ...(o.span !== undefined && { span: o.span }) }));
  if (o.tab !== undefined) await $.store.set(TAB_KEY, o.tab);
  if (o.span !== undefined) await $.store.set(SPAN_KEY, o.span);
  // The person's open is kept: the next session opens it again.
  if (o.asked === true) await $.store.set(MODE_KEY, "open");
}

/** Folds the window to its line above the prompt; the mode is set first so the `ui.close` hook lets it pass. */
export async function foldWindow($: EngineInterface): Promise<void> {
  await changeView($, (v) => ({ ...v, mode: "folded", hasTipped: true }));
  await $.ui.close({ id: PANE_ID });
}

/** The person's Esc or close mark: fold, and start folded next session. */
export async function keepFolded($: EngineInterface): Promise<void> {
  await changeView($, (v) => ({ ...v, mode: "folded", hasTipped: true }));
  await $.store.set(MODE_KEY, "folded");
}

/**
 * Session start: the tab and span from last time, then the window open or folded as the person left it, else
 * open. A session with no person, or the `never` option, leaves it shut.
 */
export async function restoreWindow($: EngineInterface, settings: Settings, isInteractive: boolean): Promise<void> {
  await restoreChoices($);
  if (!isInteractive || settings.open === "never") return;
  if ((await $.store.get(MODE_KEY)) === "folded") {
    await changeView($, (v) => ({ ...v, mode: "folded" }));
    return;
  }
  await openWindow($, settings);
}
/**
 * After a /clear (a new session id, no `session.start`) the view starts over: the tab and span from the store, then
 * folded when the person left it folded or the pane is down, open when the pane is still up (never: shut). Opens nothing itself.
 */
export async function reseatView($: EngineInterface): Promise<void> {
  await restoreChoices($);
  if ((await $.store.get(MODE_KEY)) === "folded") {
    await changeView($, (v) => ({ ...v, mode: "folded" }));
    return;
  }
  if (current.open === "never") return;
  const panes = await $.ui.panes().catch(() => []);
  const isUp = panes.some((p) => p.id === PANE_ID && p.isPlaced);
  await changeView($, (v) => ({ ...v, mode: isUp ? "open" : "folded" }));
}


export async function showTab($: EngineInterface, tab: TabId): Promise<void> {
  await changeView($, (v) => ({ ...v, tab, hasTipped: true }));
  await $.store.set(TAB_KEY, tab);
}

export async function setSpan($: EngineInterface, span: Span): Promise<void> {
  await changeView($, (v) => ({ ...v, span }));
  await $.store.set(SPAN_KEY, span);
}

export async function setRepoOnly($: EngineInterface, repoOnly: boolean): Promise<void> {
  await changeView($, (v) => ({ ...v, repoOnly }));
}

export async function setMachines($: EngineInterface, machines: "this" | "all"): Promise<void> {
  await changeView($, (v) => ({ ...v, machines }));
}

// Prompts the engine sends on its own, which do not count as the person's first message.
const ENGINE_ORIGINS: ReadonlySet<string> = new Set(["task-notification", "peer", "scheduled-trigger"]);

/**
 * `before-first-message`: the person's first message folds the window to its line, unless they opened or folded
 * it themselves before.
 */
export async function onPrompt($: EngineInterface, e: { command?: string; isMeta?: boolean; origin: { kind: string } }): Promise<void> {
  if (e.command !== undefined || e.isMeta === true || ENGINE_ORIGINS.has(e.origin.kind)) return;
  const before = await readView($);
  if (before.hasSent) return;
  await changeView($, (v) => ({ ...v, hasSent: true }));
  if (current.open === "before-first-message" && before.mode === "open" && !(await isModeKept($))) await foldWindow($);
}

const limitsOf = (usage: Pick<SessionUsage, "rateLimits">): Limit[] =>
  usage.rateLimits.map((l) => ({ kind: l.kind, percentUsed: l.percentUsed, ...(l.resetsAt !== undefined && { resetsAt: l.resetsAt }) }));

// What writing the whole context to the cache again would cost on the main model, at the cache life main last showed.
async function refillOf($: EngineInterface, tokens: number | null, ttl: "5m" | "1h"): Promise<number | null> {
  if (tokens === null || tokens <= 0) return null;
  try {
    const model = await $.session.model();
    const row = stepRow("", 0, undefined, model, { input: 0, output: 0, cacheRead: 0, cw5m: ttl === "5m" ? tokens : 0, cw1h: ttl === "1h" ? tokens : 0 });
    const c = costOf(row, BUILTIN_PRICES);
    return c.priced ? c.usd : null;
  } catch {
    return null;
  }
}

// One toast per session once a window passes LIMIT_PERCENT used. The flag is the view's, so /clear starts it over.
let toasting = false;
async function warnNearLimit($: EngineInterface, limits: Limit[]): Promise<void> {
  const near = limits.find((l) => l.percentUsed > LIMIT_PERCENT);
  if (near === undefined || toasting) return;
  toasting = true;
  try {
    if ((await readView($)).hasWarned) return;
    await changeView($, (v) => ({ ...v, hasWarned: true }));
    const reset = untilText(near.resetsAt, await $.clock.now());
    $.ui.toast(`tally: your ${limitName(near.kind, false)} limit is ${Math.round(near.percentUsed)}% used${reset === null || reset === "now" ? "" : ` (resets in ${reset})`}.`);
  } finally {
    toasting = false;
  }
}

/** Keeps the foot's context and limits from `usage` (the engine's reading), and the toast. */
export async function noteUsage($: EngineInterface, usage: Pick<SessionUsage, "context" | "rateLimits">, ttl: "5m" | "1h"): Promise<void> {
  const tokens = usage.context.tokens ?? null;
  const limits = limitsOf(usage);
  const refillUsd = await refillOf($, tokens, ttl);
  await changeFoot($, (f) => ({ ...f, contextTokens: tokens, contextWindow: usage.context.window, limits, refillUsd }));
  await warnNearLimit($, limits);
}

export function onMeasure($: EngineInterface, e: SessionMeasureInput, ttl: "5m" | "1h"): Promise<void> {
  return noteUsage($, e, ttl);
}

/** Reads the engine's figures now: context, limits, and where auto-compact starts (the summary breakdown, local and quick). */
export async function refreshFoot($: EngineInterface, ttl: "5m" | "1h"): Promise<void> {
  await noteUsage($, await $.session.usage(), ttl);
  const compact = (await $.session.usage({ breakdown: "summary" })).context.breakdown?.autoCompactThreshold ?? null;
  await changeFoot($, (f) => ({ ...f, compactAt: compact }));
}

let chartAt = 0;

const tokenSum = (t: { input: number; output: number; cacheRead: number; cw5m: number; cw1h: number }): number => t.input + t.output + t.cacheRead + t.cw5m + t.cw1h;

/** The last 8 hours of every project's tokens, from the index; at most once per CHART_INTERVAL_MS unless `force`. */
export async function refreshChart($: EngineInterface, force = false): Promise<void> {
  const now = await $.clock.now();
  if (!force && chartAt !== 0 && now - chartAt < CHART_INTERVAL_MS) return;
  chartAt = now;
  const loc = await locate($);
  // The summary reads the 24 hours up to now (its bands rank those hours), which touch at most two UTC day buckets.
  const from = hourStart(now) - 23 * HOUR_MS;
  const slicer = makeSlicer($);
  const tick = () => slicer.check();
  const shards: Shard[] = [];
  for (const project of await listProjects($, loc.roots)) {
    await tick();
    const shard = await loadProject($, loc.cfg, project, now, tick, from);
    if (shard) shards.push(shard);
  }
  const s = await summarizeAsync(shards, BUILTIN_PRICES, { span: "24h", nowMs: now, tzOffsetMin: -new Date(now).getTimezoneOffset() }, tick);
  await setChart($, { values: s.timeline.points.slice(-8).map((p) => tokenSum(p.tokens)), bands: s.hourBands });
  redraw($);
}

/** Session start: the foot's figures and the chart, off the caller's path. */
export function startFeeds($: EngineInterface, ttl: "5m" | "1h"): void {
  inBackground($, () => refreshFoot($, ttl));
  inBackground($, () => refreshChart($, true));
}

/** After a main turn: the foot again, the chart when it is due, and a redraw. */
export async function onTurnEnd($: EngineInterface, ttl: "5m" | "1h"): Promise<void> {
  await refreshFoot($, ttl);
  await refreshChart($);
  redraw($);
}

export { redraw as invalidateWindow };

export type SettingsResult = { said: string[]; applied: Partial<Settings>; error?: string };

/**
 * Persists settings the way the /config menu does (`$.config.set`, which reloads the module with the new options).
 * Stops at the first one refused and says why; those before it stand.
 */
export async function applySettings($: EngineInterface, set: Partial<Settings>): Promise<SettingsResult> {
  const out: SettingsResult = { said: [], applied: {} };
  const rows = await $.config.list();
  for (const [field, value] of Object.entries(set)) {
    const row = rows.find((r) => r.key.endsWith(`.${field}`) && r.key.split(".")[0]?.split("@")[0] === "tally");
    if (row === undefined) {
      out.error = `no ${field} option to set.`;
      return out;
    }
    let result: Awaited<ReturnType<typeof $.config.set>>;
    try {
      result = await $.config.set({ key: row.key, value: value as boolean | string | number });
    } catch {
      out.error = `${field} not changed: run /tally ${field} again.`;
      return out;
    }
    if (result.deny !== undefined) {
      out.error = `${field} not changed: ${result.deny}`;
      return out;
    }
    (out.applied as Record<string, unknown>)[field] = value;
    out.said.push(`${field} set to ${String(value)}`);
  }
  return out;
}
