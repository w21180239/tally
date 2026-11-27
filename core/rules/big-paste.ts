import { PASTE_MIN_TOKENS } from "../flow.ts";
import type { Evidence, HintRule } from "../hint.ts";
import { LISTED, titleOf, tokensText, usdText } from "./shared.ts";

/** Smallest re-read cost, in dollars, that makes a pasted prompt worth reporting (the token floor applies too). */
export const PASTE_MIN_USD = 1;

export const bigPaste: HintRule = {
  id: "big-paste",
  run: ({ summary }) => {
    const heavy = summary.pastes.filter((p) => p.tokens >= PASTE_MIN_TOKENS && p.rereadUsd >= PASTE_MIN_USD).sort((a, b) => b.rereadUsd - a.rereadUsd || b.tokens - a.tokens);
    if (heavy.length === 0) return [];
    const usd = heavy.reduce((n, p) => n + p.rereadUsd, 0);
    const evidence: Evidence[] = [];
    for (const p of heavy.slice(0, LISTED)) {
      const title = titleOf(summary, p.sessionId);
      if (title !== undefined && title !== "") evidence.push({ label: "Session", detail: title, kind: "title" });
      evidence.push({ label: "Pasted prompt", detail: `${tokensText(p.tokens)} tokens, ${usdText(p.rereadUsd)} re-read`, kind: "text" });
    }
    return [
      {
        rule: "big-paste",
        title: "Pasted prompts that linger in context",
        usd,
        summary: `${heavy.length} big ${heavy.length === 1 ? "prompt" : "prompts"} sat in the conversation and ${heavy.length === 1 ? "was" : "were"} read again on each following request, ${usdText(usd)} in all.`,
        action: "Put logs, diffs and documents in a file and give Claude its path, or paste only the lines that matter.",
        evidence,
        short: `${heavy.length} big ${heavy.length === 1 ? "paste" : "pastes"} re-read ${usdText(usd)}`,
      },
    ];
  },
};
