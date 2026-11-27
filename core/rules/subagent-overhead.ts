import type { Evidence, HintRule } from "../hint.ts";
import { SMALL_RUN_OUTPUT_TOKENS } from "../summary.ts";
import { LISTED, percentText, usdText } from "./shared.ts";

/** Fraction of all sub-agent runs the small ones must exceed, and the floor on their startup context cost in dollars. */
export const SMALL_SHARE_MIN = 0.5;
export const STARTUP_MIN_USD = 1;

export const subagentOverhead: HintRule = {
  id: "subagent-overhead",
  run: ({ summary }) => {
    const { runs, small, smallStartupUsd, byType } = summary.subagentRuns;
    if (runs === 0 || small / runs <= SMALL_SHARE_MIN || smallStartupUsd < STARTUP_MIN_USD) return [];
    const evidence: Evidence[] = Object.entries(byType)
      .filter(([, t]) => t.small > 0)
      .sort((a, b) => b[1].startupUsd - a[1].startupUsd || (a[0] < b[0] ? -1 : 1))
      .slice(0, LISTED)
      .map(([type, t]) => ({ label: "Agent type", detail: `${type}: ${t.small} of ${t.runs} runs under ${SMALL_RUN_OUTPUT_TOKENS} tokens, ${usdText(t.startupUsd)} startup`, kind: "text" }));
    return [
      {
        rule: "subagent-overhead",
        title: "Sub-agents started for tiny jobs",
        usd: smallStartupUsd,
        summary: `${small} of ${runs} sub-agent runs (${percentText(small / runs)}) produced fewer than ${SMALL_RUN_OUTPUT_TOKENS} output tokens in all, and loading their starting context cost ${usdText(smallStartupUsd)} before any of that work began.`,
        action: "Do quick lookups in the main thread, and hand a sub-agent a job big enough to earn a fresh context; fold several small questions into one agent call instead of starting one per question.",
        evidence,
        short: `${small} of ${runs} sub-agent runs were tiny`,
      },
    ];
  },
};
