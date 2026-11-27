// Figures the rules share: wording for amounts, and the price of keeping a token resident in the window.
import type { FlowItem } from "../flow.ts";
import { resolvePrice } from "../pricing.ts";
import type { PriceTable } from "../pricing.ts";
import type { Summary } from "../summary.ts";
import type { UsageDetail } from "../usage-detail.ts";

export const DEFAULT_WINDOW = 1_000_000;
/** Evidence rows a rule lists per list: the costliest few. */
export const LISTED = 5;

export const usdText = (usd: number): string => `$${usd.toFixed(2)}`;
export const percentText = (share: number): string => `${Math.round(share * 100)}%`;

/** 700000 -> 700k, 1000000 -> 1M, 1250000 -> 1.25M. */
export function tokensText(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${Number((n / 1_000_000).toFixed(2))}M`;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** `3d 5h` from a day up, else `2h 05m`, else `40m`. */
export function durationText(ms: number): string {
  if (ms >= DAY) return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`;
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

export const dayText = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/**
 * Cost of keeping one token resident across all main requests of the span: per model, its main requests times
 * the cache-read rate. Sub-agents carry separate lists and do not count.
 */
export function residentUsdPerToken(s: Summary, prices: PriceTable): number {
  let usd = 0;
  for (const [model, m] of Object.entries(s.byModel)) {
    let sub = 0;
    for (const byModel of Object.values(s.bySubType)) sub += byModel[model]?.requests ?? 0;
    const main = Math.max(0, m.requests - sub);
    const price = resolvePrice(model, prices);
    if (price !== null) usd += (main * price.price.cacheRead) / 1e6;
  }
  return usd;
}

/** Spend of re-reading context parts: the usage figures' cache-read total when there are any, else the listed parts' sum. */
export function rereadTotal(s: Summary): number {
  if (s.usage !== undefined) return Object.values(s.usage.slices).reduce((n, sl) => n + sl.totals.cacheRead.usd, 0);
  return s.flow.reduce((n, f) => n + f.rereadUsd, 0);
}

/** Output spend, and the part of it that went to thinking. */
export function outputSpend(usage: UsageDetail): { total: number; thinking: number } {
  let total = 0;
  let thinking = 0;
  for (const sl of Object.values(usage.slices)) {
    total += sl.totals.output.usd;
    for (const g of sl.output) if (g.key === "thinking") thinking += g.usd;
  }
  return { total, thinking };
}

/** What the given sessions cost, as far as they are among the costliest (the summary keeps the top 20). */
export const sessionsUsd = (s: Summary, ids: string[]): number => s.topSessions.filter((t) => ids.includes(t.sessionId)).reduce((n, t) => n + t.usd, 0);

/** The title of a session among the costliest, if it has one. */
export const titleOf = (s: Summary, sessionId: string): string | undefined => s.topSessions.find((t) => t.sessionId === sessionId)?.title;

const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Flow parts of the given sources whose re-read cost is at least `minUsd` and over `share` of `total`, costliest first. */
export function heavyParts(flow: FlowItem[], sources: readonly FlowItem["source"][], total: number, share: number, minUsd: number): FlowItem[] {
  if (total <= 0) return [];
  return flow.filter((f) => sources.includes(f.source) && f.rereadUsd >= minUsd && f.rereadUsd / total > share).sort((a, b) => b.rereadUsd - a.rereadUsd || text(a.label, b.label));
}
