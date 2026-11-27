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
        title: "Fast mode drives a big part of the bill",
        usd: saving,
        projected: true,
        summary: `Fast-mode requests account for ${usdText(fast.usd)}, ${percentText(fastShare(i))} of the span, and bill at ${mul}x the normal rate; the same work at the normal rate would cost ${usdText(saving)} less.`,
        action: "Switch /fast off by default and turn it on only when a quicker answer is worth the premium.",
        evidence: [{ label: "Fast requests", detail: `${fast.requests} ${fast.requests === 1 ? "request" : "requests"}, ${usdText(fast.usd)}`, kind: "text" }],
        short: `fast mode ${percentText(fastShare(i))} of spend`,
        metric: { name: "fast share of cost", value: fastShare(i) },
      },
    ];
  },
};
