import { PASTE_MIN_TOKENS } from "../flow.ts";
import type { Evidence, HintInput, HintRule } from "../hint.ts";
import { activeDays, LISTED, sessionEvidence, tokensText, usdText } from "./shared.ts";

/** Dollar floor on a paste's re-read cost; the token floor from flow.ts applies as well. */
export const PASTE_MIN_USD = 1;

const heavyPastes = ({ summary }: HintInput) => summary.pastes.filter((p) => p.tokens >= PASTE_MIN_TOKENS && p.rereadUsd >= PASTE_MIN_USD).sort((a, b) => b.rereadUsd - a.rereadUsd || b.tokens - a.tokens);

// Re-read cost of the oversized pastes, per active day. Base: active days.
const pasteRereadPerDay = (i: HintInput): number => heavyPastes(i).reduce((n, p) => n + p.rereadUsd, 0) / activeDays(i.summary);

export const bigPaste: HintRule = {
  id: "big-paste",
  metric: pasteRereadPerDay,
  run: (i) => {
    const { summary } = i;
    const heavy = heavyPastes(i);
    if (heavy.length === 0) return [];
    const usd = heavy.reduce((n, p) => n + p.rereadUsd, 0);
    const evidence: Evidence[] = [];
    for (const p of heavy.slice(0, LISTED)) {
      evidence.push(...sessionEvidence(summary, p.sessionId));
      evidence.push({ label: "Pasted prompt", detail: `${tokensText(p.tokens)} tokens, ${usdText(p.rereadUsd)} re-read`, kind: "text" });
    }
    return [
      {
        rule: "big-paste",
        title: "Oversized prompts pasted into chat",
        usd,
        summary: `${usdText(usd)} in cache reads went to carrying ${heavy.length} pasted ${heavy.length === 1 ? "prompt" : "prompts"} of ${tokensText(PASTE_MIN_TOKENS)}+ tokens through the rest of the session.`,
        action: "Reference it as a file · save the text and use @path in the prompt, or pipe it in. Otherwise paste only the lines that matter, and /clear or /rewind once the paste is no longer needed.",
        evidence,
        short: `${heavy.length} pasted ${heavy.length === 1 ? "prompt" : "prompts"} re-read for ${usdText(usd)}`,
        metric: { name: "paste re-read cost per day", value: pasteRereadPerDay(i) },
      },
    ];
  },
};
