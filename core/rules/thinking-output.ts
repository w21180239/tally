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
        title: "Thinking dominates the output bill",
        usd: thinking,
        summary: `${percentText(thinking / total)} of the ${usdText(total)} spent on output, ${usdText(thinking)}, went to thinking tokens, which bill like any other output.`,
        action: "Use a lower /effort setting day to day and raise it only for the hard problems.",
        evidence: [{ label: "Thinking", detail: `${percentText(thinking / total)} of the ${usdText(total)} output`, kind: "text" }],
        short: `thinking is ${percentText(thinking / total)} of output`,
      },
    ];
  },
};
