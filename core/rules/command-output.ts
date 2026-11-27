import type { Evidence, HintRule } from "../hint.ts";
import { heavyParts, percentText, rereadTotal, usdText } from "./shared.ts";

/** Share of re-read spend, and dollar floor, that an output source must clear to be reported. */
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
        title: `Bash output: over ${percentText(OUTPUT_SHARE)} of re-read spend`,
        usd,
        summary: `Bash results from ${heavy.length === 1 ? "one command" : `${heavy.length} commands`} account for ${usdText(usd)} of cache-read spend, over ${percentText(OUTPUT_SHARE)} of all cache-read spend.`,
        action: "Redirect the full output to a scratch file and open just the failing part, or limit it up front with a quiet flag or `| head`.",
        evidence,
        short: `shell output re-read: ${usdText(usd)}`,
      },
    ];
  },
};
