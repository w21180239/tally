// Plain rows for the Spend tab (the History data), cut from a Summary of the span, and the transcript scan's progress as a percent.
import type { McpCost } from "./breakdown.ts";
import type { Money, Span, Summary, TopSession } from "./summary.ts";
import { HOUR_MS, hourStart, localDayStart } from "./time.ts";
import { USAGE_KINDS, usageTotals } from "./usage-detail.ts";
import type { Amount, UsageKind } from "./usage-detail.ts";

export type HistoryData = {
  /** Which view this is (see `historyKeyOf`): the repo filter, the span and, for a session, its id. */
  key: string;
  at: number;
  /** The repo `key: "repo"` stands for. */
  repo: string;
  requests: number;
  total: Amount;
  kinds: Array<{ kind: UsageKind } & Amount>;
  /** `hour` when the span is short (24h, a session under 72 hours), else `day`. */
  bucket: "hour" | "day";
  /** Local buckets with requests, newest first; `day` is `YYYY-MM-DD`, or `YYYY-MM-DD HH` for an hour. */
  days: Array<{ day: string; usd: number; tokens: number; requests: number }>;
  models: Array<{ name: string; usd: number; tokens: number }>;
  main: Amount;
  sub: Amount;
  subTypes: Array<{ type: string; model: string; usd: number; requests: number }>;
  repos: Array<{ name: string; usd: number }>;
  sessions: TopSession[];
  /** Tokens each tool put into context, estimated from text length. */
  fill: Array<{ tool: string; tokens: number }>;
  unpriced: string[];
  /** Projects with no usable index yet: their spend is unknown, not zero. */
  unread: number;
  /** Built while the scan was still running. */
  partial: boolean;
  /** Set when the last build for `key` failed and none has worked since. */
  failure?: { key: string; why: string; at: number };
  /** With a sync folder: the same figures over every computer's file (the `t` key); absent for one repo. */
  all?: MergedHistory;
};

/** The figures merged over the machine files. Blocks of `localOnly` hold this computer alone, or, if listed in `contributed`, not every computer's share. */
export type MergedHistory = Omit<HistoryData, "all"> & {
  /** This computer and every other one with a valid file. */
  machines: string[];
  localOnly: string[];
  contributed: string[];
  /** Session id to the computer that holds it, for sessions of other computers. */
  sessionMachine: Record<string, string>;
};

export const EMPTY_HISTORY: HistoryData = {
  key: "",
  at: 0,
  repo: "",
  requests: 0,
  total: { usd: 0, tokens: 0 },
  kinds: [],
  bucket: "day",
  days: [],
  models: [],
  main: { usd: 0, tokens: 0 },
  sub: { usd: 0, tokens: 0 },
  subTypes: [],
  repos: [],
  sessions: [],
  fill: [],
  unpriced: [],
  unread: 0,
  partial: false,
};

/**
 * The key of a view: `repo`, `all` or `all+sync` for 30 days; another span adds `@24h` or `@session:<id>`.
 * `sync`: a sync folder is set, so the 30-day figures also carry the all-computers merge (never for one repo or
 * another span: the other computers' files hold days only).
 */
export function historyKeyOf(repoOnly: boolean, sync = false, span: Span = "30d", sessionId = ""): string {
  if (span === "30d") return repoOnly ? "repo" : sync ? "all+sync" : "all";
  return `${repoOnly ? "repo" : "all"}@${span === "session" ? `session:${sessionId}` : span}`;
}

const tokenSum = (m: Money): number => m.tokens.input + m.tokens.output + m.tokens.cacheRead + m.tokens.cw5m + m.tokens.cw1h;
const amount = (m: Money): Amount => ({ usd: m.usd, tokens: tokenSum(m) });
const byUsd = <T extends { usd: number }>(a: T, b: T, na: string, nb: string): number => b.usd - a.usd || (na < nb ? -1 : na > nb ? 1 : 0);
const two = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** The date at `tzOffsetMin` minutes east of UTC for a UTC ms, as `YYYY-MM-DD`. */
export function localDayName(ms: number, tzOffsetMin: number): string {
  const d = new Date(ms + tzOffsetMin * 60_000);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

// Three letters per month, January first.
const MONTH_LETTERS = "JanFebMarAprMayJunJulAugSepOctNovDec";

/** `2026-11-26` as `Nov 26`; anything else is returned unchanged. */
export function dayWords(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  const at = m === null ? 0 : Number(m[1]);
  return m === null || at < 1 || at > 12 ? day : `${MONTH_LETTERS.slice(3 * (at - 1), 3 * at)} ${Number(m[2])}`;
}

/** `2026-11-26 14` as `Nov 26 14:00`; anything else is returned unchanged. */
export function hourWords(hour: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2})$/.exec(hour);
  return m === null ? hour : `${dayWords(m[1]!)} ${m[2]}:00`;
}

