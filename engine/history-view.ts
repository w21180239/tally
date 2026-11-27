// The figures behind the History tab: a month of every project's index, built off the draw path, and how far the
// transcript scan has got. A project with no usable index is unread, never empty. The tab draws what the atoms last
// held and asks for a rebuild when they are stale; during a scan, progress and figures are checked every few seconds
// for as long as the tab keeps being drawn.
import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";
import { mcpSchemaSteps, nearestSnapshot } from "../core/breakdown.ts";
import type { BreakdownSnapshot } from "../core/breakdown.ts";
import { dict } from "../core/dict.ts";
import { EMPTY_HISTORY, historyKeyOf, historyOf, mcpCosts, scanOf } from "../core/history.ts";
import type { HistoryData, HistoryMeta, MergedHistory, ScanState } from "../core/history.ts";
import { repoOf } from "../core/path.ts";
import { projectNameOf } from "../core/plan-scan.ts";
import type { PriceTable } from "../core/pricing.ts";
import type { Shard } from "../core/shard.ts";
import { drainAsync, STEP_ROWS } from "../core/steps.ts";
import { repoFor, summarizeAsync, UNKNOWN_REPO } from "../core/summary.ts";
import type { Summary } from "../core/summary.ts";
import { mergeMachines } from "../core/sync.ts";
import type { UsageRow } from "../core/types.ts";
import { locate } from "./locate.ts";
import { currentPrices } from "./price-update.ts";
import { loadProject } from "./project-store.ts";
import { readProgress } from "./progress.ts";
import { listProjects } from "./scanner.ts";
import { makeSlicer } from "./slicer.ts";
import { lastSnapshot, loadSnapshots } from "./snapshot.ts";
import { loadRemotes } from "./sync.ts";
import { attempt, inBackground, invalidateWindow, settingsNow } from "./window.ts";

/** Figures older than this are rebuilt at the next draw of the tab; during a scan, sooner. */
export const HISTORY_INTERVAL_MS = 300_000;
export const HISTORY_SCAN_INTERVAL_MS = 20_000;
/** A failed build is not retried sooner than this. */
export const HISTORY_RETRY_MS = 30_000;
/** The progress file is read again at a draw this long after the last read. */
export const SCAN_CHECK_MS = 3_000;
/** A scan keeps being polled if the tab was drawn this recently. */
const WANTED_MS = 10_000;
const FAILURE_CHARS = 80;

export type ScanView = { at: number; scan: ScanState | null };
export const EMPTY_SCAN_VIEW: ScanView = { at: 0, scan: null };

const historyAtom = atom({ plugin: "tally", key: "history" } as const, EMPTY_HISTORY, { shape: "history-2" });
const scanAtom = atom({ plugin: "tally", key: "history-scan" } as const, EMPTY_SCAN_VIEW, { shape: "history-scan-1" });

export function readHistory($: EngineInterface): Promise<HistoryData> {
  return read($, historyAtom);
}
export function readScanView($: EngineInterface): Promise<ScanView> {
  return read($, scanAtom);
}

type Tick = () => Promise<void>;
/** `sync`: a sync folder is set, so the build also merges the other computers' files. */
type Want = { repoOnly: boolean; sync?: boolean };

/** True when the figures need a rebuild: another key, past their age limit, or built mid-scan and the scan is over. */
export function needsRebuild(data: Pick<HistoryData, "key" | "at" | "partial" | "failure">, scan: Pick<ScanView, "scan">, want: Want, now: number): boolean {
  const key = historyKeyOf(want.repoOnly, want.sync);
  if (data.failure?.key === key && now - data.failure.at < HISTORY_RETRY_MS) return false;
  if (data.key !== key) return true;
  if (now - data.at >= (scan.scan !== null ? HISTORY_SCAN_INTERVAL_MS : HISTORY_INTERVAL_MS)) return true;
  return data.partial && scan.scan === null;
}

