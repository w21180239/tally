import type { HintInput, HintRule } from "../hint.ts";
import { dayText, durationText, LISTED, tokensText, usdText } from "./shared.ts";

/** Combined rewrite cost, in dollars, below which nothing is reported. */
export const REBUILD_MIN_USD = 1;

const rebuildUsd = (i: HintInput): number => i.summary.cacheRebuilds.reduce((n, r) => n + r.usd, 0);

// Rewrite cost relative to total spend, so spans of any length compare. A per-active-hour figure would need hours, which a 30-day summary does not count, so the share stands in.
const rebuildShare = (i: HintInput): number => (i.summary.total.usd > 0 ? rebuildUsd(i) / i.summary.total.usd : 0);

export const cacheRebuilt: HintRule = {
  id: "cache-rebuilt",
  metric: rebuildShare,
  run: (i) => {
    const rebuilds = i.summary.cacheRebuilds;
    const usd = rebuildUsd(i);
    if (rebuilds.length === 0 || usd < REBUILD_MIN_USD) return [];
    const tokens = rebuilds.reduce((n, r) => n + r.tokens, 0);
    const worst = [...rebuilds].sort((a, b) => b.usd - a.usd || a.ts - b.ts).slice(0, LISTED);
    return [
      {
        rule: "cache-rebuilt",
        title: "Cache expired while idle",
        usd,
        summary: `${usdText(usd)} was spent writing ${tokensText(tokens)} tokens back into the cache, across ${rebuilds.length} ${rebuilds.length === 1 ? "request" : "requests"} that arrived after a gap which outlived the cache.`,
        action: "Before stepping away from finished work, run /clear so the next task starts small; mid-task, come back inside the cache lifetime (1 hour at the longest setting).",
        evidence: worst.map((r) => ({ label: "Rebuild", detail: `${dayText(r.ts)}: ${tokensText(r.tokens)} tokens written after ${durationText(r.gapMs)} idle (${usdText(r.usd)})`, kind: "text" as const })),
        short: `${rebuilds.length} cache ${rebuilds.length === 1 ? "rewrite" : "rewrites"} after idle time`,
        metric: { name: "rebuild share of cost", value: rebuildShare(i) },
      },
    ];
  },
};
