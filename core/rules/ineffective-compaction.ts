import { EFFECTIVE_SHARE, QUICK_REPEAT } from "../flow.ts";
import type { CompactionEffect } from "../flow.ts";
import type { Evidence, HintRule } from "../hint.ts";
import { durationText, LISTED, percentText, titleOf, tokensText, usdText } from "./shared.ts";

const requestsText = (n: number): string => `${n} ${n === 1 ? "request" : "requests"}`;

function detailOf(e: CompactionEffect): string {
  const after = e.postTokens === null ? "" : `, ${tokensText(e.postTokens)} after${e.preTokens > 0 ? ` (${percentText(e.postTokens / e.preTokens)})` : ""}`;
  const before = e.preTokens > 0 ? `${tokensText(e.preTokens)} tokens before` : "context before unknown";
  return `${before}${after}${e.repeated ? `; compacted again after ${requestsText(e.requests)}` : ""}${e.cold ? `; began after ${durationText(e.idleMs)} idle, past the cache life` : ""}`;
}

// Compactions that did not shrink the context. Compacting itself is never the finding: a compaction that sheds most of a
// large context saves money on every later request. The amount is the cache-read cost of the part of the context left above the
// EFFECTIVE_SHARE line, over the requests until the next compaction (see `CompactionEffect`); it is 0 when only a quick repeat or a cold start flags it.
export const ineffectiveCompaction: HintRule = {
  id: "ineffective-compaction",
  run: ({ summary }) => {
    const stats = summary.compaction;
    if (stats === undefined || stats.ineffective.length === 0) return [];
    const flagged = [...stats.ineffective].sort((a, b) => b.keptUsd - a.keptUsd || a.ts - b.ts || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
    const usd = flagged.reduce((n, e) => n + e.keptUsd, 0);
    const evidence: Evidence[] = [];
    const seen = new Set<string>();
    for (const e of flagged.slice(0, LISTED)) {
      const title = seen.has(e.sessionId) ? undefined : titleOf(summary, e.sessionId);
      seen.add(e.sessionId);
      if (title !== undefined && title !== "") evidence.push({ label: "Session", detail: title, kind: "title" });
      evidence.push({ label: e.trigger === "auto" ? "Automatic compaction" : "Compaction", detail: detailOf(e), kind: "text" });
    }
    const n = flagged.length;
    const cold = flagged.filter((e) => e.cold).length;
    return [
      {
        rule: "ineffective-compaction",
        title: "Compactions that left the context large",
        usd,
        summary: `${n} of ${stats.count} ${stats.count === 1 ? "compaction" : "compactions"} left the context at ${percentText(EFFECTIVE_SHARE)} or more of its size, were followed by another within ${QUICK_REPEAT} requests${cold > 0 ? `, or began after the cache had expired (${cold}), so the whole prefix was read uncached` : ""}. A large recap or preserved tail keeps later requests re-reading most of what the compaction was meant to shed${usd > 0 ? ` (about ${usdText(usd)} of that re-read)` : ""}.`,
        action: "Compact at the task boundary before stepping away, not after, while the cache is still warm and little work in progress needs carrying over. Give /compact short instructions on what to keep so the recap and the preserved tail stay small.",
        evidence,
        short: `${n} ${n === 1 ? "compaction" : "compactions"} left the context large`,
      },
    ];
  },
};
