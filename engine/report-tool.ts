// The spend report for Claude (the tally_report tool), for the person (/tally report) and for the Herdr sidebar
// (report-<span>.json beside the scan index). All three build one Report from the same loads as the Hints tab.
import type { EngineInterface } from "claude-code";
import { HINT_RULES, runRules } from "../core/hint.ts";
import { joinPath } from "../core/path.ts";
import { summarizeAsync } from "../core/summary.ts";
import type { Span, Summary } from "../core/summary.ts";
import { DAY_MS } from "../core/time.ts";
import { BASELINE_KEY, baselineOf, buildReport, parseBaseline, runRateOf, snapshotJson } from "../report/build.ts";
import type { Baseline, Report } from "../report/build.ts";
import { renderMarkdown } from "../report/markdown.ts";
import { inputOf, loadScope, sharedOf } from "./hints-view.ts";
import { locate } from "./locate.ts";
import { makeSlicer } from "./slicer.ts";

export const REPORT_TOOL = "tally_report";
/** The name the model calls it by: `mcp__<plugin>__<name>`. */
export const REPORT_TOOL_FULL = `mcp__tally__${REPORT_TOOL}`;
/** The scan history holds this many days. */
export const MAX_DAYS = 30;
/** Snapshots are rebuilt at most this often by scan-done events. */
export const SNAPSHOT_GAP_MS = 60_000;

export type ReportArgs = { days?: number; repo?: string; compare?: boolean; saveBaseline?: boolean };

const DESCRIPTION =
  "Markdown spend report for Claude Code use on this computer, billed at API list rates: totals, models, repositories, costliest sessions, ranked saving hints and how far to trust the figures. " +
  "Use it to find where the money goes and what to change. `days` sets the window (default 30, at most 30), `repo` limits it to one repository, " +
  "`saveBaseline` records today's spend pace and each hint's expected saving, and `compare` shows the pace now against the saved baseline.";

const SCHEMA = {
  type: "object",
  properties: {
    days: { type: "integer", minimum: 1, maximum: MAX_DAYS, description: "Window in days. Default 30." },
    repo: { type: "string", description: "Only this repository." },
    compare: { type: "boolean", description: "Compare the spend pace with the saved baseline." },
    saveBaseline: { type: "boolean", description: "Record the spend pace and the hints' expected savings as the new baseline." },
  },
};

/** Declares the tool; the engine routes its calls to the `tool.run` hook on REPORT_TOOL_FULL. */
export async function registerReportTool($: EngineInterface): Promise<void> {
  await $.tool.register({ name: REPORT_TOOL, description: DESCRIPTION, inputSchema: SCHEMA });
}

/** Tool arguments as given by the model; anything of the wrong type is ignored. */
export function argsOf(input: unknown): ReportArgs {
  const i = (input ?? {}) as Record<string, unknown>;
  const out: ReportArgs = {};
  if (typeof i.days === "number" && Number.isFinite(i.days)) out.days = i.days;
  if (typeof i.repo === "string" && i.repo.trim() !== "") out.repo = i.repo.trim();
  if (i.compare === true) out.compare = true;
  if (i.saveBaseline === true) out.saveBaseline = true;
  return out;
}

export const clampDays = (days: number | undefined): number => (days === undefined ? MAX_DAYS : Math.min(MAX_DAYS, Math.max(1, Math.round(days))));

type Built = { report: Report; saved?: Baseline };

