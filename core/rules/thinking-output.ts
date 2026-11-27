import type { HintRule } from "../hint.ts";
import { outputSpend, percentText, usdText } from "./shared.ts";

/** Cutoffs on thinking spend: its portion of output cost, and an absolute dollar floor. */
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
        title: `Thinking tokens above ${percentText(THINKING_SHARE)} of output cost`,
        usd: thinking,
        summary: `${usdText(thinking)} of this span's ${usdText(total)} output cost (${percentText(thinking / total)}) went to thinking tokens, which bill at the output rate.`,
        action: "Thinking length scales with /effort; moving the default down one level cuts this line directly, and /effort high stays available per task.",
        evidence: [{ label: "Thinking", detail: `${usdText(thinking)} of ${usdText(total)} output`, kind: "text" }],
        short: `thinking: ${percentText(thinking / total)} of output cost`,
      },
    ];
  },
};