/** True when the draw should queue a check: a rebuild is due, or the progress file has not been read lately. */
export function needsHistory(data: Pick<HistoryData, "key" | "at" | "partial" | "failure">, scan: ScanView, want: Want, now: number): boolean {
  if (needsRebuild(data, scan, want, now)) return true;
  return data.failure?.key !== historyKeyOf(want.repoOnly, want.sync) && now - scan.at >= SCAN_CHECK_MS;
}

// Schema cost over the main-thread rows of each session, within the span and for the repo.
async function schemaCosts(prices: PriceTable, shards: Shard[], snapsOf: (project: string) => BreakdownSnapshot[], from: number, to: number, repo: string, tick: Tick): Promise<{ usd: Record<string, number>; proxy: boolean; missing: number }> {
  const usd = dict<number>();
  let proxy = false;
  let missing = 0;
  for (const shard of shards) {
    const snaps = snapsOf(shard.project);
    const bySession = new Map<string, UsageRow[]>();
    for (let i = 0; i < shard.usage.length; i++) {
      if (i % STEP_ROWS === STEP_ROWS - 1) await tick();
      const r = shard.usage[i]!;
      if (r.synthetic || r.sidechain || r.ts < from || r.ts > to) continue;
      if (repo !== "" && repoFor(r) !== repo) continue;
      const list = bySession.get(r.sessionId);
      if (list === undefined) bySession.set(r.sessionId, [r]);
      else list.push(r);
    }
    for (const [id, rows] of bySession) {
      await tick();
      const near = nearestSnapshot(snaps, rows[0]!.ts, id);
      if (near === null) {
        missing++;
        continue;
      }
      if (near.proxy) proxy = true;
      const part = await drainAsync(mcpSchemaSteps(rows, near.snap, prices), tick);
      for (const [server, n] of Object.entries(part)) usd[server] = (usd[server] ?? 0) + n;
    }
  }
  return { usd, proxy, missing };
}

let running: Promise<void> | undefined;

// The same figures over this computer and the other computers' files. Every remote file is parsed in its own slice.
async function mergedOf($: EngineInterface, summary: Summary, meta: HistoryMeta, tick: Tick): Promise<MergedHistory | undefined> {
  const settings = settingsNow();
  if (settings.syncDir === "") return undefined;
  const { self, files } = await loadRemotes($, settings, tick);
  const merged = mergeMachines(summary, files, meta.tzOffsetMin, self);
  const sessionMachine: Record<string, string> = dict<string>();
  for (const f of files) for (const s of f.sessions ?? []) sessionMachine[s.sessionId] = f.machine;
  const contributed: string[] = [];
  if (files.some((f) => f.detail !== "numbers")) contributed.push("byRepo");
  if (files.some((f) => f.detail === "full" && f.sessions !== undefined)) contributed.push("topSessions");
  if (files.some((f) => f.detail === "full" && f.toolFill !== undefined)) contributed.push("toolFill");
  return {
    ...historyOf(merged, meta),
    machines: [...new Set([self, ...files.map((f) => f.machine)])].sort(),
    localOnly: merged.localOnly,
    contributed,
    sessionMachine,
  };
}

