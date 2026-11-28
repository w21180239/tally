// Spend report data: the window's Summary, ranked hints with redacted evidence, and the baseline of the spend pace.
// Pure: the engine loads the figures and hands them in.
import { HINT_RULES, redact, runRules } from "../core/hint.ts";
import type { Hint, HintInput, Tick } from "../core/hint.ts";
import { utf8Length } from "../core/lines.ts";
import type { Span, Summary } from "../core/summary.ts";
import { DAY_MS } from "../core/time.ts";

/** Store key of the saved baseline. */
export const BASELINE_KEY = "baseline";
/** Byte cap of one file `$.fs.write` takes. */
export const SNAPSHOT_MAX = 4_194_304;
/** Complete days the pace is measured over; scaled to a 30-day month. */
export const RUN_RATE_DAYS = 14;

/** A saved spend pace with the saving each hint offered on that day; compare-mode reports measure against it. */
export type Baseline = { at: number; runRate: number; perHint: { rule: string; expectedUsd: number }[] };

export type Report = {
  span: Span;
  generatedAt: number;
  summary: Summary;
  hints: Hint[];
  baseline?: Baseline;
  compare?: { runRate: number; baselineRunRate: number };
  /** The repository the figures are limited to. */
  repo?: string;
  /** Projects with no usable index when the report was built; their spend is missing. */
  unread?: number;
  /** Where the price table in effect came from and its date (epoch ms). */
  prices?: { source: "builtin" | "fetched"; updatedAt: number };
};

export type ReportOpts = {
  days: number;
  repo?: string;
  compare: boolean;
  /** The saved baseline, read by the engine; used only with `compare`. */
  baseline?: Baseline;
  /** Current pace over all repos (`runRateOf` of an unfiltered 30-day Summary); `compare` needs it. */
  runRate?: number;
  unread?: number;
};

/** Dollars per 30 days at the pace of the last 14 complete days. Today's bucket is still filling and stays out. */
export function runRateOf(s: Summary): number {
  const t = s.timeline;
  if (t.bucketMs !== DAY_MS || t.points.length < 2) return 0;
  const done = t.points.slice(-(RUN_RATE_DAYS + 1), -1);
  return (done.reduce((n, p) => n + p.usd, 0) * 30) / RUN_RATE_DAYS;
}

/** The record to store: the pace, and per hint that carries a dollar figure the saving it offered. */
export const baselineOf = (at: number, runRate: number, hints: Hint[]): Baseline => ({
  at,
  runRate,
  perHint: hints.filter((h) => h.usd > 0).map((h) => ({ rule: h.rule, expectedUsd: h.usd })),
});

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The baseline in a stored value; anything malformed gives none. */
export function parseBaseline(raw: unknown): Baseline | undefined {
  const b = raw as { at?: unknown; runRate?: unknown; perHint?: unknown } | null | undefined;
  if (b === null || typeof b !== "object" || !num(b.at) || !num(b.runRate) || !Array.isArray(b.perHint)) return undefined;
  const perHint: Baseline["perHint"] = [];
  for (const x of b.perHint as Array<{ rule?: unknown; expectedUsd?: unknown } | null>) {
    if (x !== null && typeof x === "object" && typeof x.rule === "string" && num(x.expectedUsd)) perHint.push({ rule: x.rule, expectedUsd: x.expectedUsd });
  }
  return { at: b.at, runRate: b.runRate, perHint };
}

/** The report for `input`'s summary. Evidence is always redacted. `tick` is awaited between rules. */
export async function buildReport(input: HintInput, opts: ReportOpts, tick?: Tick): Promise<Report> {
  const hints = (await runRules(HINT_RULES, input, tick)).map((h) => ({ ...h, evidence: h.evidence.map((e) => redact(e, true)) }));
  const report: Report = { span: input.summary.span, generatedAt: input.nowMs, summary: input.summary, hints, prices: { source: input.prices.source, updatedAt: input.prices.updatedAt } };
  if (opts.repo !== undefined && opts.repo !== "") report.repo = opts.repo;
  if (opts.unread !== undefined && opts.unread > 0) report.unread = opts.unread;
  if (opts.compare && opts.baseline !== undefined && opts.runRate !== undefined) {
    report.baseline = opts.baseline;
    report.compare = { runRate: opts.runRate, baselineRunRate: opts.baseline.runRate };
  }
  return report;
}

// Detail dropped, in order, until a snapshot fits: first what each top session carries, then the list, then the bulky tables.
const BULKY: Array<keyof Summary> = ["flow", "flowByAgent", "pastes", "hugeResults", "wholeReads", "usage", "cacheRebuilds", "mcpReread", "bySubType", "bySkill", "byPlugin", "byMcp", "elsewhere"];

/** The report as JSON for `report-<span>.json`, cut down to fit `max` bytes; null when even the cut one is too big. */
export function snapshotJson(r: Report, max = SNAPSHOT_MAX): string | null {
  const fits = (s: string): boolean => utf8Length(s) <= max;
  let json = JSON.stringify(r);
  if (fits(json)) return json;
  const slim = (top: unknown, extra: Partial<Record<keyof Summary, undefined>> = {}): string => JSON.stringify({ ...r, summary: { ...r.summary, topSessions: top, ...extra } });
  json = slim(r.summary.topSessions.map((t) => ({ sessionId: t.sessionId, repo: t.repo, started: t.started, usd: t.usd })));
  if (fits(json)) return json;
  json = slim([]);
  if (fits(json)) return json;
  const cut: Partial<Record<keyof Summary, undefined>> = {};
  for (const k of BULKY) {
    cut[k] = undefined;
    json = slim([], cut);
    if (fits(json)) return json;
  }
  json = JSON.stringify({ ...r, summary: { ...r.summary, topSessions: [], ...cut }, hints: r.hints.map((h) => ({ ...h, evidence: [] })) });
  return fits(json) ? json : null;
}
