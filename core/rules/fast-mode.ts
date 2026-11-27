import type { HintInput, HintRule } from "../hint.ts";
import { percentText, usdText } from "./shared.ts";

/** Fast requests are reported above this fraction of spend, and only from this many dollars. */
export const FAST_SHARE = 0.2;
export const FAST_MIN_USD = 1;

const fastShare = (i: HintInput): number => (i.summary.total.usd > 0 ? i.summary.fast.usd / i.summary.total.usd : 0);

export const fastMode: HintRule = {
  id: "fast-mode",
  metric: fastShare,
  run: (i) => {
    const { fast, total } = i.summary;
    const mul = i.prices.fastMul;
    if (total.usd <= 0 || fast.usd < FAST_MIN_USD || fastShare(i) <= FAST_SHARE || mul <= 1) return [];
    // Fast requests bill at `mul` times the normal rate; the normal rate would cost fast / mul.
    const saving = fast.usd - fast.usd / mul;
    return [
      {
        rule: "fast-mode",
        title: "Fast mode premium adds up",
        usd: saving,
        projected: true,
        summary: `${usdText(fast.usd)} (${percentText(fastShare(i))}) of this span's spend went through fast mode. Those requests bill at ${mul}x, so standard speed would have saved ${usdText(saving)}.`,
        action: "Keep /fast off as the default and enable it only for stretches where waiting on a reply costs you more than the premium.",
        evidence: [{ label: "Fast requests", detail: `${usdText(fast.usd)} across ${fast.requests} ${fast.requests === 1 ? "request" : "requests"}`, kind: "text" }],
        short: `fast requests carry ${percentText(fastShare(i))} of spend`,
        metric: { name: "fast share of cost", value: fastShare(i) },
      },
    ];
  },
};
