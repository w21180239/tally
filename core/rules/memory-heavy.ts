import { nearestSnapshot } from "../breakdown.ts";
import type { Evidence, HintRule } from "../hint.ts";
import { percentText, proxyNote, residentUsdPerToken, tokensText, usdText } from "./shared.ts";

/** Floor on what the memory files cost to carry, in dollars, and on the part of all spend that is (strictly over). */
export const MEMORY_MIN_USD = 1;
export const MEMORY_MIN_SHARE = 0.05;
/** Files listed in the evidence, costliest first. */
const FILES_LISTED = 4;

export const memoryHeavy: HintRule = {
  id: "memory-heavy",
  run: ({ summary, snaps, prices, live }) => {
    const near = nearestSnapshot(snaps, summary.to, live?.sessionId);
    const perToken = residentUsdPerToken(summary, prices);
    if (near === null || perToken <= 0 || summary.total.usd <= 0) return [];
    const files = Object.entries(near.snap.memory)
      .filter(([, tokens]) => tokens > 0)
      .map(([path, tokens]) => ({ path, tokens, usd: tokens * perToken }))
      .sort((a, b) => b.usd - a.usd || (a.path < b.path ? -1 : 1));
    const tokens = files.reduce((n, f) => n + f.tokens, 0);
    const usd = tokens * perToken;
    const share = usd / summary.total.usd;
    if (usd < MEMORY_MIN_USD || share <= MEMORY_MIN_SHARE) return [];
    const evidence: Evidence[] = [];
    for (const f of files.slice(0, FILES_LISTED)) {
      evidence.push({ label: "Memory file", detail: f.path, kind: "path" }, { label: "Per request", detail: `${tokensText(f.tokens)} tokens, ${usdText(f.usd)} over the span`, kind: "text" });
    }
    evidence.push(...proxyNote(near));
    return [
      {
        rule: "memory-heavy",
        title: "Memory files weigh on every request",
        usd,
        summary: `Memory files add ${tokensText(tokens)} tokens to each request. Carried through ${summary.main.requests} requests of the main thread they ran to ${usdText(usd)} at cache-read rates, which is ${percentText(share)} of what the span spent. Long files also lower how closely Claude follows them.`,
        action: "Trim CLAUDE.md toward 200 lines · move rules for one area into .claude/rules/ files with a paths: header and multi-step procedures into skills, which load only when needed. An @import does not shrink the load. Delete notes that have gone stale; /context shows what loads.",
        evidence,
        short: `memory files cost ${usdText(usd)}`,
      },
    ];
  },
};
