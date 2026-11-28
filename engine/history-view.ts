// The figures behind the Spend tab (History): the span's rows of every project's index, built off the draw path, and
// how far the transcript scan has got. A project with no usable index is unread, never empty. The tab draws what the
// atoms last held and asks for a rebuild when they are stale; during a scan, progress and figures are checked every
// few seconds for as long as the tab keeps being drawn.
import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";
import { dict } from "../core/dict.ts";
import { EMPTY_HISTORY, historyKeyOf, historyOf, scanOf } from "../core/history.ts";
import type { HistoryData, HistoryMeta, MergedHistory, ScanState } from "../core/history.ts";
import { repoOf } from "../core/path.ts";
import type { Shard } from "../core/shard.ts";
import { summarizeAsync, UNKNOWN_REPO } from "../core/summary.ts";
import type { Span, Summary } from "../core/summary.ts";
import { mergeMachines } from "../core/sync.ts";
import { projectNameOf } from "../core/plan-scan.ts";
import { locate } from "./locate.ts";
import { currentPrices } from "./price-update.ts";
import { loadProject } from "./project-store.ts";
import { readProgress } from "./progress.ts";
import { listProjects } from "./scanner.ts";
import { makeSlicer } from "./slicer.ts";
import { loadRemotes } from "./sync.ts";
import { sessionShard } from "./usage-view.ts";
import { attempt, inBackground, invalidateWindow, settingsNow } from "./window.ts";

/** Figures older than this are rebuilt at the next draw of the tab; during a scan, sooner; the live session's, too. */
export const HISTORY_INTERVAL_MS = 300_000;
export const HISTORY_SCAN_INTERVAL_MS = 20_000;
export const HISTORY_SESSION_INTERVAL_MS = 10_000;
/** A failed build is not retried sooner than this. */
export const HISTORY_RETRY_MS = 30_000;
/** The progress file is read again at a draw this long after the last read. */
export const SCAN_CHECK_MS = 3_000;
/** A scan keeps being polled if the tab was drawn this recently. */
const WANTED_MS = 10_000;
const FAILURE_CHARS = 80;

export type ScanView = { at: number; scan: ScanState | null };
export const EMPTY_SCAN_VIEW: ScanView = { at: 0, scan: null };

const historyAtom = atom({ plugin: "tally", key: "history" } as const, EMPTY_HISTORY, { shape: "history-3" });
const scanAtom = atom({ plugin: "tally", key: "history-scan" } as const, EMPTY_SCAN_VIEW, { shape: "history-scan-1" });

export function readHistory($: EngineInterface): Promise<HistoryData> {
  return read($, historyAtom);
}
export function readScanView($: EngineInterface): Promise<ScanView> {
  return read($, scanAtom);
}

type Tick = () => Promise<void>;
/**
 * What the tab asks for. `sync`: a sync folder is set, so the 30-day build also merges the other computers' files.
 * `span` is 30d when left out; a session span needs `sessionId`.
 */
export type Want = { repoOnly: boolean; sync?: boolean; span?: Span; sessionId?: string };

export const wantKey = (w: Want): string => historyKeyOf(w.repoOnly, w.sync, w.span, w.sessionId);

/** True when the figures need a rebuild: another key, past their age limit, or built mid-scan and the scan is over. */
export function needsRebuild(data: Pick<HistoryData, "key" | "at" | "partial" | "failure">, scan: Pick<ScanView, "scan">, want: Want, now: number): boolean {
  const key = wantKey(want);
  if (want.span === "session" && (want.sessionId ?? "") === "") return false;
  if (data.failure?.key === key && now - data.failure.at < HISTORY_RETRY_MS) return false;
  if (data.key !== key) return true;
  const limit = scan.scan !== null ? HISTORY_SCAN_INTERVAL_MS : want.span === "session" ? HISTORY_SESSION_INTERVAL_MS : HISTORY_INTERVAL_MS;
  if (now - data.at >= limit) return true;
  return data.partial && scan.scan === null;
}

