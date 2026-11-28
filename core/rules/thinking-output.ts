import type { HintInput, HintRule } from "../hint.ts";
import { outputSpend, percentText, usdText } from "./shared.ts";

/** Cutoffs on thinking spend: its portion of output cost, and an absolute dollar floor. */
export const THINKING_SHARE = 0.6;
export const THINKING_MIN_USD = 1;

// Thinking cost over output cost. Base: output spend.
const thinkingShare = ({ summary }: HintInput): number => {
  if (summary.usage === undefined) return 0;
  const { total, thinking } = outputSpend(summary.usage);
  return total > 0 ? thinking / total : 0;
};

/** Efforts the advice may move down from: medium is the floor it never goes below. */
const ABOVE_FLOOR = new Set(["high", "xhigh", "max"]);

// The effort most requests in the span ran at; undefined when the transcripts record none.
const usualEffort = ({ summary }: HintInput): string | undefined => {
  let best: string | undefined;
  let most = 0;
  for (const [effort, m] of Object.entries(summary.byEffort ?? {})) {
    if (m.requests > most) [best, most] = [effort, m.requests];
  }
  return best;
};

export const thinkingOutput: HintRule = {
  id: "thinking-output",
  metric: thinkingShare,
  run: (i) => {
    const { summary } = i;
    if (summary.usage === undefined) return [];
    // The only advice is a lower /effort; at medium or below there is none to give. The spend stays on the Usage tab.
    const effort = usualEffort(i);
    if (effort !== undefined && !ABOVE_FLOOR.has(effort)) return [];
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
        metric: { name: "thinking share of output cost", value: thinkingShare(i) },
      },
    ];
  },
};
