// What the Hints tab reads: the rules' findings for the live session and for the selected span (all repos or the
// live session's repository), built off the draw path. The tab draws what the atom last held and asks for a rebuild when it is
// stale. A project with no usable index counts as unread, never as empty.
import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";
import { nearestSnapshot } from "../core/breakdown.ts";
import type { BreakdownSnapshot } from "../core/breakdown.ts";
import { HINT_RULES, runRules } from "../core/hint.ts";
import type { Hint, HintInput, RuleLimits } from "../core/hint.ts";
import type { LiveState } from "../core/live-state.ts";
import { repoOf } from "../core/path.ts";
import { projectNameOf } from "../core/plan-scan.ts";
import { pluginsFrom } from "../core/plugins.ts";
import type { PluginInventory } from "../core/plugins.ts";
import type { PriceTable } from "../core/pricing.ts";
import type { Shard } from "../core/shard.ts";
import { summarizeAsync, UNKNOWN_REPO } from "../core/summary.ts";
import type { Span, Summary } from "../core/summary.ts";
import { LAST_LIMITS_KEY, readLive } from "./live.ts";
import { locate } from "./locate.ts";
import { readInventory } from "./plugins.ts";
import { currentPrices } from "./price-update.ts";
import { loadProject } from "./project-store.ts";
import { listProjects } from "./scanner.ts";
import { makeSlicer } from "./slicer.ts";
import { loadSnapshots } from "./snapshot.ts";
import { invalidateWindow, readFoot } from "./window.ts";

/** Findings older than this are rebuilt at the next draw of the tab. */
export const HINTS_INTERVAL_MS = 120_000;
/** A failed build is not retried sooner than this. */
export const HINTS_RETRY_MS = 30_000;
const FAILURE_CHARS = 80;

export type HintsData = {
  /** What the findings are of: `<span>|<all or repo>|<session id>`. */
  key: string;
  at: number;
  /** The repository the findings are limited to, else empty. */
  repo: string;
  /** Requests in the span; none, with projects unread, means unknown rather than empty. */
  requests: number;
  unread: number;
  session: Hint[];
  span: Hint[];
  /** Set when the last build for `key` failed and none has worked since; the tab shows it instead of waiting. */
  failure?: { key: string; why: string; at: number };
};

export const EMPTY_HINTS: HintsData = { key: "", at: 0, repo: "", requests: 0, unread: 0, session: [], span: [] };

const hintsAtom = atom({ plugin: "tally", key: "hints" } as const, EMPTY_HINTS, { shape: "hints-1" });

export function readHints($: EngineInterface): Promise<HintsData> {
  return read($, hintsAtom);
}

export type HintsWant = { span: Span; repoOnly: boolean; sessionId: string };

export const hintsKeyOf = (w: HintsWant): string => `${w.span}|${w.repoOnly ? "repo" : "all"}|${w.sessionId}`;

/** True when the tab should ask for findings: none of this key yet, or older than their interval; a failed key waits. */
export function needsHints(data: Pick<HintsData, "key" | "at" | "failure">, want: HintsWant, now: number): boolean {
  const key = hintsKeyOf(want);
  if (data.failure?.key === key && now - data.failure.at < HINTS_RETRY_MS) return false;
  return data.key !== key || now - data.at >= HINTS_INTERVAL_MS;
}

let running: Promise<void> | undefined;

/** The last rate limits tally saw, as the rules read them: windows without a percent are dropped, and a reset time that is absent or unparsable stays unset. */
export function limitsFrom(stored: unknown): RuleLimits | undefined {
  const list = (stored as { limits?: unknown } | null | undefined)?.limits;
  if (!Array.isArray(list)) return undefined;
  const out: RuleLimits = {};
  for (const l of list as Array<{ kind?: unknown; percentUsed?: unknown; resetsAt?: unknown }>) {
    if (typeof l?.percentUsed !== "number" || !Number.isFinite(l.percentUsed)) continue;
    const parsed = typeof l.resetsAt === "string" ? Date.parse(l.resetsAt) : NaN;
    const window = { percentUsed: l.percentUsed, ...(Number.isFinite(parsed) && { resetsAt: parsed }) };
    if (l.kind === "five_hour") out.fiveHour = window;
    else if (l.kind === "seven_day") out.sevenDay = window;
  }
  return out.fiveHour === undefined && out.sevenDay === undefined ? undefined : out;
}

