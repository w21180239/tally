import type { HintInput, HintRule } from "../hint.ts";
import { dayText, durationText, LISTED, tokensText, usdText } from "./shared.ts";

/** Smallest combined rebuild cost, in dollars, that is reported. */
export const REBUILD_MIN_USD = 1;

const rebuildUsd = (i: HintInput): number => i.summary.cacheRebuilds.reduce((n, r) => n + r.usd, 0);

// Rebuild cost as a fraction of total spend: stays comparable between spans of different length.
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
        title: "Cache rewritten after idle gaps",
        usd,
        summary: `${rebuilds.length} ${rebuilds.length === 1 ? "request" : "requests"} rewrote ${tokensText(tokens)} tokens because the cache had lapsed, ${usdText(usd)} in all.`,
        action: "Stay in a session while its work is live, or close it with /clear rather than returning after a long gap; a 1-hour cache outlasts most breaks.",
        evidence: worst.map((r) => ({ label: "Rebuild", detail: `${dayText(r.ts)}, ${tokensText(r.tokens)} tokens after ${durationText(r.gapMs)} idle, ${usdText(r.usd)}`, kind: "text" as const })),
        short: `${rebuilds.length} cache ${rebuilds.length === 1 ? "rebuild" : "rebuilds"}`,
        metric: { name: "rebuild share of cost", value: rebuildShare(i) },
      },
    ];
  },
};
