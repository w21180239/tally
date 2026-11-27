import { PASTE_MIN_TOKENS } from "../flow.ts";
import type { Evidence, HintInput, HintRule } from "../hint.ts";
import { activeDays, LISTED, titleOf, tokensText, usdText } from "./shared.ts";

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
      const title = titleOf(summary, p.sessionId);
      if (title !== undefined && title !== "") evidence.push({ label: "Session", detail: title, kind: "title" });
      evidence.push({ label: "Pasted prompt", detail: `${tokensText(p.tokens)} tokens, ${usdText(p.rereadUsd)} re-read`, kind: "text" });
    }
    return [
      {
        rule: "big-paste",
        title: "Oversized prompts pasted into chat",
        usd,
        summary: `${usdText(usd)} in cache reads went to carrying ${heavy.length} pasted ${heavy.length === 1 ? "prompt" : "prompts"} of ${tokensText(PASTE_MIN_TOKENS)}+ tokens through the rest of the session.`,
        action: "Trim the paste to the lines that matter, or store the whole thing in a file and reference its path in the prompt.",
        evidence,
        short: `${heavy.length} pasted ${heavy.length === 1 ? "prompt" : "prompts"} re-read for ${usdText(usd)}`,
        metric: { name: "paste re-read cost per day", value: pasteRereadPerDay(i) },
      },
    ];
  },
};