// What every rule input shares, read once per build.
export type Shared = { inventory: PluginInventory[]; snaps: BreakdownSnapshot[]; limits: RuleLimits | undefined; live: LiveState; window: number; prices: PriceTable; now: number };

export async function sharedOf($: EngineInterface, cfg: string, snaps: BreakdownSnapshot[], now: number, tick: () => Promise<void>): Promise<Shared> {
  const [inventory, stored, live, foot] = await Promise.all([readInventory($, cfg, tick), $.store.get(LAST_LIMITS_KEY).catch(() => undefined), readLive($), readFoot($)]);
  return { inventory, snaps, limits: limitsFrom(stored), live, window: foot.contextWindow, prices: await currentPrices($), now };
}

// The rules' input for one scope. Limits and the live figures belong to the live session; a span block with no live session takes the limits.
export function inputOf(sh: Shared, scope: "session" | "span", summary: Summary, sessionId: string): HintInput {
  const mine = scope === "session" && sessionId !== "" && sh.live.sessionId === sessionId;
  const near = nearestSnapshot(sh.snaps, summary.to, scope === "session" && sessionId !== "" ? sessionId : undefined);
  const wantsLimits = scope === "session" || sessionId === "";
  return {
    scope,
    summary,
    snaps: sh.snaps,
    plugins: pluginsFrom(sh.inventory, near === null ? null : near.snap, summary),
    prices: sh.prices,
    nowMs: sh.now,
    ...(mine && { live: sh.live }),
    ...(mine && sh.window > 0 && { window: sh.window }),
    ...(wantsLimits && sh.limits !== undefined && { limits: sh.limits }),
  };
}

/** Every project's shard and snapshots; `unread` counts the projects with no usable index. */
export async function loadScope($: EngineInterface, loc: { cfg: string; roots: string[] }, now: number, tick: () => Promise<void>): Promise<{ shards: Shard[]; snaps: BreakdownSnapshot[]; unread: number }> {
  const shards: Shard[] = [];
  const snaps: BreakdownSnapshot[] = [];
  let unread = 0;
  for (const p of await listProjects($, loc.roots)) {
    await tick();
    const shard = await loadProject($, loc.cfg, p, now, tick);
    if (shard === null) unread++;
    else shards.push(shard);
    snaps.push(...(await loadSnapshots($, loc.cfg, p, now, tick)));
  }
  return { shards, snaps, unread };
}

async function build($: EngineInterface, want: HintsWant, now: number): Promise<void> {
  const loc = await locate($);
  const slicer = makeSlicer($);
  const tick = () => slicer.check();
  const tzOffsetMin = -new Date(now).getTimezoneOffset();
  const repo = want.repoOnly ? repoOf(await $.session.cwd()) || UNKNOWN_REPO : "";
  const { shards, snaps, unread } = await loadScope($, loc, now, tick);
  const sh = await sharedOf($, loc.cfg, snaps, now, tick);
  const prices = sh.prices;
  const spanSummary = await summarizeAsync(shards, prices, { span: want.span, nowMs: now, tzOffsetMin, usage: true, ...(want.repoOnly && { repo }) }, tick);
  let session: Hint[] = [];
  if (want.sessionId !== "") {
    const own = await summarizeAsync(shards, prices, { span: "session", sessionId: want.sessionId, nowMs: now, tzOffsetMin, usage: true }, tick);
    session = await runRules(HINT_RULES, inputOf(sh, "session", own, want.sessionId), tick);
  }
  const data: HintsData = {
    key: hintsKeyOf(want),
    at: now,
    repo,
    requests: spanSummary.total.requests,
    unread,
    session,
    span: await runRules(HINT_RULES, inputOf(sh, "span", spanSummary, want.sessionId), tick),
  };
  await update($, hintsAtom, () => data);
  if (want.sessionId !== "") await update($, topAtom, () => ({ sessionId: want.sessionId, at: now, hint: session[0] ?? null }));
  invalidateWindow($);
}

