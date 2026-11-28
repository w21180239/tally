import { HUGE_RESULT_MIN_TOKENS } from "../flow.ts";
import type { BigResult } from "../flow.ts";
import type { Evidence, HintRule } from "../hint.ts";
import { LISTED, titleOf, tokensText, usdText } from "./shared.ts";

/** Size of one tool result, in tokens, from which it is reported: 5 pastes. The scan lists results from this size on. */
export const HUGE_RESULT_TOKENS = HUGE_RESULT_MIN_TOKENS;
/** Floor on the cache reads the reported results added together, in dollars, and on their part of all spend (strictly over). */
export const HUGE_RESULT_MIN_USD = 1;
export const HUGE_RESULT_MIN_SHARE = 0.0005;

// What names the result: a file path, a command line, or the tool itself.
function what(r: BigResult): Evidence {
  if (r.source === "read") return { label: "File", detail: r.label, kind: "path" };
  if (r.source === "bash") return { label: "Command", detail: r.label, kind: "command" };
  return { label: "Tool", detail: r.label, kind: "text" };
}

export const hugeToolResult: HintRule = {
  id: "huge-tool-result",
  run: ({ summary }) => {
    const huge = summary.hugeResults.filter((r) => r.tokens >= HUGE_RESULT_TOKENS).sort((a, b) => b.rereadUsd - a.rereadUsd || b.tokens - a.tokens);
    if (huge.length === 0) return [];
    const usd = huge.reduce((n, r) => n + r.rereadUsd, 0);
    if (usd < HUGE_RESULT_MIN_USD || summary.total.usd <= 0 || usd / summary.total.usd <= HUGE_RESULT_MIN_SHARE) return [];
    const evidence: Evidence[] = [];
    for (const r of huge.slice(0, LISTED)) {
      const title = titleOf(summary, r.sessionId);
      if (title !== undefined && title !== "") evidence.push({ label: "Session", detail: title, kind: "title" });
      evidence.push(what(r), { label: "Size", detail: `${tokensText(r.tokens)} tokens, ${usdText(r.rereadUsd)} re-read`, kind: "text" });
    }
    const n = huge.length;
    return [
      {
        rule: "huge-tool-result",
        title: "Giant tool results kept in context",
        usd,
        summary: `${n} tool ${n === 1 ? "result" : "results"} of ${tokensText(HUGE_RESULT_TOKENS)}+ tokens each ${n === 1 ? "was" : "were"} carried through the rest of the conversation, which added ${usdText(usd)} in cache reads.`,
        action: "Ask for less at the source · a line range on Read, a narrower search, a filter such as head or jq on command output. Hand a wide exploration to a sub-agent so only its findings come back, add a PreToolUse hook that trims noisy commands, or /rewind to summarize the bulky turn.",
        evidence,
        short: `${n} ${n === 1 ? "result" : "results"} over ${tokensText(HUGE_RESULT_TOKENS)} tokens`,
      },
    ];
  },
};