/** The local hour at `tzOffsetMin` minutes east of UTC for a UTC ms, as `YYYY-MM-DD HH`. */
export const localHourName = (ms: number, tzOffsetMin: number): string => `${localDayName(ms, tzOffsetMin)} ${two(new Date(ms + tzOffsetMin * 60_000).getUTCHours())}`;

export type HistoryMeta = { key: string; at: number; repo: string; tzOffsetMin: number; unread: number; partial: boolean };

/** The tab's rows from a summary built with `usage: true`, over any span. */
export function historyOf(s: Summary, meta: HistoryMeta): HistoryData {
  const days: HistoryData["days"] = [];
  const bucket = s.timeline.bucketMs === HOUR_MS ? "hour" : "day";
  // A session's window starts at its first request, not at a bucket edge; the 24h and 30d windows start on one.
  const start = s.span !== "session" ? s.from : bucket === "hour" ? hourStart(s.from) : localDayStart(s.from, meta.tzOffsetMin);
  // Newest bucket first.
  for (let i = s.timeline.points.length - 1; i >= 0; i--) {
    const p = s.timeline.points[i]!;
    const at = start + i * s.timeline.bucketMs;
    if (p.requests > 0) days.push({ day: bucket === "hour" ? localHourName(at, meta.tzOffsetMin) : localDayName(at, meta.tzOffsetMin), usd: p.usd, tokens: tokenSum(p), requests: p.requests });
  }
  const subTypes: HistoryData["subTypes"] = [];
  for (const [type, models] of Object.entries(s.bySubType)) for (const [model, m] of Object.entries(models)) subTypes.push({ type, model, usd: m.usd, requests: m.requests });
  return {
    key: meta.key,
    at: meta.at,
    repo: meta.repo,
    requests: s.total.requests,
    total: amount(s.total),
    kinds: USAGE_KINDS.map((kind) => ({ kind, ...usageTotals(s, kind) })),
    bucket,
    days,
    models: Object.entries(s.byModel)
      .map(([name, m]) => ({ name, ...amount(m) }))
      .sort((a, b) => byUsd(a, b, a.name, b.name)),
    main: amount(s.main),
    sub: amount(s.sub),
    subTypes: subTypes.sort((a, b) => byUsd(a, b, `${a.type}\0${a.model}`, `${b.type}\0${b.model}`)),
    repos: Object.entries(s.byRepo)
      .map(([name, m]) => ({ name, usd: m.usd }))
      .sort((a, b) => byUsd(a, b, a.name, b.name)),
    sessions: s.topSessions,
    fill: Object.entries(s.toolFill)
      .filter(([, tokens]) => tokens > 0)
      .map(([tool, tokens]) => ({ tool, tokens }))
      .sort((a, b) => b.tokens - a.tokens || (a.tool < b.tool ? -1 : 1)),
    unpriced: s.unpriced,
    unread: meta.unread,
    partial: meta.partial,
  };
}

/** Per-server cost: schema re-read plus tool-result re-read, and calls made. Costliest first. */
export function mcpCosts(schema: Record<string, number>, results: Record<string, number>, calls: Record<string, { calls: number }>): McpCost[] {
  const out: McpCost[] = [];
  for (const server of new Set([...Object.keys(schema), ...Object.keys(results), ...Object.keys(calls)])) {
    const schemaUsd = schema[server] ?? 0;
    const resultUsd = results[server] ?? 0;
    const n = calls[server]?.calls ?? 0;
    if (schemaUsd + resultUsd > 0 || n > 0) out.push({ server, usd: schemaUsd + resultUsd, schemaUsd, resultUsd, calls: n });
  }
  return out.sort((a, b) => b.usd - a.usd || (a.server < b.server ? -1 : 1));
}

// ---- The scan ----

/** The progress-file fields the tab uses. */
export type ScanFile = { phase: string; bytesDone: number; bytesTotal: number; updatedAt: number };
/** A running scan; `percent` is null during the listing phase. */
export type ScanState = { percent: number | null };

/** A progress file untouched for this long is from a scan that has stopped. */
export const SCAN_STALE_MS = 60_000;

/** The running scan's state, or null if idle, done or stale. */
export function scanOf(p: ScanFile | null, now: number): ScanState | null {
  if (p === null || !(now - p.updatedAt <= SCAN_STALE_MS)) return null;
  if (p.phase === "listing") return { percent: null };
  if (p.phase !== "current" && p.phase !== "day" && p.phase !== "month") return null;
  const share = p.bytesTotal > 0 ? p.bytesDone / p.bytesTotal : 0;
  return { percent: Math.max(0, Math.min(99, Math.floor(share * 100))) };
}

/** The progress line shown under the headline. */
export const scanText = (s: ScanState): string => (s.percent === null ? "Listing transcripts; figures will fill in as they are read." : `${s.percent}% of the transcripts indexed so far; these figures are still changing.`);