/** The live session's leading hint, kept apart from the tab's findings so the folded line needs no span scan. */
export type TopHint = { sessionId: string; at: number; hint: Hint | null };
const EMPTY_TOP: TopHint = { sessionId: "", at: 0, hint: null };
const topAtom = atom({ plugin: "tally", key: "top-hint" } as const, EMPTY_TOP, { shape: "top-hint-1" });

export function readTopHint($: EngineInterface): Promise<TopHint> {
  return read($, topAtom);
}

/** True when the leading hint of `sessionId` is unknown or older than the findings interval. */
export const needsTop = (top: TopHint, sessionId: string, now: number): boolean => sessionId !== "" && (top.sessionId !== sessionId || now - top.at >= HINTS_INTERVAL_MS);

let topRunning: Promise<void> | undefined;

// The live session's rows live in its own project; that one folder and its snapshots are all the rules need.
async function buildTop($: EngineInterface, sessionId: string, now: number): Promise<void> {
  const loc = await locate($);
  const slicer = makeSlicer($);
  const tick = () => slicer.check();
  const project = projectNameOf(await $.session.cwd());
  const shard = await loadProject($, loc.cfg, project, now, tick);
  const snaps = await loadSnapshots($, loc.cfg, project, now, tick);
  const sh = await sharedOf($, loc.cfg, snaps, now, tick);
  const own = await summarizeAsync(shard === null ? [] : [shard], sh.prices, { span: "session", sessionId, nowMs: now, tzOffsetMin: -new Date(now).getTimezoneOffset(), usage: true }, tick);
  const hints = await runRules(HINT_RULES, inputOf(sh, "session", own, sessionId), tick);
  await update($, topAtom, () => ({ sessionId, at: now, hint: hints[0] ?? null }));
  invalidateWindow($);
}

/** Rebuilds the leading hint of `sessionId` unless it is fresh; one build runs at a time. Never rejects. */
export async function refreshTop($: EngineInterface, sessionId: string): Promise<void> {
  try {
    if (sessionId === "" || topRunning !== undefined) return;
    const now = await $.clock.now();
    if (!needsTop(await read($, topAtom), sessionId, now)) return;
    topRunning = buildTop($, sessionId, now)
      .catch(async () => {
        // Try again after the retry gap; the line shows no hint meanwhile.
        try {
          await update($, topAtom, () => ({ sessionId, at: now - HINTS_INTERVAL_MS + HINTS_RETRY_MS, hint: null }));
        } catch {
          /* nothing to keep it in */
        }
      })
      .finally(() => {
        topRunning = undefined;
      });
    await topRunning;
  } catch {
    /* the line keeps what it had */
  }
}

/** Rebuilds the findings for `want` unless they are fresh (or `force`); one build runs at a time. Never rejects. */
export async function refreshHints($: EngineInterface, want: HintsWant, force = false): Promise<void> {
  try {
    const key = hintsKeyOf(want);
    let now: number;
    // A build that started during the reads below sends the loop back to wait for it.
    for (;;) {
      while (running !== undefined) await running;
      now = await $.clock.now();
      const data = await read($, hintsAtom);
      if (running !== undefined) continue;
      if (!force && !needsHints(data, want, now)) return;
      break;
    }
    // No await between the check above and this line: only one build starts.
    running = build($, want, now)
      .catch(async (err: unknown) => {
        const why = (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0]!.slice(0, FAILURE_CHARS);
        try {
          $.ui.log(`tally: hints build failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, { to: "debug" });
          await update($, hintsAtom, (d) => ({ ...d, failure: { key, why, at: now } }));
          invalidateWindow($);
        } catch {
          /* nothing to log to */
        }
      })
      .finally(() => {
        running = undefined;
      });
    await running;
  } catch {
    /* the tab keeps what it had */
  }
}