async function build($: EngineInterface, repoOnly: boolean, sync: boolean, now: number, scanning: boolean): Promise<void> {
  const loc = await locate($);
  const prices = await currentPrices($);
  const slicer = makeSlicer($);
  const tick = () => slicer.check();
  const tzOffsetMin = -new Date(now).getTimezoneOffset();
  const cwd = await $.session.cwd();
  const repo = repoOnly ? repoOf(cwd) || UNKNOWN_REPO : "";
  const shards: Shard[] = [];
  let unread = 0;
  for (const p of await listProjects($, loc.roots)) {
    await tick();
    const shard = await loadProject($, loc.cfg, p, now, tick);
    if (shard === null) unread++;
    else shards.push(shard);
  }
  const summary = await summarizeAsync(shards, prices, { span: "30d", nowMs: now, tzOffsetMin, usage: true, ...(repoOnly && { repo }) }, tick);

  const snaps = new Map<string, BreakdownSnapshot[]>();
  for (const shard of shards) {
    await tick();
    snaps.set(shard.project, await loadSnapshots($, loc.cfg, shard.project, now, tick));
  }
  const mine = lastSnapshot();
  if (mine !== undefined) {
    const own = snaps.get(projectNameOf(cwd));
    if (own !== undefined && !own.some((s) => s.sessionId === mine.sessionId && s.ts === mine.ts)) own.push(mine);
  }
  const schema = await schemaCosts(prices, shards, (p) => snaps.get(p) ?? [], summary.from, summary.to, repo, tick);
  const mcp = mcpCosts(schema.usd, summary.mcpReread, summary.byMcp);

  const meta: HistoryMeta = { key: historyKeyOf(repoOnly, sync), at: now, repo, tzOffsetMin, mcp, mcpProxy: schema.proxy, mcpMissing: schema.missing, unread, partial: scanning };
  const data = historyOf(summary, meta);
  // Numbers files carry no repo filter, so a one-repo view is never merged.
  let all: MergedHistory | undefined;
  if (sync && !repoOnly) {
    try {
      all = await mergedOf($, summary, meta, tick);
    } catch (err) {
      // The local figures still show.
      $.ui.log(`tally: history merge failed: ${err instanceof Error ? err.message : String(err)}`, { to: "debug" });
    }
  }
  await update($, historyAtom, () => (all === undefined ? data : { ...data, all }));
  invalidateWindow($);
}

/** Reads the progress file into the scan atom; true if the percent or the running state differs from before. */
async function lookAtScan($: EngineInterface, now: number): Promise<boolean> {
  const loc = await locate($);
  const found = scanOf(await readProgress($, loc.cfg), now);
  const before = await read($, scanAtom);
  await update($, scanAtom, () => ({ at: now, scan: found }));
  return before.scan?.percent !== found?.percent || (before.scan === null) !== (found === null);
}

/** Rebuilds the figures when `needsRebuild` says so (or `force`); one build runs at a time. Never rejects. */
export async function refreshHistory($: EngineInterface, want: Want, force = false): Promise<void> {
  try {
    const key = historyKeyOf(want.repoOnly, want.sync);
    while (running !== undefined) await running;
    const now = await $.clock.now();
    const scan = await read($, scanAtom);
    const data = await read($, historyAtom);
    if (!force && !needsRebuild(data, scan, want, now)) return;
    // No await between the checks above and this line: only one build starts.
    running = build($, want.repoOnly, want.sync === true, now, scan.scan !== null)
      .catch(async (err: unknown) => {
        const why = (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0]!.slice(0, FAILURE_CHARS);
        try {
          $.ui.log(`tally: history build failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, { to: "debug" });
          await update($, historyAtom, (d) => ({ ...d, failure: { key, why, at: now } }));
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

let wantedAt = 0;
let pending = false;

// One check of the scan and the figures; the next is booked if a scan is still running and the tab is on screen.
async function poll($: EngineInterface, want: Want): Promise<void> {
  try {
    const changed = await lookAtScan($, await $.clock.now());
    await refreshHistory($, want);
    if (changed) invalidateWindow($);
  } finally {
    pending = false;
  }
  const scan = await read($, scanAtom);
  if (scan.scan === null || (await $.clock.now()) - wantedAt > WANTED_MS) return;
  pending = true;
  $.clock.after(SCAN_CHECK_MS, () => attempt($, () => poll($, want)));
}

/** Called from the draw: queues a check off the draw path when one is due and none is pending. */
export function wantHistory($: EngineInterface, data: HistoryData, scan: ScanView, want: Want, now: number): void {
  wantedAt = now;
  if (pending || !needsHistory(data, scan, want, now)) return;
  pending = true;
  inBackground($, () => poll($, want));
}