// One load of every project, then the window's summary and, when a baseline is asked for, the unfiltered 30-day one.
async function build($: EngineInterface, args: ReportArgs, now: number): Promise<Built> {
  const loc = await locate($);
  const slicer = makeSlicer($);
  const tick = () => slicer.check();
  const tz = -new Date(now).getTimezoneOffset();
  const days = clampDays(args.days);
  const { shards, snaps, unread } = await loadScope($, loc, now, tick);
  const sh = await sharedOf($, loc.cfg, snaps, now, tick);
  const span: Span = days <= 1 ? "24h" : "30d";
  const summary = await summarizeAsync(shards, sh.prices, { span, nowMs: now, tzOffsetMin: tz, usage: true, ...(days > 1 && days < MAX_DAYS && { since: now - days * DAY_MS }), ...(args.repo !== undefined && { repo: args.repo }) }, tick);
  const needsRate = args.compare === true || args.saveBaseline === true;
  const whole = (days === MAX_DAYS && args.repo === undefined) || !needsRate ? summary : await summarizeAsync(shards, sh.prices, { span: "30d", nowMs: now, tzOffsetMin: tz, usage: true }, tick);
  const runRate = needsRate ? runRateOf(whole) : undefined;
  const baseline = args.compare === true ? parseBaseline(await $.store.get(BASELINE_KEY).catch(() => undefined)) : undefined;
  const report = await buildReport(inputOf(sh, "span", summary, ""), { days, ...(args.repo !== undefined && { repo: args.repo }), compare: args.compare === true, ...(baseline && { baseline }), ...(runRate !== undefined && { runRate }), unread }, tick);
  if (args.saveBaseline !== true || runRate === undefined) return { report };
  // Saved hints cover all 30 days and every repo, so any later window is judged against the same basis.
  const hints = whole === summary && args.repo === undefined ? report.hints : await runRules(HINT_RULES, inputOf(sh, "span", whole, ""), tick);
  const saved = baselineOf(now, runRate, hints);
  await $.store.set(BASELINE_KEY, saved);
  return { report, saved };
}

const dollars = (n: number): string => `$${n.toFixed(2)}`;

/** The tool's answer: the markdown, with a closing line when a baseline was stored. */
export async function reportText($: EngineInterface, args: ReportArgs): Promise<string> {
  const { report, saved } = await build($, args, await $.clock.now());
  const note = saved === undefined ? "" : `\nBaseline saved: ${dollars(saved.runRate)} per 30 days and ${saved.perHint.length} hint${saved.perHint.length === 1 ? "" : "s"}${report.unread === undefined ? "" : "; some projects were not indexed yet, so the pace may be low"}.\n`;
  return renderMarkdown(report) + note;
}

/** `/tally report [days] [repo]`: writes `api-spend-<date>.md` into the session working folder, then names the file. */
export async function reportCommand($: EngineInterface, args: ReportArgs): Promise<string> {
  const now = await $.clock.now();
  const { report } = await build($, { ...args, compare: false, saveBaseline: false }, now);
  const date = new Date(now - new Date(now).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const path = joinPath(await $.session.cwd(), `api-spend-${date}.md`);
  await $.fs.write(path, renderMarkdown(report));
  return `Wrote ${path}.`;
}

let snapshotting: Promise<void> | undefined;
let again = false;
let lastRun = -Infinity;

// 24h and 30d snapshots from one load; both are the Report shape the Herdr mod reads.
async function writeSnapshots($: EngineInterface, now: number): Promise<void> {
  const loc = await locate($);
  const slicer = makeSlicer($);
  const tick = () => slicer.check();
  const tz = -new Date(now).getTimezoneOffset();
  const { shards, snaps, unread } = await loadScope($, loc, now, tick);
  const sh = await sharedOf($, loc.cfg, snaps, now, tick);
  for (const span of ["24h", "30d"] as const) {
    const summary: Summary = await summarizeAsync(shards, sh.prices, { span, nowMs: now, tzOffsetMin: tz, usage: true }, tick);
    const report = await buildReport(inputOf(sh, "span", summary, ""), { days: span === "24h" ? 1 : MAX_DAYS, compare: false, unread }, tick);
    const json = snapshotJson(report);
    await tick();
    if (json !== null) await $.fs.write(joinPath(loc.cfg, "tally", `report-${span}.json`), json);
  }
}

/** Rewrites the two snapshots off the caller's path, one run at a time and not more often than SNAPSHOT_GAP_MS (`force` skips the gap). Never rejects. */
export function snapshotSoon($: EngineInterface, force = false): void {
  if (snapshotting !== undefined) {
    again = true;
    return;
  }
  snapshotting = (async () => {
    const now = await $.clock.now();
    if (!force && now - lastRun < SNAPSHOT_GAP_MS) return;
    lastRun = now;
    await writeSnapshots($, now);
  })()
    .catch(() => {})
    .finally(() => {
      snapshotting = undefined;
      if (again) {
        again = false;
        snapshotSoon($, true);
      }
    });
}

/** Test hook: forget the throttle and any queued run. */
export function resetSnapshots(): void {
  lastRun = -Infinity;
  again = false;
}
