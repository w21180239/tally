import type { HintRule } from "../hint.ts";
import { outputSpend, percentText, usdText } from "./shared.ts";

/** Thinking is reported above this fraction of output spend, and only from this many dollars. */
export const THINKING_SHARE = 0.6;
export const THINKING_MIN_USD = 1;

export const thinkingOutput: HintRule = {
  id: "thinking-output",
  run: ({ summary }) => {
    if (summary.usage === undefined) return [];
    const { total, thinking } = outputSpend(summary.usage);
    if (total <= 0 || thinking < THINKING_MIN_USD || thinking / total <= THINKING_SHARE) return [];
    return [
      {
        rule: "thinking-output",
        title: "Reasoning tokens dominate output spend",
        usd: thinking,
        summary: `Output cost ${usdText(total)} in this span, and thinking tokens (priced as output) took ${usdText(thinking)}, or ${percentText(thinking / total)}, of it.`,
        action: "Run at a reduced /effort by default and raise it only for hard problems.",
        evidence: [{ label: "Thinking", detail: `${usdText(thinking)} of ${usdText(total)} output`, kind: "text" }],
        short: `${percentText(thinking / total)} of output spend is thinking`,
      },
    ];
  },
};
