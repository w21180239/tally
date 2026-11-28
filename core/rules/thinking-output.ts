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

/**
 * Efforts the advice may move down from. Current models think at every level and default to medium, so a high thinking share is
 * their normal shape: xhigh and max report on the share alone, high only on a stronger case, and a span with no recorded effort stays quiet.
 */
const ALWAYS = new Set(["xhigh", "max"]);
export const HIGH_THINKING_SHARE = 0.7;
export const HIGH_THINKING_MIN_USD = 3;

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
    const high = effort === "high";
    // Transcripts that record no effort keep the plain share test: nothing says the level was low.
    if (effort !== undefined && !high && !ALWAYS.has(effort)) return [];
    const { total, thinking } = outputSpend(summary.usage);
    if (total <= 0 || thinking < (high ? HIGH_THINKING_MIN_USD : THINKING_MIN_USD) || thinking / total <= (high ? HIGH_THINKING_SHARE : THINKING_SHARE)) return [];
    return [
      {
        rule: "thinking-output",
        title: `Thinking tokens above ${percentText(THINKING_SHARE)} of output cost`,
        usd: thinking,
        summary: `${usdText(thinking)} of this span's ${usdText(total)} output cost (${percentText(thinking / total)}) went to thinking tokens, which bill at the output rate.${effort === undefined ? "" : ` Most requests ran at ${effort} effort.`}`,
        action: `Lower the default effort · ${effort === undefined ? "run /effort" : `run /effort ${high ? "medium" : "high"}`}. Thinking cannot be switched off on current models, so effort is the lever; raise it per task for hard debugging.`,
        evidence: [
          { label: "Thinking", detail: `${usdText(thinking)} of ${usdText(total)} output`, kind: "text" },
          ...(effort === undefined ? [] : [{ label: "Usual effort", detail: effort, kind: "text" as const }]),
        ],
        short: `thinking: ${percentText(thinking / total)} of output cost`,
        metric: { name: "thinking share of output cost", value: thinkingShare(i) },
      },
    ];
  },
};