/** True when the draw should queue a check: a rebuild is due, or the progress file has not been read lately. */
export function needsHistory(data: Pick<HistoryData, "key" | "at" | "partial" | "failure">, scan: ScanView, want: Want, now: number): boolean {
  if (needsRebuild(data, scan, want, now)) return true;
  return data.failure?.key !== wantKey(want) && now - scan.at >= SCAN_CHECK_MS;
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

async function build($: EngineInterface, want: Want, now: number, scanning: boolean): Promise<void> {
  const span = want.span ?? "30d";
  const sync = want.sync === true;
  const loc = await locate($);
  const prices = await currentPrices($);
  const slicer = makeSlicer($);
  const tick = () => slicer.check();
  const tzOffsetMin = -new Date(now).getTimezoneOffset();
  const cwd = await $.session.cwd();
  const repo = want.repoOnly ? repoOf(cwd) || UNKNOWN_REPO : "";
  const shards: Shard[] = [];
  let unread = 0;
  if (span === "session") {
    shards.push(await sessionShard($, loc.cfg, projectNameOf(cwd), want.sessionId ?? "", now, tick));
  } else {
    for (const p of await listProjects($, loc.roots)) {
      await tick();
      const shard = await loadProject($, loc.cfg, p, now, tick);
      if (shard === null) unread++;
      else shards.push(shard);
    }
  }
  const summary = await summarizeAsync(shards, prices, { span, nowMs: now, tzOffsetMin, usage: true, ...(want.repoOnly && { repo }), ...(span === "session" && { sessionId: want.sessionId ?? "" }) }, tick);

  const meta: HistoryMeta = { key: wantKey(want), at: now, repo, tzOffsetMin, unread, partial: scanning };
  const data = historyOf(summary, meta);
  // Numbers files hold days and no repo filter, so only the all-repo 30 days are merged.
  let all: MergedHistory | undefined;
  if (sync && !want.repoOnly && span === "30d") {
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
    const key = wantKey(want);
    while (running !== undefined) await running;
    const now = await $.clock.now();
    const scan = await read($, scanAtom);
    const data = await read($, historyAtom);
    if (!force && !needsRebuild(data, scan, want, now)) return;
    // No await between the checks above and this line: only one build starts.
    running = build($, want, now, scan.scan !== null)
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
/** A check is running; a draw during it leaves the rest to it. */
let pending = false;
/** The next check is booked for SCAN_CHECK_MS; a draw before then may still start one of its own. */
let booked = false;
// What the last draw asked for: a check in flight or booked serves this, not the span it was started for.
let latest: Want = { repoOnly: false };

// One check of the scan and the figures; the next is booked if a scan is still running and the tab is on screen.
async function poll($: EngineInterface): Promise<void> {
  pending = true;
  try {
    const changed = await lookAtScan($, await $.clock.now());
    const used = wantKey(latest);
    await refreshHistory($, latest);
    // A draw during the build asked for another span or repo: build that too, now.
    if (wantKey(latest) !== used) await refreshHistory($, latest);
    if (changed) invalidateWindow($);
  } finally {
    pending = false;
  }
  const scan = await read($, scanAtom);
  if (scan.scan === null || (await $.clock.now()) - wantedAt > WANTED_MS || booked) return;
  booked = true;
  $.clock.after(SCAN_CHECK_MS, () => {
    booked = false;
    if (!pending) attempt($, () => poll($));
  });
}

/** Called from the draw: queues a check off the draw path when one is due and none is pending. */
export function wantHistory($: EngineInterface, data: HistoryData, scan: ScanView, want: Want, now: number): void {
  wantedAt = now;
  latest = want;
  if (pending || !needsHistory(data, scan, want, now)) return;
  // Set here too, not only in the check: a second draw before the background call starts must not queue another.
  pending = true;
  inBackground($, () => poll($));
}
