import type { Evidence, HintRule } from "../hint.ts";
import { heavyParts, percentText, rereadTotal, usdText } from "./shared.ts";

/** Fraction of all re-reading, and minimum dollars, at which one output source is reported. */
export const OUTPUT_SHARE = 0.3;
export const OUTPUT_MIN_USD = 1;
const COMMANDS_LISTED = 3;

export const commandOutput: HintRule = {
  id: "command-output",
  run: ({ summary }) => {
    const total = rereadTotal(summary);
    const heavy = heavyParts(summary.flow, ["bash"], total, OUTPUT_SHARE, OUTPUT_MIN_USD);
    if (heavy.length === 0) return [];
    const usd = heavy.reduce((n, f) => n + f.rereadUsd, 0);
    const evidence: Evidence[] = [];
    for (const f of heavy.slice(0, COMMANDS_LISTED)) {
      evidence.push({ label: "Command", detail: f.label, kind: "command" }, { label: "Re-read", detail: `${percentText(f.rereadUsd / total)} of ${usdText(total)} re-read`, kind: "text" });
    }
    return [
      {
        rule: "command-output",
        title: "Noisy command output keeps being re-read",
        usd,
        summary: `${heavy.length === 1 ? "One command printed" : `${heavy.length} commands printed`} output that remained in the conversation; later requests re-read it for ${usdText(usd)}, over ${percentText(OUTPUT_SHARE)} of all re-reading.`,
        action: "Cut it down where it is produced: filter with head, tail or grep, use a quiet flag, or redirect the full log into a file and open only the failing lines.",
        evidence,
        short: `command output re-read ${usdText(usd)}`,
      },
    ];
  },
};
